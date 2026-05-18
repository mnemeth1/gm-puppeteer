import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import { getJournalPageBody, type GetJournalPageResult } from '../evaluators/get-journal-page.js';
import { jsonText, type ToolDefinition } from './types.js';

const GetJournalPageInput = z
  .object({
    entryId: z
      .string()
      .min(1)
      .describe(
        'World journal entry id (the parent entry containing the page). Get this from ' +
          'list_journals or get_journal_entry.',
      ),
    pageId: z
      .string()
      .min(1)
      .describe(
        'Page id within the entry. Get this from get_journal_entry (the `pages[].id` field).',
      ),
  })
  .strict();

export const getJournalPageTool: ToolDefinition<typeof GetJournalPageInput> = {
  name: 'get_journal_page',
  description:
    'Read-only full-detail view of a single JournalEntryPage. The third step in the ' +
    'journal navigation hierarchy: list_journals → get_journal_entry → get_journal_page. ' +
    'Returns the page metadata (id, name, type, sort, title) plus the type-specific ' +
    'content slot: text pages return `{format, markdown, content}` (markdown is the source ' +
    'for format=2 pages; content is the rendered HTML, which is null on freshly-created ' +
    'markdown pages until the next update); image pages return `{src, caption}`; pdf pages ' +
    'return `{src}`; video pages return the full video config. Raw `ownership` map is ' +
    'included; for a name-resolved view with INHERIT semantics use list_journal_ownership. ' +
    'NOT a search tool — use search_journals to find pages by content keyword.',
  inputSchema: GetJournalPageInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(getJournalPageBody, {
      entryId: input.entryId,
      pageId: input.pageId,
    })) as GetJournalPageResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    return [jsonText(result)];
  },
};
