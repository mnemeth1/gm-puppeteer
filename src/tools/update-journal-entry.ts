import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  updateJournalEntryBody,
  type UpdateJournalEntryResult,
} from '../evaluators/update-journal-entry.js';
import { jsonText, type ToolDefinition } from './types.js';

const UpdateJournalEntryInput = z
  .object({
    entryId: z.string().min(1).describe('Id of the journal entry to update.'),
    name: z
      .string()
      .min(1)
      .optional()
      .describe('New display name. Omit to leave unchanged.'),
    folderId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'New folder id, or null to unparent (move to journal-directory root). Omit to ' +
          'leave unchanged. Folder must be of type "JournalEntry".',
      ),
  })
  .strict();

export const updateJournalEntryTool: ToolDefinition<typeof UpdateJournalEntryInput> = {
  name: 'update_journal_entry',
  description:
    "Modify a JournalEntry's metadata: name and/or folder. At least one of those fields " +
    'must be provided — calls with no changes are rejected. Returns the post-update entry ' +
    'snapshot plus a `changedFields` array for audit. Pass folderId: null to move the entry ' +
    'to the journal directory root. Ownership changes do NOT go through this tool — call ' +
    'assign_journal_ownership / remove_journal_ownership instead. Page content does NOT ' +
    "go through this tool — use update_journal_page. NOT for compendium entries.",
  inputSchema: UpdateJournalEntryInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(updateJournalEntryBody, {
      entryId: input.entryId,
      name: input.name,
      folderId: input.folderId,
    })) as UpdateJournalEntryResult;
    if (!result.ok) {
      const code = result.error.code === 'FOUNDRY_REJECTED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        entryId: result.entry.id,
        changedFields: result.changedFields,
      },
      'update_journal_entry',
    );
    return [jsonText(result)];
  },
};
