// src/commands/index.ts - Registers every command on the shared router (append-only)

import { defaultCommandRouter } from './router.js';
import { helpCommand } from './help.js';
import { clearCommand } from './clear.js';
import { exitCommand } from './exit.js';
import { triageCommand } from './triage.js';
import { loginCommand } from './login.js';
import { logoutCommand } from './logout.js';
import { modelCommand } from './model.js';
import { modelsCommand } from './models.js';

defaultCommandRouter.register(helpCommand);
defaultCommandRouter.register(clearCommand);
defaultCommandRouter.register(exitCommand);
defaultCommandRouter.register(triageCommand);
defaultCommandRouter.register(loginCommand);
defaultCommandRouter.register(logoutCommand);
defaultCommandRouter.register(modelCommand);
defaultCommandRouter.register(modelsCommand);

export { defaultCommandRouter };
