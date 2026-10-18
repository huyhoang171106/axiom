// src/llm/providers/gitlab-duo-agent.ts - `gitlab-duo-agent` wire (GitLab Duo Workflow)
//
// One chat() call is one workflow, start to settle (stateless: the next call replays the whole
// conversation as the goal of a fresh workflow, so there is no socket resume to keep):
//   1. resolve the namespace/project scope — catalog headers or one REST discovery round
//   2. POST /direct_access with the stored token → a short-lived workflow token
//   3. POST /workflows → workflow id
//   4. open the workflow WebSocket and send {startRequest}
//   5. stream checkpoint snapshots (diffed by message key) until the workflow settles: FINISHED/
//      INPUT_REQUIRED → the text answer, an action frame → one tool call, FAILED/STOPPED/approval
//      → ProviderError
//
// Protocol shapes follow the reference GitLab Duo Workflow client (oh-my-pi); approvals, socket
// resume, stalled-workflow retry and step-limit restarts are out of A6 scope.

import crypto from 'node:crypto';
import type { LLMProviderType, Message, ToolCall, ToolDefinition } from '../../core/types.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';
import { ProviderError, readJsonBody, throwHttpError } from '../provider-error.js';
import { wireUsage } from '../wire-usage.js';
import { WsClient } from '../ws-client.js';

const DIRECT_ACCESS_PATH = '/api/v4/ai/duo_workflows/direct_access';
const WORKFLOWS_PATH = '/api/v4/ai/duo_workflows/workflows';
const WS_PATH = '/api/v4/ai/duo_workflows/ws';
const CLIENT_TYPE = 'node-websocket';
const LANGUAGE_SERVER_VERSION = '8.104.0';
const WORKFLOW_DEFINITION = 'ambient';
const INLINE_AGENT = 'omp_agent';
const INLINE_PROMPT_ID = 'omp_inline_prompt';
const INLINE_UI_LOG_EVENTS = [
  'on_agent_reasoning',
  'on_agent_final_answer',
  'on_tool_execution_success',
  'on_tool_execution_failed',
];
const CLIENT_CAPABILITIES = [
  'incremental_streaming',
  'read_file_chunked',
  'shell_command',
  'command_timeout',
  'tool_call_approval',
];
const MCP_TOOL_PREFIX = 'mcp__omp__';
const CHATML_START = '<|im_start|>';
const CHATML_END = '<|im_end|>';

/** Tells the model the goal transcript's markers are a past record, not emittable syntax. */
const CHATML_HISTORY_NOTE =
  'The conversation so far is a plain-text transcript. Markers like <|im_start|>role, <|im_end|>, ' +
  '<ran NAME>{...}</ran> and <ran:result> are a record of turns, tool calls and their results that ' +
  'already happened — not a syntax to emit. Call tools through the normal structured tool-calling ' +
  'channel; never write those markers in your own output.';

interface Scope {
  /** As discovered or configured: a `gid://gitlab/Group/N` id or the numeric group id. */
  rootNamespaceId: string;
  /** Numeric group id, the REST/WebSocket form. */
  restNamespaceId: string;
  /** Numeric project id, used by the WebSocket and the workflow metadata. */
  projectId?: string;
  /** `group/project` path, used by the direct_access/create bodies. */
  projectPath?: string;
}

interface DirectAccess {
  token: string;
  serviceEndpoint: boolean;
  serviceBaseUrl?: string;
  serviceHeaders: Record<string, string>;
}

type CheckpointEntry =
  | { kind: 'text' | 'thinking'; key: string; content: string }
  | { kind: 'boundary' };

interface Checkpoint {
  entries: CheckpointEntry[];
  contextUsage?: { used: number };
}

