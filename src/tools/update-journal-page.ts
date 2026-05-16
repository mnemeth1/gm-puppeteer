import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  updateJournalPageBody,
  type UpdateJournalPageResult,
} from '../evaluators/update-journal-page.js';
import { jsonText, type ToolDefinition } from './types.js';

const UpdateJournalPageInput = z
  .object({
    entryId: z.string().min(1).describe('Id of the parent journal entry.'),
    pageId: z.string().min(1).describe('Id of the page to update (from get_journal_entry).'),
    name: z.string().min(1).optional().describe('New page title. Omit to leave unchanged.'),
    sort: z
      .number()
      .optional()
      .describe('New sort value to reorder the page within its entry. Omit to leave unchanged.'),
    titleShow: z
      .boolean()
      .optional()
      .describe('Whether the page title renders as a heading. Omit to leave unchanged.'),
    titleLevel: z
      .number()
      .int()
      .min(1)
      .max(6)
      .optional()
      .describe('Heading level (1-6) for the page title. Omit to leave unchanged.'),
    markdown: z
      .string()
      .optional()
      .describe(
        'Markdown body content. Combined with `mode`. Omit to leave the body unchanged ' +
          '(e.g. when only renaming).',
      ),
    mode: z
      .enum(['replace', 'append', 'prepend'])
      .optional()
      .describe(
        'How `markdown` is applied. replace (default): overwrite the whole body. append: ' +
          'add after existing content (e.g. a new session-log entry). prepend: add before. ' +
          'append/prepend require a Markdown-format page — they are rejected on HTML pages ' +
          '(read-then-replace is the workaround). Ignored when `markdown` is omitted.',
      ),
    separator: z
      .string()
      .optional()
      .describe(
        'Joiner inserted between old and new content for append/prepend modes. Default is ' +
          'a blank line ("\\n\\n").',
      ),
  })
  .strict();

export const updateJournalPageTool: ToolDefinition<typeof UpdateJournalPageInput> = {
  name: 'update_journal_page',
  description:
    "Edit an existing text page's body, title, or ordering. The body is Markdown; the " +
    '`mode` parameter controls how it is applied — replace (overwrite), append (add a new ' +
    'block at the end, the normal mode for an ongoing session log), or prepend (add at the ' +
    'start). append/prepend require a Markdown-format page and are rejected on HTML- ' +
    'format pages with INCOMPATIBLE_FORMAT — for those, read with get_journal_page, ' +
    'convert, and use mode "replace". replace works on any page and converts HTML pages ' +
    'to Markdown. Markdown is rendered to HTML server-side automatically. Returns a ' +
    'changedFields array and the mode applied. Only edits text pages. NOT for renaming ' +
    'the parent entry (use update_journal_entry) and NOT for ownership (use the journal ' +
    'ownership tools).',
  inputSchema: UpdateJournalPageInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(updateJournalPageBody, {
      entryId: input.entryId,
      pageId: input.pageId,
      name: input.name,
      sort: input.sort,
      titleShow: input.titleShow,
      titleLevel: input.titleLevel,
      markdown: input.markdown,
      mode: input.mode,
      separator: input.separator,
    })) as UpdateJournalPageResult;
    if (!result.ok) {
      const code = result.error.code === 'FOUNDRY_REJECTED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        entryId: result.entryId,
        pageId: result.pageId,
        changedFields: result.changedFields,
        mode: result.mode,
      },
      'update_journal_page',
    );
    return [jsonText(result)];
  },
};
