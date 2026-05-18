import { z } from 'zod';
import { ToolError } from '../errors.js';
import { dnd5eRollCheckBody, type Dnd5eRollCheckResult } from '../evaluators/dnd5e-roll-check.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `dnd5e_roll_check`. Rolls one non-PC D&D 5e actor's real
 * ability / skill / save / tool check through the dnd5e roll pipeline.
 * Character actors are rejected — the deputy never rolls for a PC.
 *
 * The check is a (category, key) pair: `category` selects the roll
 * method, `key` names the stat. `key` is loosely validated as a
 * non-empty string at the MCP edge; the evaluator validates it live
 * against CONFIG.DND5E and rejects unknown keys with CHECK_KEY_INVALID —
 * the key space is dnd5e-system-owned and shifts between releases.
 */
const Dnd5eRollCheckInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id of the NPC to roll for (as returned by list_world_actors). Character ' +
          'actors are rejected with ACTOR_IS_PC — use dnd5e_request_check to ask a player to ' +
          'roll for their own PC. vehicle / group actors are rejected with ' +
          'ACTOR_TYPE_UNSUPPORTED.',
      ),
    category: z
      .enum(['ability', 'skill', 'save', 'tool'])
      .describe(
        'Which kind of check: "ability" (raw ability check), "skill", "save" (saving throw), ' +
          'or "tool" (tool check). A save and an ability check share an ability key, so the ' +
          'category disambiguates them.',
      ),
    key: z
      .string()
      .min(1)
      .describe(
        'The stat to roll. For "ability" and "save": a 3-letter ability key — str, dex, con, ' +
          'int, wis, cha. For "skill": a 3-letter skill key — acr, ani, arc, ath, dec, his, ' +
          'ins, itm, inv, med, nat, prc, prf, per, rel, slt, ste, sur. For "tool": a tool key ' +
          '(e.g. thief, alchemist, herb). Validated live against CONFIG.DND5E.',
      ),
    dc: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional difficulty class. When supplied, the result carries an outcome ' +
          '(success / failure). When omitted, the roll posts with no target and outcome is null.',
      ),
    visibility: z
      .enum(['public', 'gm', 'blind'])
      .default('public')
      .describe(
        'Who sees the roll. "public": everyone (default). "gm": whispered to GM users only. ' +
          '"blind": whispered to GMs and hidden from the roller.',
      ),
  })
  .strict();

export const dnd5eRollCheckTool: ToolDefinition<typeof Dnd5eRollCheckInput> = {
  name: 'dnd5e_roll_check',
  description:
    "Roll a non-PC D&D 5e actor's real ability, skill, saving-throw, or tool check and post " +
    "the result to Foundry's chat log. This runs the actor's actual stat-block modifier " +
    'through the dnd5e roll pipeline — "the Archmage rolls Arcana", "the Goblin makes a DC 13 ' +
    'Dexterity save". Supply a DC to get an outcome. Restrict visibility with "gm" or "blind" ' +
    'for a secret check. Returns {actor:{id, name, type}, category, key, dc, total, dieResult, ' +
    'modifier, outcome, visibility, chatMessageId}, where outcome is "success" or "failure" ' +
    '(null when no dc was given) — D&D 5e has no critical success/failure on a check. ' +
    'This tool is for NPCs only: character actors are rejected with ACTOR_IS_PC, and ' +
    'vehicle / group actors with ACTOR_TYPE_UNSUPPORTED. To ask a player to roll a check for ' +
    'their own character, use dnd5e_request_check. For arbitrary dice not tied to a stat ' +
    'block, use roll_dice.',
  inputSchema: Dnd5eRollCheckInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      category: input.category,
      key: input.key,
      dc: input.dc ?? null,
      visibility: input.visibility,
    };
    const result = (await page.evaluate(dnd5eRollCheckBody, args)) as Dnd5eRollCheckResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        actorId: result.actor.id,
        actorName: result.actor.name,
        category: result.category,
        key: result.key,
        dc: result.dc,
        total: result.total,
        outcome: result.outcome,
        visibility: result.visibility,
        chatMessageId: result.chatMessageId,
      },
      'dnd5e_roll_check',
    );
    return [jsonText(result)];
  },
};
