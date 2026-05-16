import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  assignActorOwnershipBody,
  type AssignActorOwnershipResult,
} from '../evaluators/assign-actor-ownership.js';
import { jsonText, type ToolDefinition } from './types.js';

const AssignActorOwnershipInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (as returned by list_world_actors). Pass the bare id, not a UUID.',
      ),
    userId: z
      .string()
      .min(1)
      .describe(
        'User id (as returned by list_users), OR the literal string "default" to set the ' +
          "actor's baseline ownership level (applied to any user without an explicit entry).",
      ),
    level: z
      .enum(['NONE', 'LIMITED', 'OBSERVER', 'OWNER'])
      .describe(
        'Ownership level to assign. NONE = no access. LIMITED = name + portrait only ' +
          '(useful for hand-out NPCs). OBSERVER = read full sheet, no edits, no roll-as. ' +
          'OWNER = full control, can roll as the actor. Maps to Foundry numeric levels 0-3.',
      ),
  })
  .strict();

export const assignActorOwnershipTool: ToolDefinition<typeof AssignActorOwnershipInput> = {
  name: 'assign_actor_ownership',
  description:
    "Grant or change a user's permission on an actor. Sets one entry in `actor.ownership` " +
    'either for a specific user id or for the special "default" sentinel (the baseline level ' +
    'applied to users without an explicit entry). The existing entry is replaced if present, ' +
    'or created if missing — returns `operation: "created"` vs `"updated"` and the previous ' +
    'level for audit. Other ownership entries on the actor are left unchanged. Companion to ' +
    'list_users (discover user ids), list_actor_ownership (inspect current state), and ' +
    'remove_actor_ownership (clear an explicit entry so the user falls back to default). ' +
    'GMs and Assistant GMs are unaffected by document ownership — they always have full ' +
    'access regardless of what this tool sets. NOT for token-level visibility, scene ' +
    'permissions, journal/item ownership, or user-account management; those use different ' +
    'documents or different surfaces (the Foundry setup UI).',
  inputSchema: AssignActorOwnershipInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(assignActorOwnershipBody, {
      actorId: input.actorId,
      userId: input.userId,
      level: input.level,
    })) as AssignActorOwnershipResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        actorId: result.actor.id,
        userId: result.userId,
        userName: result.userName,
        previousLevel: result.previousLevel,
        newLevel: result.newLevel,
        operation: result.operation,
      },
      'assign_actor_ownership',
    );
    return [jsonText(result)];
  },
};
