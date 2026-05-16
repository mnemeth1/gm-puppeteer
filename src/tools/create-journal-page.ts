import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  createJournalPageBody,
  type CreateJournalPageResult,
} from '../evaluators/create-journal-page.js';
import { jsonText, type ToolDefinition } from './types.js';

const CreateJournalPageInput = z
  .object({
    entryId: z.string().min(1).describe('Id of the parent journal entry the new page is added to.'),
    name: z
      .string()
      .min(1)
      .describe(
        'Page title. In the pages-as-records pattern this is the per-record label — e.g. ' +
          '"Session 14 — Back to Otari", "Quest: Save Otari", "NPC: Wrin Sivinxi".',
      ),
    markdown: z
      .string()
      .optional()
      .describe(
        'Page body as Markdown. Rendered to HTML server-side and stored alongside the ' +
          'Markdown source. Omit to create an empty page you fill in later with ' +
          'update_journal_page. Supports tables, strikethrough, and task lists.',
      ),
    sort: z
      .number()
      .optional()
      .describe(
        'Explicit sort value for page ordering within the entry. Omit to auto-append after ' +
          'all existing pages (Foundry does not auto-increment page sort, so omitting is the ' +
          'normal case).',
      ),
    titleShow: z
      .boolean()
      .optional()
      .describe('Whether the page title shows as a heading in the rendered entry. Default true.'),
    titleLevel: z
      .number()
      .int()
      .min(1)
      .max(6)
      .optional()
      .describe(
        'Heading level (1-6) for the page title in the entry table of contents. Default 1.',
      ),
  })
  .strict();

export const createJournalPageTool: ToolDefinition<typeof CreateJournalPageInput> = {
  name: 'create_journal_page',
  description:
    'Append a new text page to an existing JournalEntry. This is the load-bearing tool ' +
    'for the pages-as-records pattern: one page per session / quest / NPC on a stable ' +
    'parent entry. The body is written as Markdown — supply human-readable Markdown and ' +
    'it is rendered to HTML and stored for display automatically (no need to write HTML). ' +
    'Returns the new pageId and its assigned sort. Page sort auto-appends after existing ' +
    'pages unless you pass an explicit sort. v1 creates TEXT pages only — image/pdf/video ' +
    'pages are out of scope (use foundry_eval if genuinely needed). To add to an existing ' +
    'page rather than create a new one, use update_journal_page with mode append/prepend. ' +
    "New pages inherit the parent entry's ownership; override per-page via " +
    'assign_journal_ownership with a pageId.',
  inputSchema: CreateJournalPageInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(createJournalPageBody, {
      entryId: input.entryId,
      name: input.name,
      markdown: input.markdown,
      sort: input.sort,
      titleShow: input.titleShow,
      titleLevel: input.titleLevel,
    })) as CreateJournalPageResult;
    if (!result.ok) {
      const code = result.error.code === 'FOUNDRY_REJECTED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    ctx.log.info(
      { entryId: result.entryId, pageId: result.pageId, name: result.name, sort: result.sort },
      'create_journal_page',
    );
    return [jsonText(result)];
  },
};
