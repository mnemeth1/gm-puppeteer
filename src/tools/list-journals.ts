import { z } from 'zod';
import { listJournalsBody, type ListJournalsResult } from '../evaluators/list-journals.js';
import { jsonText, type ToolDefinition } from './types.js';

const ListJournalsInput = z.object({}).strict();

export const listJournalsTool: ToolDefinition<typeof ListJournalsInput> = {
  name: 'list_journals',
  description:
    "Read-only enumeration of every JournalEntry in the current Foundry world's journal " +
    'directory. One row per entry with id, name, folderId, pageCount, and an ownership ' +
    'summary (default level + hasOverrides flag), sorted by name. Use this to discover ' +
    'the entryId you need to pass into get_journal_entry, get_journal_page, the entry/' +
    'page mutation tools, or the journal ownership tools. The pages-as-records pattern ' +
    'is recommended: a "Campaign Story" entry accumulates one page per session, a ' +
    '"Quests" entry has one page per quest, an "NPCs" entry has one page per NPC. To ' +
    "inspect a specific entry's page list (TOC), call get_journal_entry; to read full " +
    'page content, call get_journal_page; to find content by keyword across the whole ' +
    'world, call search_journals. NOT for compendium journals — this lists world-level ' +
    'entries only. NOT for PF2e rules text (use https://2e.aonprd.com/ via web-fetch).',
  inputSchema: ListJournalsInput,
  async handler(_input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(listJournalsBody)) as ListJournalsResult;
    return [jsonText({ entries: result.entries })];
  },
};
