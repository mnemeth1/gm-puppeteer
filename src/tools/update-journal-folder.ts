import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  updateJournalFolderBody,
  type UpdateJournalFolderResult,
} from '../evaluators/update-journal-folder.js';
import { jsonText, type ToolDefinition } from './types.js';

const UpdateJournalFolderInput = z
  .object({
    folderId: z.string().min(1).describe('Id of the journal folder to update.'),
    name: z.string().min(1).optional().describe('New display name. Omit to leave unchanged.'),
    parentFolderId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'New parent folder id, or null to move the folder to the journal-directory root. ' +
          'Omit to leave the parent unchanged. The parent must be of type "JournalEntry", ' +
          'must not be the folder itself or any of its descendants (cycle), and the resulting ' +
          'nesting must not exceed the folder depth limit.',
      ),
  })
  .strict();

export const updateJournalFolderTool: ToolDefinition<typeof UpdateJournalFolderInput> = {
  name: 'update_journal_folder',
  description:
    "Modify a journal folder's metadata: name (rename) and/or parent (move). At least one " +
    'of those fields must be provided — calls with no changes are rejected. Returns the ' +
    'post-update folder snapshot plus a `changedFields` array for audit. Pass ' +
    'parentFolderId: null to move the folder to the journal-directory root. A folder cannot ' +
    'be moved into itself or any of its own descendants, and a move that would push its ' +
    'deepest subfolder past the folder depth limit is rejected. Only operates on ' +
    '"JournalEntry"-type folders. To move journal *entries* between folders, use ' +
    'update_journal_entry instead.',
  inputSchema: UpdateJournalFolderInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(updateJournalFolderBody, {
      folderId: input.folderId,
      name: input.name,
      parentFolderId: input.parentFolderId,
    })) as UpdateJournalFolderResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    ctx.log.info(
      { folderId: result.folder.id, changedFields: result.changedFields },
      'update_journal_folder',
    );
    return [jsonText(result)];
  },
};
