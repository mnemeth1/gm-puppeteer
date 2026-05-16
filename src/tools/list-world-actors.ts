import { z } from 'zod';
import {
  listWorldActorsBody,
  type ListWorldActorsResult,
} from '../evaluators/list-world-actors.js';
import { jsonText, type ToolDefinition } from './types.js';

const ListWorldActorsInput = z.object({}).strict();

export const listWorldActorsTool: ToolDefinition<typeof ListWorldActorsInput> = {
  name: 'list_world_actors',
  description:
    "Read-only enumeration of every actor in the current Foundry world's actor " +
    'directory. One row per actor with id, uuid, name, type, level, folderId, and ' +
    'onActiveScene, sorted by name. Use this to discover the actorId you need to ' +
    'pass into get_actor_state, get_actor_inventory, get_creature_details, or any ' +
    'actor-mutation tool. When multiple actors share a name, prefer the one with ' +
    'onActiveScene: true — that is the actor currently in play on the world-active ' +
    'scene (also returned as the top-level activeScene; null when no scene is ' +
    'active). NOT for compendium actors — use search_compendium for those. ' +
    'NOT a stat-block view — use get_actor_state (PCs / NPCs / familiars by id) ' +
    'or get_creature_details (NPCs / hazards / familiars by uuid) for combat- ' +
    'relevant detail. Level is null for actor types that do not carry a ' +
    'meaningful level (e.g. the PF2e Party actor); -1 and 0 are valid PF2e ' +
    'levels and pass through unchanged.',
  inputSchema: ListWorldActorsInput,
  async handler(_input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(listWorldActorsBody)) as ListWorldActorsResult;
    return [jsonText({ activeScene: result.activeScene, actors: result.actors })];
  },
};
