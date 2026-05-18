import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  deleteJournalPageBody,
  type DeleteJournalPageResult,
} from '../evaluators/delete-journal-page.js';
import { jsonText, type ToolDefinition } from './types.js';

const DeleteJournalPageInput = z
  .object({
    entryId: z.string().min(1).describe('Id of the parent journal entry.'),
    pageId: z
      .string()
      .min(1)
      .describe('Id of the page to delete (from get_journal_entry). Cannot be undone.'),
  })
  .strict();

export const deleteJournalPageTool: ToolDefinition<typeof DeleteJournalPageInput> = {
  name: 'delete_journal_page',
  description:
    'Delete a single page from a JournalEntry. The parent entry is left intact, even if ' +
    'this was its last page (zero-page entries are valid). Returns the deleted page id, ' +
    "name, and the entry's remaining page count. This is destructive — page content " +
    'cannot be recovered. To delete an entire entry and every page on it, use ' +
    'delete_journal_entry instead.',
  inputSchema: DeleteJournalPageInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(deleteJournalPageBody, {
      entryId: input.entryId,
      pageId: input.pageId,
    })) as DeleteJournalPageResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    ctx.log.info(
      { entryId: result.entryId, pageId: result.pageId, name: result.name },
      'delete_journal_page',
    );
    return [jsonText(result)];
  },
};
