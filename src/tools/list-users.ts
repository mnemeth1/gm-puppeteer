import { z } from 'zod';
import { listUsersBody, type ListUsersResult } from '../evaluators/list-users.js';
import { jsonText, type ToolDefinition } from './types.js';

const ListUsersInput = z.object({}).strict();

export const listUsersTool: ToolDefinition<typeof ListUsersInput> = {
  name: 'list_users',
  description:
    'Read-only enumeration of every Foundry User in the current world. One row per ' +
    'user with id, name, role (0 NONE | 1 PLAYER | 2 TRUSTED | 3 ASSISTANT | 4 GAMEMASTER), ' +
    "isGM (true for ASSISTANT/GAMEMASTER), active (currently logged in), idle (Foundry's " +
    '"away"/"zzz" state — an active user who has produced no input recently), and ' +
    'idleSeconds (seconds since last activity, or null when unknown). Sorted by ' +
    'name. Use active+idle to answer "who is online and at the keyboard right now". ' +
    'Use this to discover the userId you need to pass into assign_actor_ownership ' +
    'or remove_actor_ownership. NOT for user-account management — this tool does not ' +
    'create users, change passwords, or set roles; those operations live in the Foundry ' +
    'setup UI. The headless GM user the MCP itself logs in as appears in the ' +
    'output and is identifiable as a GM with active=true; that user ALWAYS reports ' +
    'idle=true / idleSeconds=null because the headless browser generates no input — ' +
    "treat the MCP's own user's idle state as meaningless.",
  inputSchema: ListUsersInput,
  async handler(_input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(listUsersBody)) as ListUsersResult;
    return [jsonText({ users: result.users })];
  },
};
