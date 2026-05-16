import { z } from 'zod';
import { ToolError } from '../errors.js';
import { foundryEvalBody, type FoundryEvalResult } from '../evaluators/foundry-eval.js';
import { jsonText, type ToolDefinition } from './types.js';

const FoundryEvalInput = z.object({
  script: z.string().min(1).describe('JavaScript to execute in the headless Foundry client'),
});

export const foundryEvalTool: ToolDefinition<typeof FoundryEvalInput> = {
  name: 'foundry_eval',
  description:
    'Run arbitrary JavaScript inside the headless Foundry GM client and return the JSON-serialized result. ' +
    'Generic escape hatch for operations not yet covered by typed tools.',
  inputSchema: FoundryEvalInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(foundryEvalBody, input.script)) as FoundryEvalResult;
    if (!result.ok) {
      throw new ToolError('EVAL_FAILED', result.error.message, {
        errorName: result.error.name,
        ...(result.error.stack !== undefined ? { stack: result.error.stack } : {}),
      });
    }
    return [jsonText({ value: result.value })];
  },
};
