import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  createActorFromCompendiumBody,
  type CreateActorFromCompendiumResult,
} from '../evaluators/create-actor-from-compendium.js';
import { jsonText, type ToolDefinition } from './types.js';

const CreateActorFromCompendiumInput = z
  .object({
    uuid: z
      .string()
      .min(1)
      .describe(
        'Full compendium document UUID, e.g. "Compendium.pf2e.iconics.Actor.TMDFyqQtryffdHvE". ' +
          'Returned by `search_compendium` under the `uuid` field.',
      ),
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Override the actor name on creation. If set, also overrides the prototype token name so ' +
          'future-spawned tokens display this name. Omit to keep the compendium source name.',
      ),
    actorLink: z
      .boolean()
      .optional()
      .describe(
        'Override the prototype token\'s actorLink. Defaults: type==="character" → true ' +
          '(PCs share HP/state with their sheet), all other types → false (each NPC token has ' +
          'its own HP). Note: the PF2e system enforces actorLink=true for character actors at ' +
          'creation regardless of this value; the returned `actorLink` reflects what was stored.',
      ),
    folder: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Folder document id under the Actors directory. Omit to create at the directory root. ' +
          'Foundry validates the format (16-char alphanumeric) and rejects unknown ids — a bad ' +
          'folder id surfaces as a CREATE_FAILED tool error.',
      ),
  })
  .strict();

export const createActorFromCompendiumTool: ToolDefinition<typeof CreateActorFromCompendiumInput> =
  {
    name: 'create_actor_from_compendium',
    description:
      "Import an Actor from a compendium pack into the world's Actors directory. Resolves the " +
      'compendium document by UUID, copies it via toObject(), applies optional name / actorLink / ' +
      'folder overrides, and creates the world actor via Actor.implementation.create(). Returns ' +
      'the new actorId, name, type, actorLink, prototypeTokenName, prototypeTokenImg, and folder. ' +
      'Does NOT place a token on the active scene, assign ownership, or open the sheet — those ' +
      'are separate operations.',
    inputSchema: CreateActorFromCompendiumInput,
    async handler(input, ctx) {
      const { page } = await ctx.browser.ensureStarted();
      const args = {
        uuid: input.uuid,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.actorLink !== undefined ? { actorLink: input.actorLink } : {}),
        ...(input.folder !== undefined ? { folder: input.folder } : {}),
      };
      const result = (await page.evaluate(
        createActorFromCompendiumBody,
        args,
      )) as CreateActorFromCompendiumResult;
      if (!result.ok) {
        const code = result.error.code === 'CREATE_FAILED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
        throw new ToolError(code, result.error.message, result.error.details);
      }
      return [
        jsonText({
          actorId: result.actorId,
          name: result.name,
          type: result.type,
          actorLink: result.actorLink,
          prototypeTokenName: result.prototypeTokenName,
          prototypeTokenImg: result.prototypeTokenImg,
          folder: result.folder,
        }),
      ];
    },
  };
