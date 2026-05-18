import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  listJournalFoldersBody,
  type ListJournalFoldersResult,
} from '../evaluators/list-journal-folders.js';
import { jsonText, type ToolDefinition } from './types.js';

const ListJournalFoldersInput = z.object({}).strict();

export const listJournalFoldersTool: ToolDefinition<typeof ListJournalFoldersInput> = {
  name: 'list_journal_folders',
  description:
    'Read-only enumeration of every "JournalEntry"-type folder in the current world. One ' +
    'row per folder with id, name, parentFolderId, depth (root folders are depth 1), sort, ' +
    'and the counts of journal entries and subfolders directly inside it — sorted by name. ' +
    'Use this to discover the folderId / parentFolderId values needed by ' +
    'create_journal_folder, update_journal_folder, delete_journal_folder, and the ' +
    'folderId parameter of create_journal_entry / update_journal_entry. To list the ' +
    'journal entries themselves, call list_journals.',
  inputSchema: ListJournalFoldersInput,
  async handler(_input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(listJournalFoldersBody)) as ListJournalFoldersResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    return [jsonText({ folders: result.folders, count: result.count })];
  },
};
