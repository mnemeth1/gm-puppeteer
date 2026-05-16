import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  deleteJournalEntryBody,
  type DeleteJournalEntryResult,
} from '../evaluators/delete-journal-entry.js';
import { jsonText, type ToolDefinition } from './types.js';

const DeleteJournalEntryInput = z
  .object({
    entryId: z
      .string()
      .min(1)
      .describe(
        'Id of the journal entry to delete. Cascading: every embedded page goes with it. ' +
          'Cannot be undone — confirm with the GM before destructive use on user-authored ' +
          'content.',
      ),
  })
  .strict();

export const deleteJournalEntryTool: ToolDefinition<typeof DeleteJournalEntryInput> = {
  name: 'delete_journal_entry',
  description:
    'Delete a JournalEntry and all its embedded pages. Cascading: every page on the entry ' +
    'is removed automatically by Foundry — no separate page-delete is needed. Returns the ' +
    'deleted entry id, name, and page count for audit. This is a destructive operation; ' +
    'pages cannot be restored after the parent entry is deleted. Prefer delete_journal_page ' +
    'when you only need to remove a subset of pages. NOT for compendium entries — those ' +
    'live in their packs and require a separate workflow.',
  inputSchema: DeleteJournalEntryInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(deleteJournalEntryBody, {
      entryId: input.entryId,
    })) as DeleteJournalEntryResult;
    if (!result.ok) {
      const code = result.error.code === 'FOUNDRY_REJECTED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    ctx.log.info(
      { entryId: result.id, name: result.name, deletedPageCount: result.deletedPageCount },
      'delete_journal_entry',
    );
    return [jsonText(result)];
  },
};
