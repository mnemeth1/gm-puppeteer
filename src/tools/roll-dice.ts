import { z } from 'zod';
import { ToolError } from '../errors.js';
import { rollDiceBody, type RollDiceResult } from '../evaluators/roll-dice.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `roll_dice`. Evaluates one raw dice formula and posts it.
 * This is the GM's own roll — arbitrary dice, optionally spoken by an
 * NPC, optionally private. It does not run any PF2e check pipeline:
 * for an NPC's real stat-block check use `roll_check`, and to ask a
 * player to roll use `request_check`.
 */
const RollDiceInput = z
  .object({
    formula: z
      .string()
      .min(1)
      .describe(
        'A Foundry dice formula, e.g. "1d30", "2d6+3", "4d6kh3", "1d20-1". Standard ' +
          'Foundry/PF2e roll syntax. Evaluated by the core Roll class; an unparseable ' +
          'formula is rejected with FORMULA_INVALID.',
      ),
    flavor: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional label shown above the roll in the chat card, e.g. "Wandering monster ' +
          'check" or "Redcap sizes up the party".',
      ),
    speakerActorId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional world actor id. When set, the roll is attributed to that actor — the ' +
          'chat card reads "as <actor name>". Typically an NPC. When omitted, the roll is ' +
          'attributed to the logged-in GM user. This is a world actor id (as returned by ' +
          'list_world_actors), not a token id.',
      ),
    visibility: z
      .enum(['public', 'gm', 'blind'])
      .default('public')
      .describe(
        'Who sees the roll. "public": everyone (default). "gm": whispered to all GM ' +
          'users only — a private GM roll. "blind": whispered to GMs and hidden from the ' +
          'roller (the GM sees the result, nobody else knows it happened).',
      ),
  })
  .strict();

export const rollDiceTool: ToolDefinition<typeof RollDiceInput> = {
  name: 'roll_dice',
  description:
    "Evaluate a raw dice formula and post the result to Foundry's chat log. This is the " +
    'GM\'s own roll — "roll a private GM d30", "roll d10 as the Redcap" — not a PF2e ' +
    'check. The formula goes through the core Foundry Roll class, so any standard roll ' +
    'syntax works (1d30, 2d6+3, 4d6kh3). Optionally attribute the roll to an NPC actor ' +
    'via speakerActorId (the card reads "as <NPC>"), and optionally restrict visibility: ' +
    '"public" (everyone), "gm" (whispered to GMs only), "blind" (GMs see it, the roller ' +
    'does not). Returns {formula, total, result, terms:[{faces, results}], flavor, ' +
    'visibility, speaker:{actorId, alias}, chatMessageId}. ' +
    "For an NPC's real stat-block check (the Redcap's actual Stealth modifier, degree of " +
    'success) use roll_check. To ask a player to roll a check for their own character, ' +
    "use request_check — never roll a PC's checks for them with this tool.",
  inputSchema: RollDiceInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      formula: input.formula,
      flavor: input.flavor ?? null,
      speakerActorId: input.speakerActorId ?? null,
      visibility: input.visibility,
    };
    const result = (await page.evaluate(rollDiceBody, args)) as RollDiceResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        formula: result.formula,
        total: result.total,
        visibility: result.visibility,
        speakerActorId: result.speaker.actorId,
        chatMessageId: result.chatMessageId,
      },
      'roll_dice',
    );
    return [jsonText(result)];
  },
};
