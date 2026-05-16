import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  getChatMessagesBody,
  type GetChatMessagesResult,
} from '../evaluators/get-chat-messages.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `get_chat_messages`. Read-only window onto Foundry's chat
 * log, with PF2e check and damage cards parsed into structured form.
 * This tool does not post — use `post_chat_message` to write — and does
 * not roll — use `roll_dice` / `roll_check` / `request_check`.
 */
const GetChatMessagesInput = z
  .object({
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .default(20)
      .describe(
        'How many of the most recent messages in the selected window to return ' +
          '(newest-biased). Default 20, max 200. The response also reports totalInLog ' +
          'so you can tell when there is more history than was returned.',
      ),
    sinceMessageId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional chat message id. When set, only messages created AFTER this one are ' +
          'considered (exclusive, forward) — record the last id you saw and pass it back ' +
          'to page forward through a combat round. An id no longer in the log is rejected ' +
          'with SINCE_MESSAGE_NOT_FOUND. Still capped by limit.',
      ),
  })
  .strict();

export const getChatMessagesTool: ToolDefinition<typeof GetChatMessagesInput> = {
  name: 'get_chat_messages',
  description:
    "Read a window of Foundry's chat log — what actually happened at the table: " +
    'narration, NPC dialogue, dice rolls, and PF2e check / damage cards. Returns the ' +
    'newest `limit` messages (default 20), oldest-first so a round reads top to bottom; ' +
    'pass `sinceMessageId` to page forward from the last message you saw. Each message ' +
    'carries {id, author, speaker, timestamp, contentHtml, flavorHtml, text (HTML- ' +
    'stripped), isRoll, rollTotal, whisper, blind, style, card}. `card` is always ' +
    'present: {kind:"check", checkType, dc, outcome, domains, rollTotal} for a PF2e ' +
    'check, {kind:"damage", total, instances:[{damageType, category, total, ' +
    'persistent}], outcome, targetActorId} for a damage roll, or {kind:"other", ' +
    'pf2eCardType} for everything else. Read as the GM, so whispered messages are ' +
    'included. This tool is read-only: to post a message use post_chat_message; to ' +
    'roll dice use roll_dice, roll_check, or request_check.',
  inputSchema: GetChatMessagesInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      limit: input.limit,
      sinceMessageId: input.sinceMessageId ?? null,
    };
    const result = (await page.evaluate(
      getChatMessagesBody,
      args,
    )) as GetChatMessagesResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        returnedCount: result.returnedCount,
        totalInLog: result.totalInLog,
        sinceMessageId: args.sinceMessageId,
      },
      'get_chat_messages',
    );
    return [jsonText(result)];
  },
};
