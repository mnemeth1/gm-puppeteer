import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  listActorOwnershipBody,
  type ListActorOwnershipResult,
} from '../evaluators/list-actor-ownership.js';
import { jsonText, type ToolDefinition } from './types.js';

const ListActorOwnershipInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (the value of `actor.id`, as returned by list_world_actors). NOT a ' +
          'compendium UUID and NOT an `Actor.<id>` UUID — pass the bare id.',
      ),
  })
  .strict();

export const listActorOwnershipTool: ToolDefinition<typeof ListActorOwnershipInput> = {
  name: 'list_actor_ownership',
  description:
    "Read-only view of an actor's document-ownership permissions. Returns the actor's " +
    'baseline `default` level (applied to any user not otherwise listed) plus one entry per ' +
    'user who has an explicit ownership assignment, joined against the user directory so ' +
    'names are resolved server-side. Levels are returned as enum strings: NONE | LIMITED | ' +
    'OBSERVER | OWNER (numeric 0-3 in Foundry). Orphan-user entries (entries whose user has ' +
    'been deleted from the world) appear with `userName: null` and can be cleaned up via ' +
    'remove_actor_ownership. Companion to list_users (discover user ids) and the two ownership ' +
    'mutation tools. This tool reads `actor.ownership` only — it does NOT report token-level ' +
    'visibility, scene permissions, journal permissions, or item ownership; those use the same ' +
    'mechanism on different documents but are out of scope for this cluster. GMs and Assistant ' +
    'GMs ignore document-level ownership entirely (they can always see everything); this tool ' +
    'still surfaces any explicit entry on their user id for completeness.',
  inputSchema: ListActorOwnershipInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(listActorOwnershipBody, {
      actorId: input.actorId,
    })) as ListActorOwnershipResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    return [jsonText(result)];
  },
};
