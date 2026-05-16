import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  postChatMessageBody,
  type PostChatMessageResult,
} from '../evaluators/post-chat-message.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `post_chat_message`. Writes one message to Foundry's chat
 * log — GM narration, NPC dialogue, or a whisper to a player. Speaker
 * and visibility are independent parameters. This is not a roll tool:
 * for dice use `roll_dice` / `roll_check` / `request_check`.
 */
const PostChatMessageInput = z
  .object({
    content: z
      .string()
      .min(1)
      .describe(
        'The message body, as raw HTML, stored verbatim — no Markdown, no escaping, no ' +
          'sanitization. Foundry renders it as-is in the chat card. Newlines are not ' +
          'significant; wrap paragraphs in <p> and use <br> for line breaks. You are ' +
          'responsible for valid markup.',
      ),
    speakerActorId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional world actor id to speak as — the card reads "as <actor name>", ' +
          'typically an NPC. When omitted, the message is spoken by the logged-in GM ' +
          'user. This is a world actor id (as returned by list_world_actors), not a ' +
          'token id.',
      ),
    visibility: z
      .enum(['public', 'gm'])
      .default('public')
      .describe(
        'Who sees the message. "public": everyone (default). "gm": whispered to all GM ' +
          'users only — a private GM note. Cannot be combined with whisperTo (a GM-only ' +
          'message and a player whisper are different audiences); pass one or the other.',
      ),
    whisperTo: z
      .array(z.string().min(1))
      .nonempty()
      .optional()
      .describe(
        'Optional list of player-character world actor ids. When set, the message is ' +
          'whispered privately to the player(s) who own those characters (GMs, who own ' +
          'every actor, are included so the human GM still sees it). When omitted, the ' +
          'message follows `visibility`. Each id must be a character actor with at least ' +
          'one non-GM owner — an NPC or owner-less actor is rejected. Combine freely ' +
          'with speakerActorId: an NPC can whisper a player, or the GM can.',
      ),
  })
  .strict();

export const postChatMessageTool: ToolDefinition<typeof PostChatMessageInput> = {
  name: 'post_chat_message',
  description:
    'Post a message to Foundry\'s chat log — GM narration ("A cold wind moves through ' +
    'the hall."), NPC dialogue ("as the Redcap: \'You\'re late.\'"), a private GM-only ' +
    'note, or a whisper to a player. `content` is raw HTML, stored verbatim (not ' +
    'Markdown). Optionally speak as an NPC via speakerActorId (omit to speak as the ' +
    'GM). Audience is set by visibility ("public" = everyone, the default; "gm" = ' +
    'whispered to GM users only) OR by whisperTo — a list of player-character actor ' +
    'ids, resolved to their owning players — but not both. Speaker and audience are ' +
    'independent, so an NPC can whisper a player just as the GM can. Returns ' +
    '{chatMessageId, speaker:{actorId, alias}, visibility, isWhisper, whisperedTo:' +
    '[{userId, userName, viaActorId}], whisperTargets:[{actorId, actorName}]}. This ' +
    'tool does not roll dice — use roll_dice, roll_check, or request_check for that — ' +
    'and does not read chat; use get_chat_messages to read the log.',
  inputSchema: PostChatMessageInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      content: input.content,
      speakerActorId: input.speakerActorId ?? null,
      visibility: input.visibility,
      whisperTo: input.whisperTo ?? [],
    };
    const result = (await page.evaluate(postChatMessageBody, args)) as PostChatMessageResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        chatMessageId: result.chatMessageId,
        speakerActorId: result.speaker.actorId,
        visibility: result.visibility,
        isWhisper: result.isWhisper,
        whisperCount: result.whisperedTo.length,
      },
      'post_chat_message',
    );
    return [jsonText(result)];
  },
};
