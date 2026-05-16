import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  removeActorOwnershipBody,
  type RemoveActorOwnershipResult,
} from '../evaluators/remove-actor-ownership.js';
import { jsonText, type ToolDefinition } from './types.js';

const RemoveActorOwnershipInput = z
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
        'User id whose explicit ownership entry on the actor should be deleted. The user falls ' +
          'back to the actor\'s `default` level after removal. Orphan user ids (entries whose ' +
          'user has been deleted from the world) are accepted — use this to clean up after a ' +
          'user removal. The literal string "default" is rejected; use assign_actor_ownership ' +
          'to change the baseline.',
      ),
  })
  .strict();

export const removeActorOwnershipTool: ToolDefinition<typeof RemoveActorOwnershipInput> = {
  name: 'remove_actor_ownership',
  description:
    "Delete a user's explicit ownership entry on an actor so they fall back to the " +
    "actor's `default` baseline level. Returns the previous level and the level the user " +
    'now sees (the actor\'s `default`). Companion to assign_actor_ownership: assign creates ' +
    'or updates an explicit entry; remove deletes it. To clear the baseline itself, call ' +
    'assign_actor_ownership with userId: "default" and level: "NONE" — that case is rejected ' +
    "here because Foundry always carries a `default` entry. Returns INVALID_INPUT/NOT_PRESENT " +
    "if the user has no explicit entry to remove (already falls back to default). Also useful " +
    'for cleaning up orphan entries surfaced by list_actor_ownership (entries whose user has ' +
    'been deleted from the world directory).',
  inputSchema: RemoveActorOwnershipInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(removeActorOwnershipBody, {
      actorId: input.actorId,
      userId: input.userId,
    })) as RemoveActorOwnershipResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        actorId: result.actor.id,
        userId: result.userId,
        userName: result.userName,
        previousLevel: result.previousLevel,
        fellBackTo: result.fellBackTo,
      },
      'remove_actor_ownership',
    );
    return [jsonText(result)];
  },
};
