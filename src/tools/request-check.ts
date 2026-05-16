import { z } from 'zod';
import { ToolError } from '../errors.js';
import { requestCheckBody, type RequestCheckResult } from '../evaluators/request-check.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `request_check`. Posts a PF2e `@Check[...]` inline-button
 * chat message asking a player to roll a check for their own PC. The
 * prompt is whispered to the actor's owner(s) plus GMs; the player
 * clicks the button to roll. This is the only player-facing roll tool —
 * the deputy never rolls a PC's checks itself.
 */
const RequestCheckInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id of the player character to ask for a roll (as returned by ' +
          'list_world_actors). Must be a character actor — NPCs are rejected with ' +
          'ACTOR_NOT_A_PC (use roll_check for NPC checks). When several PCs share the ' +
          "target's name, pick the one with onActiveScene: true in list_world_actors — " +
          'that is the character currently in play.',
      ),
    checkType: z
      .enum([
        'perception',
        'acrobatics',
        'arcana',
        'athletics',
        'crafting',
        'deception',
        'diplomacy',
        'intimidation',
        'medicine',
        'nature',
        'occultism',
        'performance',
        'religion',
        'society',
        'stealth',
        'survival',
        'thievery',
        'fortitude',
        'reflex',
        'will',
        'flat',
      ])
      .describe(
        'Which check to request: "perception", one of the 16 PF2e skills, a save ' +
          '("fortitude", "reflex", "will"), or "flat" for a flat check.',
      ),
    dc: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional difficulty class for the check. When omitted, the button posts with ' +
          'no target DC.',
      ),
    basic: z
      .boolean()
      .optional()
      .describe(
        'Mark a save as a basic save (the "basic Fortitude" / "basic Reflex" pattern). ' +
          'Only valid when checkType is a save — rejected with BASIC_ON_NON_SAVE otherwise.',
      ),
    traits: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Optional PF2e trait slugs to attach to the check (e.g. ["secret"], ' +
          '["incapacitation"]). Affects how PF2e treats the roll.',
      ),
    showDcToPlayers: z
      .boolean()
      .optional()
      .describe(
        'When true, the DC is shown to the player on the button (showDC:all). When false ' +
          'or omitted, the DC is GM-only (showDC:gm) — the default.',
      ),
  })
  .strict();

export const requestCheckTool: ToolDefinition<typeof RequestCheckInput> = {
  name: 'request_check',
  description:
    'Ask a player to roll a check for their own character. Posts an explicit sentence ' +
    'with a clickable PF2e @Check button to Foundry\'s chat — e.g. "Valeros, roll a ' +
    '[Perception] check." or "Valeros, roll a [Will] saving throw." — whispered to the ' +
    "actor's owner(s) and GMs. The player clicks the button to roll, keeping agency over " +
    'their own dice; this tool rolls nothing itself. The message speaker is set to the target ' +
    'PC so the button resolves the roll to that character. Supports an optional DC, the ' +
    'basic-save flag (saves only), trait slugs, and whether the DC is visible to the ' +
    'player (default: GM-only). Returns {actor:{id, name}, checkType, dc, basic, ' +
    'checkExpression, whisperedTo:[{id, name}], chatMessageId}. ' +
    "Use this for player characters only — it is the deputy's player-facing roll path. " +
    "To roll an NPC's real check yourself use roll_check; for raw dice use roll_dice.",
  inputSchema: RequestCheckInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      checkType: input.checkType,
      dc: input.dc ?? null,
      basic: input.basic ?? false,
      traits: input.traits ?? [],
      showDcToPlayers: input.showDcToPlayers ?? false,
    };
    const result = (await page.evaluate(requestCheckBody, args)) as RequestCheckResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        actorId: result.actor.id,
        actorName: result.actor.name,
        checkType: result.checkType,
        dc: result.dc,
        basic: result.basic,
        checkExpression: result.checkExpression,
        whisperCount: result.whisperedTo.length,
        chatMessageId: result.chatMessageId,
      },
      'request_check',
    );
    return [jsonText(result)];
  },
};