export class GitlabDuoAgentProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;
  /** Discovery costs two REST round-trips; the scope is per provider instance (and workspace). */
  private scope?: Scope;

  constructor(
    private readonly info: ModelInfo,
    private readonly credential?: string,
  ) {
    super();
    this.name = info.provider;
  }

  async chat({ model, messages, tools, onToken, onThinking, signal }: ChatParams): Promise<ChatResult> {
    if (!this.credential) {
      throw new ProviderError(
        `\`${this.name}\` chưa kết nối. Gõ \`/login ${this.name}\` hoặc đặt \`GITLAB_TOKEN\`.`,
        { provider: this.name, model, code: 'missing_credentials' },
      );
    }
    const base = this.info.baseUrl.replace(/\/+$/, '');
    const scope = (this.scope ??= await this.resolveScope(base, model, signal));
    const { system, goal } = this.buildGoal(messages);
    const direct = await this.requestDirectAccess(base, scope, model, signal);
    const workflowId = await this.createWorkflow(base, scope, model, signal);
    const ws = await this.openSocket(base, scope, model, direct, signal);
    try {
      ws.send(
        JSON.stringify({
          startRequest: this.startRequest(workflowId, model, scope, { goal, system }, tools),
        }),
      );
      return await this.consume(ws, { model, onToken, onThinking, signal });
    } finally {
      ws.close();
    }
  }

  /** Resolves the namespace (and, when discoverable, the project) the workflow runs in. */
  private async resolveScope(base: string, model: string, signal?: AbortSignal): Promise<Scope> {
    const headerRoot = this.info.headers?.['x-gitlab-root-namespace-id'];
    const headerProject = this.info.headers?.['x-gitlab-project-id'];
    const rootNamespaceId = headerRoot ?? (await this.discoverRootNamespace(base, model, signal));
    const restNamespaceId = toRestNamespaceId(rootNamespaceId);

    let projectId: string | undefined;
    let projectPath: string | undefined;
    if (headerProject) {
      // A catalog override may carry the numeric id or the `group/project` path.
      if (/^\d+$/.test(headerProject)) projectId = headerProject;
      else {
        projectPath = headerProject;
        projectId = await this.resolveProjectId(base, headerProject, signal);
      }
    } else {
      const discovered = await this.discoverProject(base, restNamespaceId, signal);
      projectId = discovered?.id;
      projectPath = discovered?.path;
    }
    return { rootNamespaceId, restNamespaceId, projectId, projectPath };
  }

  /** First usable top-level group; the Duo-enabled ones are preferred, as in the reference. */
  private async discoverRootNamespace(base: string, model: string, signal?: AbortSignal): Promise<string> {
    const payload = await this.getJson(
      `${base}/api/v4/groups?top_level_only=true&per_page=100&order_by=name&sort=asc`,
      signal,
    );
    const groups = Array.isArray(payload) ? payload : [];
    const preferred =
      groups.find((g) => rec(g)?.duo_features_enabled === true || rec(g)?.duo_core_features_enabled === true) ??
      groups[0];
    const id = rec(preferred)?.id;
    if (id === undefined) {
      throw new ProviderError(
        `${this.name}: no GitLab top-level group found for this token; the inline ambient flow needs one. ` +
          'Pin it with the catalog header `x-gitlab-root-namespace-id`.',
        { provider: this.name, model, code: 'namespace' },
      );
    }
    return String(id);
  }

  /** The inline ambient flow fails server-side without a project, so discover one in the namespace. */
  private async discoverProject(
    base: string,
    restNamespaceId: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; path: string } | undefined> {
    const query = 'per_page=1&min_access_level=30&order_by=last_activity_at&sort=desc';
    const endpoints = [
      `/api/v4/groups/${encodeURIComponent(restNamespaceId)}/projects?include_subgroups=true&${query}`,
      `/api/v4/projects?membership=true&${query}`,
    ];
    for (const endpoint of endpoints) {
      const payload = await this.getJson(`${base}${endpoint}`, signal);
      const first = rec(Array.isArray(payload) ? payload[0] : undefined);
      const id = first?.id;
      const path = first?.path_with_namespace;
      if (id !== undefined && typeof path === 'string') return { id: String(id), path };
    }
    return undefined;
  }

  private async resolveProjectId(base: string, projectPath: string, signal?: AbortSignal): Promise<string | undefined> {
    const payload = await this.getJson(`${base}/api/v4/projects/${encodeURIComponent(projectPath)}`, signal);
    const id = rec(payload)?.id;
    return id === undefined ? undefined : String(id);
  }

  private async requestDirectAccess(
    base: string,
    scope: Scope,
    model: string,
    signal?: AbortSignal,
  ): Promise<DirectAccess> {
    const project = scope.projectPath ?? scope.projectId;
    const payload = await this.postJson<Record<string, unknown>>(
      `${base}${DIRECT_ACCESS_PATH}`,
      {
        workflow_definition: WORKFLOW_DEFINITION,
        root_namespace_id: toGraphQLNamespaceId(scope.rootNamespaceId),
        ...(project ? { project_id: project } : {}),
      },
      model,
      signal,
    );
    const token =
      str(rec(payload.gitlab_rails)?.token) ??
      str(rec(payload.duo_workflow_service)?.token) ??
      str(payload.duo_workflow_access_token) ??
      str(payload.workflow_token) ??
      str(payload.token) ??
      str(payload.access_token) ??
      str(payload.jwt);
    if (!token) {
      throw new ProviderError(`${this.name}: direct_access returned no workflow token`, {
        provider: this.name,
        model,
        code: 'auth',
      });
    }
    const service = rec(payload.duo_workflow_service);
    const serviceEndpoint = !str(rec(payload.gitlab_rails)?.token) && typeof service?.base_url === 'string';
    return {
      token,
      serviceEndpoint,
      ...(serviceEndpoint ? { serviceBaseUrl: normalizeServiceBaseUrl(String(service!.base_url)) } : {}),
      serviceHeaders: serviceEndpoint ? stringRecord(service?.headers) : {},
    };
  }

  private async createWorkflow(base: string, scope: Scope, model: string, signal?: AbortSignal): Promise<string> {
    const project = scope.projectPath ?? scope.projectId;
    const payload = await this.postJson<Record<string, unknown>>(
      `${base}${WORKFLOWS_PATH}`,
      {
        workflow_definition: WORKFLOW_DEFINITION,
        environment: 'ide',
        allow_agent_to_request_user: false,
        agent_privileges: [6],
        pre_approved_agent_privileges: [6],
        requires_duo_cli_enabled: false,
        ...(project ? { project_id: project } : { namespace_id: scope.restNamespaceId }),
        // The inline flow carries the goal in the startRequest instead.
        goal: '',
      },
      model,
      signal,
    );
    const id = payload.id ?? payload.workflow_id ?? payload.workflowId;
    if (id === undefined) {
      throw new ProviderError(`${this.name}: the workflow create response carries no id`, {
        provider: this.name,
        model,
      });
    }
    return String(id);
  }

  private async openSocket(
    base: string,
    scope: Scope,
    model: string,
    direct: DirectAccess,
    signal?: AbortSignal,
  ): Promise<WsClient> {
    const url = new URL(
      direct.serviceEndpoint && direct.serviceBaseUrl ? '/' : `${base}${WS_PATH}`,
      direct.serviceEndpoint && direct.serviceBaseUrl ? direct.serviceBaseUrl : undefined,
    );
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    if (scope.projectId) url.searchParams.set('project_id', scope.projectId);
    if (scope.restNamespaceId && !direct.serviceEndpoint) url.searchParams.set('namespace_id', scope.restNamespaceId);
    url.searchParams.set('root_namespace_id', scope.restNamespaceId);
    url.searchParams.set('user_selected_model_identifier', model);
    url.searchParams.set('workflow_definition', WORKFLOW_DEFINITION);

    const headers: Record<string, string> = {
      ...direct.serviceHeaders,
      authorization: `Bearer ${direct.token}`,
      'x-gitlab-client-type': CLIENT_TYPE,
      'x-gitlab-language-server-version': LANGUAGE_SERVER_VERSION,
      'user-agent': `unknown/unknown unknown/unknown gitlab-language-server/${LANGUAGE_SERVER_VERSION}`,
      origin: new URL(base).origin,
      ...(scope.projectId ? { 'x-gitlab-project-id': scope.projectId } : {}),
      'x-gitlab-namespace-id': scope.restNamespaceId,
      'x-gitlab-root-namespace-id': scope.restNamespaceId,
    };
    try {
      return await WsClient.connect(url.toString(), headers, signal);
    } catch (err) {
      throw new ProviderError(`${this.name}: the workflow WebSocket failed to open: ${(err as Error).message}`, {
        provider: this.name,
        model,
      });
    }
  }

  private startRequest(
    workflowId: string,
    model: string,
    scope: Scope,
    prompt: { goal: string; system: string },
    tools: ToolDefinition[] | undefined,
  ): Record<string, unknown> {
    const mcpTools = (tools ?? []).map((t) => ({
      name: t.name,
      originalToolName: t.name,
      serverName: 'omp',
      description: t.description || '',
      inputSchema: JSON.stringify(t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {}, required: [] }),
      isApproved: true,
    }));
    return {
      workflowID: workflowId,
      clientVersion: '1.0',
      workflowDefinition: WORKFLOW_DEFINITION,
      goal: prompt.goal,
      workflowMetadata: JSON.stringify({
        environment: 'ide',
        client_type: CLIENT_TYPE,
        ...(scope.projectId ? { projectId: scope.projectId } : {}),
        namespaceId: scope.restNamespaceId,
        rootNamespaceId: scope.restNamespaceId,
        selectedModelIdentifier: model,
      }),
      additional_context: [],
      clientCapabilities: [...CLIENT_CAPABILITIES],
      mcpTools,
      preapproved_tools: mcpTools.map((t) => t.name),
      flowConfigSchemaVersion: 'v1',
      flowConfig: inlineFlowConfig(prompt.system),
    };
  }

  private async consume(
    ws: WsClient,
    ctx: {
      model: string;
      onToken?: (token: string) => void;
      onThinking?: (thought: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<ChatResult> {
    const { model, onToken, onThinking, signal } = ctx;
    let content = '';
    let used: number | undefined;
    const contentByKey = new Map<string, string>();
    const signatures = new Set<string>();
    let turnIndex = 0;

    const usageSoFar = () => wireUsage(this.info, used ?? 0, 0);
    const onAbort = (): void => ws.close();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        const frame = await ws.next();
        if (frame === null) {
          if (signal?.aborted) throw signal.reason ?? new Error('The operation was aborted');
          throw new ProviderError(`${this.name}: the workflow WebSocket closed before the workflow settled`, {
            provider: this.name,
            model,
            partialContent: content,
            usage: usageSoFar(),
          });
        }
        const event = parseEvent(frame);
        if (!event) continue;

        const checkpoint = extractCheckpoint(event);
        if (checkpoint) {
          if (checkpoint.contextUsage) used = checkpoint.contextUsage.used;
          for (const entry of checkpoint.entries) {
            if (entry.kind === 'boundary') {
              turnIndex += 1;
              continue;
            }
            const previous = contentByKey.get(entry.key);
            const hash = crypto.createHash('sha1').update(entry.content).digest('base64url');
            const signature = `${turnIndex}\u0000${entry.kind}\u0000${hash}`;
            const contentOnly = `${turnIndex}\u0000content\u0000${hash}`;
            // A renamed message id across snapshots misses the per-key lookup; the signature
            // suppresses re-emitting text already sent for this turn.
            const duplicate = previous === undefined && (signatures.has(signature) || signatures.has(contentOnly));
            const delta =
              duplicate || (previous !== undefined && !entry.content.startsWith(previous) && previous !== entry.content)
                ? ''
                : previous === undefined
                  ? entry.content
                  : entry.content.slice(previous.length);
            contentByKey.set(entry.key, entry.content);
            signatures.add(signature);
            signatures.add(contentOnly);
            if (!delta) continue;
            if (entry.kind === 'thinking') onThinking?.(delta);
            else {
              content += delta;
              onToken?.(delta);
            }
          }
        }

        const status = statusOf(event);
        if (status === 'PLAN_APPROVAL_REQUIRED' || status === 'TOOL_CALL_APPROVAL_REQUIRED') {
          throw new ProviderError(
            `${this.name}: the workflow requires ${status === 'PLAN_APPROVAL_REQUIRED' ? 'plan' : 'tool-call'} approval, which this wire does not support`,
            { provider: this.name, model, code: 'approval_required', partialContent: content, usage: usageSoFar() },
          );
        }
        if (status === 'FINISHED' || status === 'INPUT_REQUIRED') break;
        if (status === 'FAILED' || status === 'STOPPED') {
          const message = str(event.error) ?? str(event.message) ?? status;
          throw new ProviderError(`${this.name}: the workflow ${status.toLowerCase()}: ${message}`, {
            provider: this.name,
            model,
            code: status === 'STOPPED' ? 'stopped' : undefined,
            partialContent: content,
            usage: usageSoFar(),
          });
        }
        const action = extractAction(event, this.name);
        if (action) {
          return {
            content,
            toolCalls: [action],
            usage: usageSoFar(),
            usageMissing: used === undefined,
          };
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    return {
      content,
      usage: usageSoFar(),
      usageMissing: used === undefined,
    };
  }

  /** The system slot of the flow carries the prompt; the goal carries only the transcript. */
  private buildGoal(messages: readonly Message[]): { system: string; goal: string } {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const turns = messages.filter((m) => m.role !== 'system').map(toReplayMessage).filter(isDefined);
    if (turns.length <= 1) {
      return { system, goal: latestUserText(messages) };
    }
    return {
      system: system ? `${system}\n\n${CHATML_HISTORY_NOTE}` : CHATML_HISTORY_NOTE,
      goal: turns.map(renderChatMlTurn).join('\n'),
    };
  }

  private authHeaders(): Record<string, string> {
    return {
      ...this.info.headers,
      ...(this.credential && !this.info.headers?.authorization && { authorization: `Bearer ${this.credential}` }),
    };
  }

  private async postJson<T>(url: string, body: unknown, model: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) await throwHttpError(response, this.name, model);
    return readJsonBody<T>(response, this.name, model);
  }

  /** Discovery is best-effort: a missing namespace surfaces from direct_access with its own error. */
  private async getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json', ...this.authHeaders() }, signal });
      if (!response.ok) return undefined;
      return (await response.json()) as unknown;
    } catch (err) {
      if (signal?.aborted) throw err;
      return undefined;
    }
  }
}

