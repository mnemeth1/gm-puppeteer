/**
 * page.evaluate body for list_journal_folders. Read-only enumeration of
 * every `type: "JournalEntry"` folder in the world, projecting the
 * fields a caller needs to discover folder ids and reconstruct the
 * directory tree: id, name, parentFolderId, depth, sort, and the counts
 * of journal entries and subfolders directly inside each folder.
 *
 * `list_journals` reports each entry's folderId but never the folders
 * themselves — this tool is the folder-side discovery counterpart, and
 * the source of the `parentFolderId` ids that create/update consume.
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export interface JournalFolderSummary {
  id: string;
  name: string;
  parentFolderId: string | null;
  depth: number;
  sort: number;
  entryCount: number;
  subfolderCount: number;
}

export interface ListJournalFoldersOk {
  ok: true;
  folders: JournalFolderSummary[];
  count: number;
}

export interface ListJournalFoldersErr {
  ok: false;
  error: { code: 'INVALID_INPUT'; message: string };
}

export type ListJournalFoldersResult = ListJournalFoldersOk | ListJournalFoldersErr;

export function listJournalFoldersBody(): ListJournalFoldersResult {
  interface FoundryFolderLike {
    id?: string;
    name?: string;
    type?: string;
    sort?: number;
    folder?: FoundryFolderLike | null;
  }
  interface FoundryJournalEntryLike {
    folder?: FoundryFolderLike | null;
  }
  interface FoundryGameForList {
    folders?: { contents?: FoundryFolderLike[] };
    journal?: { contents?: FoundryJournalEntryLike[] };
  }

  // Nesting depth of a folder, counting itself: a root folder is depth 1.
  function depthOf(f: FoundryFolderLike | null | undefined): number {
    let d = 0;
    let cursor: FoundryFolderLike | null | undefined = f;
    const visited = new Set<string>();
    while (cursor && typeof cursor.id === 'string') {
      if (visited.has(cursor.id)) break;
      visited.add(cursor.id);
      d += 1;
      cursor = cursor.folder ?? null;
      if (d > 256) break;
    }
    return d;
  }

  const game = (globalThis as unknown as { game?: FoundryGameForList }).game;
  if (!game) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Foundry game object is not ready.' },
    };
  }

  const allFolders = (game.folders?.contents ?? []).filter(
    (f) => f && typeof f.id === 'string' && f.type === 'JournalEntry',
  );

  // Direct-child counts, keyed by parent folder id.
  const subfolderCounts = new Map<string, number>();
  for (const f of allFolders) {
    const parentId = f.folder?.id ?? null;
    if (parentId !== null) {
      subfolderCounts.set(parentId, (subfolderCounts.get(parentId) ?? 0) + 1);
    }
  }
  const entryCounts = new Map<string, number>();
  for (const e of game.journal?.contents ?? []) {
    const parentId = e.folder?.id ?? null;
    if (parentId !== null) {
      entryCounts.set(parentId, (entryCounts.get(parentId) ?? 0) + 1);
    }
  }

  const folders: JournalFolderSummary[] = [];
  for (const f of allFolders) {
    const fid = f.id as string;
    folders.push({
      id: fid,
      name: typeof f.name === 'string' ? f.name : '',
      parentFolderId: f.folder?.id ?? null,
      depth: depthOf(f),
      sort: typeof f.sort === 'number' ? f.sort : 0,
      entryCount: entryCounts.get(fid) ?? 0,
      subfolderCount: subfolderCounts.get(fid) ?? 0,
    });
  }

  folders.sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));

  return { ok: true, folders, count: folders.length };
}
