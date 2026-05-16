import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  assignJournalOwnershipBody,
  type AssignJournalOwnershipResult,
} from '../evaluators/assign-journal-ownership.js';
import { jsonText, type ToolDefinition } from './types.js';

const AssignJournalOwnershipInput = z
  .object({
    entryId: z.string().min(1).describe('Id of the journal entry.'),
    pageId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional page id. Omit to set ENTRY-level ownership; provide to set ownership on ' +
          'one specific page (a page-level override of the entry permission).',
      ),
    userId: z
      .string()
      .min(1)
      .describe(
        'User id (from list_users), OR the literal string "default" to set the baseline ' +
          'level applied to all users without an explicit entry.',
      ),
    level: z
      .enum(['INHERIT', 'NONE', 'LIMITED', 'OBSERVER', 'OWNER'])
      .describe(
        'Ownership level. NONE = no access. LIMITED = title only. OBSERVER = read. OWNER = ' +
          'full edit. INHERIT = fall through to the parent entry permission — valid ONLY for ' +
          'page-level assignments (pass a pageId); rejected for entry-level. Common pattern: ' +
          'assign userId="default", level="OBSERVER" on a "Campaign Story" entry so all ' +
          'players can read it.',
      ),
  })
  .strict();

export const assignJournalOwnershipTool: ToolDefinition<typeof AssignJournalOwnershipInput> = {
  name: 'assign_journal_ownership',
  description:
    "Grant or change a user's permission on a journal entry, or on one page within it. " +
    "Sets a single entry in the target document's ownership map via a surgical update — " +
    'all other ownership entries are left untouched. Omit pageId for entry-level (the ' +
    'common case: make a whole "Campaign Story" entry visible to the party); pass pageId ' +
    'to override one page (e.g. keep a GM-secrets page hidden inside an otherwise-shared ' +
    'entry). Use userId="default" for the baseline level. INHERIT is page-only and means ' +
    '"defer to the entry permission". Returns the previous level and whether the entry was ' +
    'created or updated. GMs / Assistant GMs are unaffected by ownership — they always see ' +
    'everything. Companion to list_users, list_journal_ownership, and ' +
    'remove_journal_ownership. NOT for actor / token / scene permissions.',
  inputSchema: AssignJournalOwnershipInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(assignJournalOwnershipBody, {
      entryId: input.entryId,
      pageId: input.pageId,
      userId: input.userId,
      level: input.level,
    })) as AssignJournalOwnershipResult;
    if (!result.ok) {
      const code = result.error.code === 'FOUNDRY_REJECTED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        entryId: result.entryId,
        pageId: result.pageId,
        scope: result.scope,
        userId: result.userId,
        userName: result.userName,
        previousLevel: result.previousLevel,
        newLevel: result.newLevel,
        operation: result.operation,
      },
      'assign_journal_ownership',
    );
    return [jsonText(result)];
  },
};
