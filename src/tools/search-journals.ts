import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import { searchJournalsBody, type SearchJournalsResult } from '../evaluators/search-journals.js';
import { jsonText, type ToolDefinition } from './types.js';

const SearchJournalsInput = z
  .object({
    query: z
      .string()
      .min(1)
      .describe(
        'Substring to search for (case-insensitive). Plain text — no regex, no globs. ' +
          'Matches against entry names, page names, and text-page bodies (markdown source ' +
          'preferred; HTML stripped of tags before matching).',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe('Maximum number of hits to return. Default 20. Hard ceiling 500.'),
    snippetLength: z
      .number()
      .int()
      .positive()
      .max(2000)
      .optional()
      .describe(
        'Approximate snippet length in characters around each match. Default 200. ' +
          'Use higher values when you need surrounding context for ambiguous matches.',
      ),
    folder: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional folder id filter — only entries directly in this folder are searched. ' +
          'Get folder ids from list_journals (the folderId field).',
      ),
    entryId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional single-entry restriction — search only this entry's pages. Get from " +
          'list_journals. Useful for "find within this campaign log" workflows.',
      ),
  })
  .strict();

export const searchJournalsTool: ToolDefinition<typeof SearchJournalsInput> = {
  name: 'search_journals',
  description:
    'Full-text search across world journal entries: entry names, page names, and text- ' +
    'page bodies. Returns ranked hits with surrounding-context snippets — entry-name ' +
    'matches first, then page-name matches, then page-content matches; within tier, ' +
    'most-recently-modified entries first. Each hit carries the entryId/pageId pair you ' +
    'need to read the full page via get_journal_page. Use this as the "I do not know ' +
    'where it is" path through the journal navigation hierarchy. Image/PDF/video pages ' +
    'are matched on their name only — body content is not searchable. Optional `folder` ' +
    "and `entryId` filters scope the scan. Foundry's built-in journal search is NOT used " +
    '(it only matches entry names); this scans every entry and page server-side. ' +
    'Performance: ~0.1ms per 6 entries observed; expect well under a second on ' +
    'thousand-entry worlds. NOT for compendium content (use pf2e_search_compendium) and NOT ' +
    'for PF2e rules text (use https://2e.aonprd.com/ via web-fetch).',
  inputSchema: SearchJournalsInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(searchJournalsBody, {
      query: input.query,
      limit: input.limit,
      snippetLength: input.snippetLength,
      folder: input.folder,
      entryId: input.entryId,
    })) as SearchJournalsResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    return [jsonText(result)];
  },
};
