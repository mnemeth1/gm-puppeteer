import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  getJournalEntryBody,
  type GetJournalEntryResult,
} from '../evaluators/get-journal-entry.js';
import { jsonText, type ToolDefinition } from './types.js';

const GetJournalEntryInput = z
  .object({
    entryId: z
      .string()
      .min(1)
      .describe(
        'World journal entry id (the value of `entry.id`, as returned by list_journals). ' +
          'NOT a compendium UUID and NOT a `JournalEntry.<id>` UUID — pass the bare id.',
      ),
  })
  .strict();

export const getJournalEntryTool: ToolDefinition<typeof GetJournalEntryInput> = {
  name: 'get_journal_entry',
  description:
    "Read-only table-of-contents view of a single JournalEntry: the entry's metadata " +
    '(id, name, folderId, pageCount) plus one row per page (id, name, type, format, ' +
    'sort, title.show, title.level, hasOwnershipOverride) sorted by sort then name. ' +
    'Page CONTENT is NOT included — call get_journal_page to read full markdown/HTML ' +
    'for a specific page. This is the second step in the journal navigation hierarchy: ' +
    'list_journals (entries) → get_journal_entry (TOC) → get_journal_page (content). ' +
    'Use it to find the pageId you need for get_journal_page or for any page mutation ' +
    'tool. format is HTML=1 or MARKDOWN=2 (CONST.JOURNAL_ENTRY_PAGE_FORMATS); null on ' +
    'non-text page types (image/pdf/video). hasOwnershipOverride flags pages whose ' +
    'permissions diverge from the entry default — inspect with list_journal_ownership.',
  inputSchema: GetJournalEntryInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(getJournalEntryBody, {
      entryId: input.entryId,
    })) as GetJournalEntryResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    return [jsonText(result)];
  },
};
