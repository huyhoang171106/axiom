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
import { askCommand } from './ask.js';
import { fixCommand } from './fix.js';
import { featureCommand } from './feature.js';
import { resumeCommand } from './resume.js';
import { memoryCommand } from './memory.js';
import { compactCommand } from './compact.js';
import { costCommand } from './cost.js';
import { modeCommand } from './mode.js';
import { planCommand } from './plan.js';
import { auditCommand } from './audit.js';

defaultCommandRouter.register(helpCommand);
defaultCommandRouter.register(clearCommand);
defaultCommandRouter.register(exitCommand);
defaultCommandRouter.register(triageCommand);
defaultCommandRouter.register(loginCommand);
defaultCommandRouter.register(logoutCommand);
defaultCommandRouter.register(modelCommand);
defaultCommandRouter.register(modelsCommand);
defaultCommandRouter.register(askCommand);
defaultCommandRouter.register(fixCommand);
defaultCommandRouter.register(featureCommand);
defaultCommandRouter.register(resumeCommand);
defaultCommandRouter.register(memoryCommand);
defaultCommandRouter.register(compactCommand);
defaultCommandRouter.register(costCommand);
defaultCommandRouter.register(modeCommand);
defaultCommandRouter.register(planCommand);
defaultCommandRouter.register(auditCommand);

export { defaultCommandRouter };
