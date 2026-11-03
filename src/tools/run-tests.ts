// src/tools/run-tests.ts - `run_tests`: run pytest in the sandbox with the network off

import { BaseTool } from './base-tool.js';

export class RunTestsTool extends BaseTool {
  readonly name = 'run_tests';
  readonly description = 'Run the pytest suite of the workspace (or one target such as tests/test_x.py::test_y) and report passed and failed tests.';
  readonly parameters = {
    type: 'object',
    properties: { target: { type: 'string', description: 'Optional pytest node id or path; omit for the whole suite' } },
  };

  async execute(): Promise<string> {
    // TODO(C3): runPytest from src/core/verifier.ts.
    return 'Error: run_tests is not implemented yet (C3); use run_command with "python3 -m pytest -q".';
  }
}
