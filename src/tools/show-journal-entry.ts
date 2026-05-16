import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  showJournalEntryBody,
  type ShowJournalEntryResult,
} from '../evaluators/show-journal-entry.js';
import { jsonText, type ToolDefinition } from './types.js';

const ShowJournalEntryInput = z
  .object({
    entryId: z.string().min(1).describe('Id of the journal entry to broadcast to players.'),
    force: z
      .boolean()
      .optional()
      .describe(
        'When false (default), the entry pops open for players but each still only sees ' +
          'content they have OBSERVER+ permission on. When true, permission is bypassed and ' +
          'every connected client is shown the entry regardless of ownership — the "reveal ' +
          'this to everyone now" override. Use force sparingly.',
      ),
  })
  .strict();

export const showJournalEntryTool: ToolDefinition<typeof ShowJournalEntryInput> = {
  name: 'show_journal_entry',
  description:
    'Broadcast a journal entry to connected players — pops it open on their screens via ' +
    "Foundry's JournalEntry#show. This is how shared story notes actually reach the table " +
    'mid-session: write the session log with create_journal_page / update_journal_page, ' +
    'then show_journal_entry to surface it. With force=false the broadcast respects ' +
    'per-user ownership (players see only what they may see); with force=true it overrides ' +
    'ownership entirely. Returns how many users were connected at call time (broadcastTo) ' +
    'so you know whether anyone received it. This does NOT change persistent permissions — ' +
    "to make an entry permanently visible in a player's sidebar, use " +
    'assign_journal_ownership. NOT a scene or canvas operation.',
  inputSchema: ShowJournalEntryInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(showJournalEntryBody, {
      entryId: input.entryId,
      force: input.force,
    })) as ShowJournalEntryResult;
    if (!result.ok) {
      const code = result.error.code === 'FOUNDRY_REJECTED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        entryId: result.id,
        name: result.name,
        force: result.force,
        broadcastTo: result.broadcastTo,
      },
      'show_journal_entry',
    );
    return [jsonText(result)];
  },
};
