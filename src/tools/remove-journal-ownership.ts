import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  removeJournalOwnershipBody,
  type RemoveJournalOwnershipResult,
} from '../evaluators/remove-journal-ownership.js';
import { jsonText, type ToolDefinition } from './types.js';

const RemoveJournalOwnershipInput = z
  .object({
    entryId: z.string().min(1).describe('Id of the journal entry.'),
    pageId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional page id. Omit to clear an ENTRY-level ownership entry; provide to clear ' +
          'a page-level override.',
      ),
    userId: z
      .string()
      .min(1)
      .describe(
        'User id whose explicit ownership entry to clear. Cannot be "default" (use ' +
          'assign_journal_ownership to change a baseline). Orphan-user ids work — useful ' +
          'for cleaning up entries left by deleted users.',
      ),
  })
  .strict();

export const removeJournalOwnershipTool: ToolDefinition<typeof RemoveJournalOwnershipInput> = {
  name: 'remove_journal_ownership',
  description:
    "Clear a user's explicit ownership entry on a journal entry, or on one page within it, " +
    "so the user falls back to the target's `default` level. Entry-level removal makes the " +
    "user inherit the entry's baseline; page-level removal makes the user inherit the " +
    "page's default (typically INHERIT, which itself defers to the entry). Returns the " +
    'previous level and the level the user now falls back to. Cannot remove the "default" ' +
    'key itself — Foundry always carries one; change a baseline with ' +
    'assign_journal_ownership instead. Can clear orphan-user entries (user deleted). ' +
    'Companion to list_journal_ownership and assign_journal_ownership.',
  inputSchema: RemoveJournalOwnershipInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(removeJournalOwnershipBody, {
      entryId: input.entryId,
      pageId: input.pageId,
      userId: input.userId,
    })) as RemoveJournalOwnershipResult;
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
        fellBackTo: result.fellBackTo,
      },
      'remove_journal_ownership',
    );
    return [jsonText(result)];
  },
};
