// src/commands/model.ts - `model` command: switch this session's model, set a role in config.json, or list connected models

import { saveConfig } from '../core/config.js';
import { MODEL_ROLES, type ModelRole } from '../core/types.js';
import { loadCatalog } from '../llm/catalog/index.js';
import { refreshDiscovery } from '../llm/discovery.js';
import { resolveModel } from '../llm/model-resolver.js';
import { formatRows, modelRows } from './models.js';
import type { Command } from './types.js';

export const modelCommand: Command = {
  name: 'model',
  summary: 'Pick the model for this session, or set a role',
  usage: '/model [selector] | /model role <role> [selector]',
  async run(args, ctx) {
    const words = args.trim().split(/\s+/).filter(Boolean);
    if (words[0] === 'role') {
      const [, name, ...rest] = words;
      if (!name || !(MODEL_ROLES as readonly string[]).includes(name)) throw new Error(`Usage: /model role <role> <selector>. Roles: ${MODEL_ROLES.join(', ')}`);
      const role = name as ModelRole;
      const selector = rest.join(' ');
      if (!selector) {
        const value = ctx.config.modelRoles?.[role];
        return { kind: 'model-role', data: { role, selector: value ?? null }, text: `@${role} = ${value ?? '(unset, uses its fallback role)'}` };
      }
      const info = resolveModel(selector, loadCatalog(), ctx.config);
      const modelRoles = { ...ctx.config.modelRoles, [role]: selector };
      saveConfig({ modelRoles });
      ctx.config.modelRoles = modelRoles;
      return { kind: 'model-role', data: { role, selector }, text: `@${role} = ${selector} (now ${info.provider}/${info.id})` };
    }
    if (words.length > 0) {
      const info = resolveModel(words.join(' '), loadCatalog(), ctx.config);
      ctx.session.setModel(info);
      // The model used last is the startup choice when no role is set (providers.md section 9).
      saveConfig({ defaultModel: `${info.provider}/${info.id}` });
      return { kind: 'model', data: info, text: `Model: ${info.provider}/${info.id}${info.thinking ? ` (thinking ${info.thinking})` : ''}` };
    }
    // Opening the picker is when discovery may use the network (providers.md section 7.3).
    const { errors } = await refreshDiscovery();
    errors.forEach((e) => ctx.ui.print(e));
    const rows = modelRows(loadCatalog(), (m, available) => available);
    const text = rows.length > 0 ? `${formatRows(rows)}\n\nSwitch with /model <provider/id>.` : 'No connected provider. Type /login to connect one.';
    return { kind: 'model-list', data: rows, text };
  },
};
