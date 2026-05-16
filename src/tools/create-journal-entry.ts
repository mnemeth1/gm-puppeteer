import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  createJournalEntryBody,
  type CreateJournalEntryResult,
} from '../evaluators/create-journal-entry.js';
import { jsonText, type ToolDefinition } from './types.js';

const CreateJournalEntryInput = z
  .object({
    name: z
      .string()
      .min(1)
      .describe(
        'Display name for the new journal entry. Common pages-as-records patterns: ' +
          '"Campaign Story", "Quests", "NPCs", "Locations", "Loot log".',
      ),
    folderId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'Optional folder id to place the entry under. Pass null or omit for root-level. ' +
          'Folder must be of type "JournalEntry" — actor / item / scene folders are rejected.',
      ),
    defaultOwnership: z
      .enum(['NONE', 'LIMITED', 'OBSERVER', 'OWNER'])
      .optional()
      .describe(
        'Optional baseline ownership level applied to all users (overridable per-user via ' +
          'assign_journal_ownership). Common pattern: set to OBSERVER on a "Campaign Story" ' +
          'entry so every player sees it in their sidebar without needing per-user grants. ' +
          "Defaults to Foundry's NONE (only GM can see).",
      ),
  })
  .strict();

export const createJournalEntryTool: ToolDefinition<typeof CreateJournalEntryInput> = {
  name: 'create_journal_entry',
  description:
    'Create a new world JournalEntry. Returns the new entry id, name, folderId, and ' +
    'defaultOwnership level. The entry is created with NO pages — add pages via separate ' +
    'create_journal_page calls (compose-primitives principle: this tool is just for the ' +
    'permission/visibility container; pages carry the content). Recommended pages-as- ' +
    'records pattern: create one stable entry per long-running topic ("Campaign Story", ' +
    '"Quests", "NPCs") and add one page per session/quest/NPC over time, rather than a ' +
    'new entry per note. To grant per-user visibility after creation, call ' +
    'assign_journal_ownership with userId="default" (baseline) or a specific userId. ' +
    'NOT for compendium imports — compendium journals stay in their packs. NOT for the ' +
    'campaign-dashboard or structured-quest abstractions; quest tracking lives in plain ' +
    'pages on a "Quests" entry.',
  inputSchema: CreateJournalEntryInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(createJournalEntryBody, {
      name: input.name,
      folderId: input.folderId,
      defaultOwnership: input.defaultOwnership,
    })) as CreateJournalEntryResult;
    if (!result.ok) {
      const code = result.error.code === 'FOUNDRY_REJECTED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        entryId: result.id,
        name: result.name,
        folderId: result.folderId,
        defaultOwnership: result.defaultOwnership,
      },
      'create_journal_entry',
    );
    return [jsonText(result)];
  },
};
