import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  getChatMessagesBody,
  type GetChatMessagesResult,
} from '../evaluators/get-chat-messages.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `get_chat_messages`. Read-only window onto Foundry's chat
 * log, with each message's check / damage / activation card parsed into
 * a structured `card` shape per game system (PF2e and D&D 5e). This tool
 * does not post — use `post_chat_message` to write — and does not roll —
 * use `roll_dice` / `*_roll_check` / `*_request_check`.
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
    'narration, NPC dialogue, dice rolls, and check / damage / activation cards. ' +
    'Returns the newest `limit` messages (default 20), oldest-first so a round reads ' +
    'top to bottom; pass `sinceMessageId` to page forward from the last message you ' +
    'saw. Each message carries {id, author, speaker, timestamp, contentHtml, ' +
    'flavorHtml, text (HTML-stripped), isRoll, rollTotal, whisper, blind, style, ' +
    'card}. `card` is always present and structured per game system: branch on ' +
    '`card.system` ("pf2e" | "dnd5e" | null) first, then `card.kind`. ' +
    'PF2e — {kind:"check", checkType, dc, outcome, domains, rollTotal}, ' +
    '{kind:"damage", total, instances:[{damageType, category, total, persistent}], ' +
    'outcome, targetActorId}, or {kind:"other", rawCardType}. ' +
    'D&D 5e — {kind:"item-card", activityType, itemType, itemName, targets} for a ' +
    'roll-less usage/activation card; {kind:"attack", rollTotal, naturalD20, ' +
    'targetAc, outcome, targets}; {kind:"damage", total, damageTypes, isCritical}; ' +
    '{kind:"save", ability, rollTotal, dc, outcome}; {kind:"check", checkType ' +
    '(ability|skill|tool), key, rollTotal, dc, outcome}; {kind:"initiative", ' +
    'rollTotal}; or {kind:"other", rawCardType}. D&D 5e never bakes an outcome into ' +
    'a message — attack hit/crit and save pass/fail are derived, and 5e roll cards ' +
    'carry originatingMessageId linking back to their usage card. Read as the GM, so ' +
    'whispered messages are included. This tool is read-only: to post a message use ' +
    'post_chat_message; to roll dice use roll_dice, pf2e_roll_check / ' +
    'dnd5e_roll_check, or pf2e_request_check / dnd5e_request_check.',
  inputSchema: GetChatMessagesInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      limit: input.limit,
      sinceMessageId: input.sinceMessageId ?? null,
    };
    const result = (await page.evaluate(getChatMessagesBody, args)) as GetChatMessagesResult;
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
