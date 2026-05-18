import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  dnd5eRequestCheckBody,
  type Dnd5eRequestCheckResult,
} from '../evaluators/dnd5e-request-check.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `dnd5e_request_check`. Posts a D&D 5e inline roll-link chat
 * message asking a player to roll a check for their own PC. The prompt
 * is whispered to the actor's owner(s) plus GMs; the player clicks the
 * button to roll. This is the only player-facing roll tool — the deputy
 * never rolls a PC's checks itself.
 *
 * Unlike PF2e there is no DC-visibility toggle: the dnd5e check enricher
 * always renders the DC on the button, so this tool has no showDC flag.
 */
const Dnd5eRequestCheckInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id of the player character to ask for a roll (as returned by ' +
          'list_world_actors). Must be a character actor — NPCs are rejected with ' +
          'ACTOR_NOT_A_PC (use dnd5e_roll_check for NPC checks).',
      ),
    category: z
      .enum(['ability', 'skill', 'save', 'tool'])
      .describe(
        'Which kind of check to request: "ability" (raw ability check), "skill", "save" ' +
          '(saving throw), or "tool" (tool check).',
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
        'Optional difficulty class for the check. When supplied, it is shown on the button ' +
          '("DC 15 Dexterity"); when omitted, the button posts with no DC.',
      ),
  })
  .strict();

export const dnd5eRequestCheckTool: ToolDefinition<typeof Dnd5eRequestCheckInput> = {
  name: 'dnd5e_request_check',
  description:
    'Ask a player to roll a check for their own D&D 5e character. Posts an explicit sentence ' +
    'with a clickable dnd5e roll-link button to Foundry\'s chat — e.g. "Bard, roll DC 15 ' +
    'Dexterity (Acrobatics)." or "Bard, roll DC 15 Dexterity saving throw." — whispered to ' +
    "the actor's owner(s) and GMs. The player clicks the button to roll, keeping agency over " +
    'their own dice; this tool rolls nothing itself. The message speaker is set to the target ' +
    'PC. Supports an optional DC (always visible on the button — D&D 5e has no hide-DC ' +
    'option). Returns {actor:{id, name}, category, key, dc, checkExpression, ' +
    'whisperedTo:[{id, name}], chatMessageId}. ' +
    "Use this for player characters only — it is the deputy's player-facing roll path. " +
    "To roll an NPC's real check yourself use dnd5e_roll_check; for raw dice use roll_dice.",
  inputSchema: Dnd5eRequestCheckInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      category: input.category,
      key: input.key,
      dc: input.dc ?? null,
    };
    const result = (await page.evaluate(dnd5eRequestCheckBody, args)) as Dnd5eRequestCheckResult;
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
        checkExpression: result.checkExpression,
        whisperCount: result.whisperedTo.length,
        chatMessageId: result.chatMessageId,
      },
      'dnd5e_request_check',
    );
    return [jsonText(result)];
  },
};
