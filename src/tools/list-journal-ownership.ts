import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  listJournalOwnershipBody,
  type ListJournalOwnershipResult,
} from '../evaluators/list-journal-ownership.js';
import { jsonText, type ToolDefinition } from './types.js';

const ListJournalOwnershipInput = z
  .object({
    entryId: z.string().min(1).describe('Id of the journal entry to inspect.'),
  })
  .strict();

export const listJournalOwnershipTool: ToolDefinition<typeof ListJournalOwnershipInput> = {
  name: 'list_journal_ownership',
  description:
    "Read-only view of a journal entry's permissions — both entry-level and per-page. " +
    'Returns the entry baseline (`default`) plus one row per user with an explicit ' +
    "entry-level assignment, then a `pages` array giving each page's own ownership " +
    '(`default` + explicit users + a hasOverride flag). Levels are enum strings: INHERIT | ' +
    'NONE | LIMITED | OBSERVER | OWNER (numeric -1..3). INHERIT (-1) is the normal page ' +
    "default — it means the page falls through to the entry's permission. Orphan-user " +
    'entries (user deleted) appear with userName: null and can be cleared via ' +
    'remove_journal_ownership. GMs / Assistant GMs always have full access regardless of ' +
    'these values. Companion to list_users (discover user ids) and the two journal ' +
    'ownership mutation tools.',
  inputSchema: ListJournalOwnershipInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(listJournalOwnershipBody, {
      entryId: input.entryId,
    })) as ListJournalOwnershipResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    return [jsonText(result)];
  },
};
