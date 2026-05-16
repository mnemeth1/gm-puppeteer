import { z } from 'zod';
import {
  listCompendiumPacksBody,
  type ListCompendiumPacksResult,
} from '../evaluators/list-compendium-packs.js';
import { jsonText, type ToolDefinition } from './types.js';

const ListCompendiumPacksInput = z
  .object({
    documentType: z.string().min(1).optional(),
    system: z.string().min(1).optional(),
  })
  .strict();

export const listCompendiumPacksTool: ToolDefinition<typeof ListCompendiumPacksInput> = {
  name: 'list_compendium_packs',
  description:
    'Read-only enumeration of every compendium pack visible to the current ' +
    "Foundry world (system packs, module packs, and world packs). One row " +
    'per pack with id (the collection id, e.g. "pf2e.pathfinder-bestiary"), ' +
    'label, system (the source package — system id for system-shipped packs, ' +
    'module id for module packs, world id for world packs), and documentType ' +
    '("Actor" | "Item" | "JournalEntry" | "RollTable" | "Macro" | "Scene" | ' +
    'other Foundry document types), sorted by label. Optional filters: ' +
    'documentType (exact match) and system (exact match), composed with AND. ' +
    'Use this to discover the pack ids to pass into search_compendium\'s ' +
    'pack / packs filter when the universe of available packs is unknown. ' +
    'NOT for searching pack contents — use search_compendium for that. NOT ' +
    'for PF2e rules text (actions, spells, feats, conditions, traits) — fetch ' +
    'those from https://2e.aonprd.com/ via web-fetch.',
  inputSchema: ListCompendiumPacksInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      ...(input.documentType !== undefined ? { documentType: input.documentType } : {}),
      ...(input.system !== undefined ? { system: input.system } : {}),
    };
    const result = (await page.evaluate(
      listCompendiumPacksBody,
      args,
    )) as ListCompendiumPacksResult;
    return [jsonText({ packs: result.packs })];
  },
};
