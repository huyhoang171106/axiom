// src/core/types.ts - Core types and interfaces for Axiom

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  timestamp?: number;
  isError?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  output: string;
  error?: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type ExecutionState =
  | 'idle'
  | 'analyzing'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'recovering'
  | 'waiting_user'
  | 'completed'
  | 'failed';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  totalTokens: number;
  costEstimate: number;
}

export interface VerificationEvidence {
  type: 'typecheck' | 'unit_test' | 'build' | 'lint' | 'syntax' | 'custom';
  name: string;
  command?: string;
  status: 'passed' | 'failed' | 'skipped';
  output?: string;
  durationMs?: number;
}

export interface VerificationReport {
  overallStatus: 'verified' | 'partially_verified' | 'failed' | 'not_run';
  evidences: VerificationEvidence[];
  summary: string;
  timestamp: number;
}

export interface FailureDiagnosis {
  category:
    | 'stale_anchor'
    | 'file_not_found'
    | 'syntax_error'
    | 'type_error'
    | 'test_failed'
    | 'command_error'
    | 'timeout'
    | 'permission_denied'
    | 'rate_limit'
    | 'unknown';
  severity: 'low' | 'medium' | 'high' | 'fatal';
  message: string;
  suggestedAction: 're_read' | 'rollback' | 'adjust_anchor' | 'retry_diff' | 'escalate_model' | 'ask_user';
  details?: Record<string, unknown>;
}

export interface ModelTierConfig {
  fast: string;      // e.g. gemini-2.5-flash / haiku / gpt-4o-mini
  standard: string;  // e.g. claude-3-5-sonnet / gpt-4o
  reasoning: string; // e.g. claude-3-7-sonnet / o3-mini / deepseek-r1
}

export type LLMProviderType =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'openrouter'
  | 'ollama'
  | 'antigravity'
  | 'deepseek'
  | 'groq'
  | 'commandcode'
  | 'command-code'
  | (string & {});

export interface CustomModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface ProviderCredentials {
  apiKey?: string;
  baseUrl?: string;
  organizationId?: string;
  models?: CustomModelInfo[];
  source?: 'env' | 'config' | 'omp' | 'subscription';
  projectId?: string;
  headers?: Record<string, string>;
}

export interface SubscriptionInfo {
  tier: 'community' | 'pro' | 'team' | 'enterprise';
  key?: string;
  active: boolean;
  expiresAt?: string;
  tokenQuota?: number;
  tokensUsed?: number;
}
export type DecisionRouterBackend =
  | '@cf/cloudflare/clef'
  | '@cf/cloudflare/clef-flash'
  | 'typesafe-jev'
  | 'openrouter-jev'
  | 'liquid-d1'
  | 'local-calibrated';

export interface DecisionRouterConfig {
  backend: DecisionRouterBackend;
  cloudflare?: {
    accountId?: string;
    authToken?: string;
  };
  typesafe?: {
    apiKey?: string;
  };
  openrouter?: {
    apiKey?: string;
  };
  liquid?: {
    apiKey?: string;
  };
}

/** Per-task model slots, same idea as OMP's modelRoles. Selector: `[provider/]model` (a leading segment naming a configured provider picks that provider). */
export type ModelRole = 'default' | 'smol' | 'slow' | 'task';
export const MODEL_ROLES: readonly ModelRole[] = ['default', 'smol', 'slow', 'task'];

export interface AxiomConfig {
  activeProvider: LLMProviderType;
  defaultModel?: string;
  /** default: main loop; smol: cheap/fast work (classification, low-complexity turns); slow: hard problems and escalation; task: sub-agents. Unset roles fall back to the normal routing. */
  modelRoles?: Partial<Record<ModelRole, string>>;
  providers: Partial<Record<LLMProviderType, ProviderCredentials>>;
  subscription?: SubscriptionInfo;
  budgetLimitDollars?: number;
  autoVerify: boolean;
  mode: 'adaptive' | 'precise' | 'economical';
  workspaceRoot: string;
  decisionRouter?: DecisionRouterConfig;
}
export interface AgentStepEvent {
  step: number;
  state: ExecutionState;
  thought?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  tokenUsage?: TokenUsage;
}

export type TaskIntent = 'bugfix' | 'refactor' | 'feature' | 'investigation' | 'test' | 'chore' | 'conversation';
export type TaskComplexity = 'low' | 'medium' | 'high' | 'extreme';

export interface Milestone {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  acceptanceCriteria: string[];
  filesExpected?: string[];
}

export interface TaskPlan {
  intent: TaskIntent;
  complexity: TaskComplexity;
  summary: string;
  acceptanceCriteria: string[];
  estimatedCostDollars: number;
  milestones: Milestone[];
  chosenModelTier: 'fast' | 'standard' | 'reasoning';
  isAmbiguous?: boolean;
  ambiguityReason?: string;
  /** The task is expected to modify workspace files (drives the 'no edits yet' nudge). */
  needsEdit?: boolean;
}

export interface SessionState {
  id: string;
  createdAt: number;
  updatedAt: number;
  taskPrompt?: string;
  workspaceRoot?: string;
  plan?: TaskPlan;
  messages: Message[];
  totalCostDollars: number;
  totalTokens: TokenUsage;
  verificationReports: VerificationReport[];
  checkpoints: Checkpoint[];
  activeFiles: string[];
}

export interface Checkpoint {
  id: string;
  timestamp: number;
  step: number;
  description: string;
  gitCommitHash?: string;
  stateSnapshot?: Partial<SessionState>;
  filesSnapshot?: Record<string, string>;
}

export interface ContextBudget {
  maxTokens: number;
  systemTokens: number;
  repoMapTokens: number;
  historyTokens: number;
  reservedForResponse: number;
}

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'export';
  line: number;
  file: string;
}

export interface RepoMapEntry {
  path: string;
  symbols: SymbolInfo[];
  sizeBytes: number;
  lastModified: number;
}
