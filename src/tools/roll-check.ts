import { z } from 'zod';
import { ToolError } from '../errors.js';
import { rollCheckBody, type RollCheckResult } from '../evaluators/roll-check.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `roll_check`. Rolls one non-PC actor's real statistic
 * check (perception, a skill, or a save) through the PF2e pipeline.
 * Character actors are rejected — the deputy never rolls for a PC.
 */
const RollCheckInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id of the NPC / hazard / familiar to roll for (as returned by ' +
          'list_world_actors). Character actors are rejected with ACTOR_IS_PC — use ' +
          'request_check to ask a player to roll for their own PC.',
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
      ])
      .describe(
        'Which check to roll: "perception", one of the 16 PF2e skills, or a save ' +
          '("fortitude", "reflex", "will"). The actor must expose that statistic.',
      ),
    dc: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional difficulty class. When supplied, the result carries a degree of ' +
          'success (criticalSuccess / success / failure / criticalFailure). When omitted, ' +
          'the roll posts with no target and outcome is null.',
      ),
    visibility: z
      .enum(['public', 'gm', 'blind'])
      .default('public')
      .describe(
        'Who sees the roll. "public": everyone (default). "gm": whispered to GM users ' +
          'only. "blind": whispered to GMs and hidden from the roller.',
      ),
  })
  .strict();

export const rollCheckTool: ToolDefinition<typeof RollCheckInput> = {
  name: 'roll_check',
  description:
    "Roll a non-PC actor's real statistic check and post the result to Foundry's chat " +
    'log. This runs the actor\'s actual stat-block modifier through the PF2e check ' +
    'pipeline — "Redcap, roll Stealth", "the Goblin rolls a Will save vs DC 18". Supply a ' +
    'DC to get a degree of success. Restrict visibility with "gm" or "blind" for a secret ' +
    'check. Returns {actor:{id, name, type}, checkType, statisticSlug, modifier, dc, ' +
    'total, dieResult, outcome, visibility, chatMessageId}, where outcome is one of ' +
    'criticalSuccess / success / failure / criticalFailure (null when no dc was given). ' +
    'This tool is for NPCs, hazards, and familiars only: character actors are rejected ' +
    'with ACTOR_IS_PC. To ask a player to roll a check for their own character, use ' +
    'request_check. For arbitrary dice not tied to a stat block, use roll_dice.',
  inputSchema: RollCheckInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      checkType: input.checkType,
      dc: input.dc ?? null,
      visibility: input.visibility,
    };
    const result = (await page.evaluate(rollCheckBody, args)) as RollCheckResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        actorId: result.actor.id,
        actorName: result.actor.name,
        checkType: result.checkType,
        dc: result.dc,
        total: result.total,
        outcome: result.outcome,
        visibility: result.visibility,
        chatMessageId: result.chatMessageId,
      },
      'roll_check',
    );
    return [jsonText(result)];
  },
};
