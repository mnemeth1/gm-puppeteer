import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  createJournalFolderBody,
  type CreateJournalFolderResult,
} from '../evaluators/create-journal-folder.js';
import { jsonText, type ToolDefinition } from './types.js';

const CreateJournalFolderInput = z
  .object({
    name: z
      .string()
      .min(1)
      .describe('Display name for the new journal folder, e.g. "Session Notes", "NPCs", "Quests".'),
    parentFolderId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'Optional parent folder id to nest the new folder under. Pass null or omit for a ' +
          'root-level folder. The parent must be of type "JournalEntry"; nesting that would ' +
          "exceed Foundry's folder depth limit is rejected.",
      ),
  })
  .strict();

export const createJournalFolderTool: ToolDefinition<typeof CreateJournalFolderInput> = {
  name: 'create_journal_folder',
  description:
    'Create a new journal-directory folder (a Folder of type "JournalEntry"). Returns the ' +
    'new folder id, name, parentFolderId, and nesting depth. Pass parentFolderId to nest ' +
    'the folder under an existing journal folder; omit it (or pass null) for a root-level ' +
    'folder. Use list_journal_folders to discover parent folder ids. This creates only the ' +
    'folder container — put journal entries in it via create_journal_entry (folderId) or ' +
    'move existing entries with update_journal_entry. NOT for actor / item / scene folders.',
  inputSchema: CreateJournalFolderInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(createJournalFolderBody, {
      name: input.name,
      parentFolderId: input.parentFolderId,
    })) as CreateJournalFolderResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    ctx.log.info(
      { folderId: result.id, name: result.name, parentFolderId: result.parentFolderId },
      'create_journal_folder',
    );
    return [jsonText(result)];
  },
};
