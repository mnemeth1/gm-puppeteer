import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  deleteJournalFolderBody,
  type DeleteJournalFolderResult,
} from '../evaluators/delete-journal-folder.js';
import { jsonText, type ToolDefinition } from './types.js';

const DeleteJournalFolderInput = z
  .object({
    folderId: z.string().min(1).describe('Id of the journal folder to delete.'),
    deleteContents: z
      .boolean()
      .optional()
      .describe(
        'When true, journal entries inside the folder (and its subfolders) are deleted too. ' +
          "Defaults to false — entries are kept and reparented up to the deleted folder's " +
          'parent (or to root).',
      ),
    deleteSubfolders: z
      .boolean()
      .optional()
      .describe(
        'When true, nested subfolders are deleted too. Defaults to false — subfolders are ' +
          "kept and reparented up to the deleted folder's parent (or to root).",
      ),
  })
  .strict();

export const deleteJournalFolderTool: ToolDefinition<typeof DeleteJournalFolderInput> = {
  name: 'delete_journal_folder',
  description:
    'Delete a journal folder. By default (deleteContents and deleteSubfolders both false) ' +
    'only the folder itself is removed — its journal entries and nested subfolders are ' +
    "preserved and reparented up to the deleted folder's parent (or to the root). Set " +
    'deleteContents to also delete the journal entries within, and/or deleteSubfolders to ' +
    'also delete nested folders. Returns the deleted folder id/name plus counts of how many ' +
    'entries and subfolders were destroyed vs reparented. Destructive when the flags are ' +
    'set — deleted journal entries cannot be restored. Only operates on "JournalEntry"-type ' +
    'folders.',
  inputSchema: DeleteJournalFolderInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(deleteJournalFolderBody, {
      folderId: input.folderId,
      deleteContents: input.deleteContents,
      deleteSubfolders: input.deleteSubfolders,
    })) as DeleteJournalFolderResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    ctx.log.info(
      {
        folderId: result.deleted.id,
        name: result.deleted.name,
        deletedContents: result.deletedContents,
        deletedSubfolders: result.deletedSubfolders,
      },
      'delete_journal_folder',
    );
    return [jsonText(result)];
  },
};