interface ReplayTurn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  isError?: boolean;
}

function toReplayMessage(m: Message): ReplayTurn | undefined {
  if (m.role === 'tool') return { role: 'tool', content: m.content, isError: m.isError };
  if (m.role === 'assistant') {
    if (!m.content && !m.toolCalls?.length) return undefined;
    return m.toolCalls?.length ? { role: 'assistant', content: m.content, toolCalls: m.toolCalls } : { role: 'assistant', content: m.content };
  }
  return m.content ? { role: 'user', content: m.content } : undefined;
}

function latestUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === 'user') return m.content;
  }
  return '';
}

function renderChatMlTurn(turn: ReplayTurn): string {
  const parts: string[] = [];
  if (turn.role === 'tool') {
    parts.push(`<ran:result${turn.isError ? ' status=error' : ''}>`, turn.content);
  } else {
    if (turn.content) parts.push(turn.content);
    for (const tc of turn.toolCalls ?? []) {
      parts.push(`<ran ${tc.name}>${JSON.stringify(tc.arguments) ?? 'null'}</ran>`);
    }
  }
  return `${CHATML_START}${turn.role}\n${parts.join('\n')}\n${CHATML_END}`;
}

function inlineFlowConfig(systemPrompt: string): Record<string, unknown> {
  return {
    version: 'v1',
    environment: 'ambient',
    flow: { entry_point: INLINE_AGENT },
    components: [
      {
        name: INLINE_AGENT,
        type: 'AgentComponent',
        prompt_id: INLINE_PROMPT_ID,
        toolset: [],
        inputs: [{ from: 'context:goal', as: 'goal' }],
        ui_log_events: [...INLINE_UI_LOG_EVENTS],
      },
    ],
    routers: [{ from: INLINE_AGENT, to: 'end' }],
    prompts: [
      {
        name: INLINE_PROMPT_ID,
        prompt_id: INLINE_PROMPT_ID,
        unit_primitives: ['duo_agent_platform'],
        prompt_template: {
          system: sanitizeFlowPrompt(systemPrompt),
          user: '{{goal}}',
          placeholder: 'history',
        },
      },
    ],
  };
}

/**
 * The service refuses a flow whose prompt its sanitizers would change (4200/4400 "Flow configuration
 * failed security validation"), so apply the same rewrites here: strip HTML comments and encode the
 * few tags the service treats as prompt structure. The reference carries more rules (unicode-folding
 * tag variants, markdown comment markers); this covers the content Axiom prompts realistically carry.
 */
function sanitizeFlowPrompt(prompt: string): string {
  let text = prompt.toWellFormed();
  const tags = /<[ \t\r\n]*(\/?)[ \t\r\n]*(goal|system|truncated_tool_output|truncation_notice)[ \t\r\n]*>/gi;
  for (let pass = 0; pass < text.length + 2; pass += 1) {
    const next = text
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\\+u003c!--|<!--/gi, '&lt;!--')
      .replace(tags, (_m, slash: string, tag: string) => `&lt;${slash}${tag.toLowerCase()}&gt;`);
    if (next === text) return text;
    text = next;
  }
  return text;
}

function parseEvent(frame: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(frame) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function statusOf(event: Record<string, unknown>): string | undefined {
  return (
    str(event.status) ??
    str(rec(event.workflowStatus)?.status) ??
    str(rec(event.newCheckpoint)?.status)
  );
}

function extractCheckpoint(event: Record<string, unknown>): Checkpoint | undefined {
  const action = rec(event.action);
  const checkpoint = rec(action?.newCheckpoint) ?? rec(event.newCheckpoint) ?? rec(event.checkpoint);
  if (!checkpoint) return undefined;
  const contextUsage = extractContextUsage(event, action, checkpoint);
  const directText =
    str(checkpoint.message) ??
    str(checkpoint.text) ??
    str(checkpoint.content) ??
    str(rec(checkpoint.checkpoint)?.message) ??
    str(rec(checkpoint.checkpoint)?.text);
  if (directText) {
    return { entries: [{ kind: 'text', key: 'direct:text', content: directText }], ...(contextUsage ? { contextUsage } : {}) };
  }
  const json = str(checkpoint.checkpoint);
  if (json) {
    const entries = parseCheckpointEntries(json);
    return { entries, ...(contextUsage ? { contextUsage } : {}) };
  }
  return contextUsage ? { entries: [], contextUsage } : undefined;
}

/** GitLab checkpoints are full `ui_chat_log` snapshots: agent text/thinking entries plus turn boundaries. */
function parseCheckpointEntries(json: string): CheckpointEntry[] {
  const parsed = rec(safeJson(json));
  const log = rec(parsed?.channel_values)?.ui_chat_log;  if (!Array.isArray(log)) return [];
  const entries: CheckpointEntry[] = [];
  log.forEach((item, index) => {
    const entry = rec(item);
    const type = str(entry?.message_type);
    if (type === 'agent') {
      const content = str(entry?.content);
      if (!content) return;
      const reasoning = str(entry?.message_sub_type) === 'reasoning';
      const id = str(entry?.message_id);
      entries.push({
        kind: reasoning ? 'thinking' : 'text',
        key: id ? `agent:${id}` : reasoning ? `reasoning:${index}` : `agent:${index}`,
        content,
      });
      return;
    }
    if (type === 'request' || type === 'tool') entries.push({ kind: 'boundary' });
  });
  return entries;
}

/** `agent_context_usage[<agent>] = { total_tokens, max_tokens }` — the only usage this transport reports. */
function extractContextUsage(
  ...sources: (Record<string, unknown> | undefined)[]
): { used: number } | undefined {
  for (const source of sources) {
    const map = rec(source?.agent_context_usage);
    if (!map) continue;
    for (const preferred of ['Chat Agent', 'context_builder']) {
      const usage = readAgentUsage(map[preferred]);
      if (usage) return usage;
    }
    for (const value of Object.values(map)) {
      const usage = readAgentUsage(value);
      if (usage) return usage;
    }
  }
  return undefined;
}

function readAgentUsage(value: unknown): { used: number } | undefined {
  const entry = rec(value);
  const used = num(entry?.total_tokens);
  const window = num(entry?.max_tokens);
  return used !== undefined && window !== undefined && window > 0 ? { used } : undefined;
}

/** One action frame = one tool call; the requestID is what the server expects echoed on resume. */
function extractAction(event: Record<string, unknown>, provider: string): ToolCall | undefined {
  const wrapped = rec(event.action) ?? rec(event.workflowAction) ?? rec(event.toolCall);
  if (wrapped) {
    if (rec(wrapped.newCheckpoint)) return undefined;
    const name = str(wrapped.name) ?? str(wrapped.action) ?? str(wrapped.type) ?? str(event.actionName);
    if (!name) return undefined;
    const requestID =
      str(wrapped.requestID) ?? str(wrapped.requestId) ?? str(wrapped.id) ?? str(event.requestID) ?? str(event.requestId);
    if (!requestID) {
      throw new ProviderError(`GitLab Duo Workflow action "${name}" carries no requestID`, {
        provider,
        code: 'protocol',
      });
    }
    const args = rec(wrapped.args) ?? rec(wrapped.arguments) ?? wrapped;
    return mapAction(name, args, requestID, provider);
  }
  for (const name of ['runMCPTool', 'run_mcp_tool']) {
    const args = rec(event[name]);
    if (!args) continue;
    const requestID = str(event.requestID) ?? str(event.requestId);
    if (!requestID) {
      throw new ProviderError(`GitLab Duo Workflow action "${name}" carries no requestID`, {
        provider,
        code: 'protocol',
      });
    }
    return mapAction(name, args, requestID, provider);
  }
  return undefined;
}

function mapAction(name: string, args: Record<string, unknown>, requestID: string, provider: string): ToolCall {
  if (name !== 'runMCPTool' && name !== 'run_mcp_tool') {
    return { id: requestID, name, arguments: { ...args } };
  }
  const rawName = str(args.toolName) ?? str(args.tool_name) ?? str(args.name) ?? '';
  if (!rawName) {
    throw new ProviderError('GitLab Duo Workflow MCP action carries no tool name', { provider, code: 'protocol' });
  }
  return {
    id: requestID,
    name: rawName.startsWith(MCP_TOOL_PREFIX) ? rawName.slice(MCP_TOOL_PREFIX.length) : rawName,
    arguments: parseMcpArguments(args.args ?? args.arguments),
  };
}

function parseMcpArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value === 'string') {
    const parsed = safeJson(value);
    return rec(parsed) ?? {};
  }
  return rec(value) ?? {};
}

function toGraphQLNamespaceId(id: string): string {
  return /^\d+$/.test(id) ? `gid://gitlab/Group/${id}` : id;
}

function toRestNamespaceId(id: string): string {
  return id.match(/^gid:\/\/gitlab\/(?:Group|Namespace)\/(\d+)$/)?.[1] ?? id;
}

function normalizeServiceBaseUrl(value: string): string {
  const trimmed = value.trim();
  return (/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).replace(/\/+$/, '');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : typeof value === 'number' ? String(value) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  const record = rec(value);
  if (!record) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
