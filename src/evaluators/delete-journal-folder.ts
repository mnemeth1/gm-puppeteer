/**
 * page.evaluate body for delete_journal_folder. Removes a journal folder.
 *
 * `Folder#delete()` takes two option flags:
 *  - default (both false): the folder is removed and its journal entries
 *    and subfolders are reparented up to the deleted folder's own parent
 *    (or to root) — nothing is destroyed but the folder itself.
 *  - `deleteContents: true`: journal entries within the subtree are
 *    deleted too.
 *  - `deleteSubfolders: true`: nested folders within the subtree are
 *    deleted too.
 *
 * The return shape reports counts of what was destroyed vs reparented,
 * computed by snapshotting the folder's full subtree (descendant folders
 * and contained journal entries) before the delete and diffing against
 * the live collections after.
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export interface DeleteJournalFolderInput {
  folderId: string;
  deleteContents?: boolean | undefined;
  deleteSubfolders?: boolean | undefined;
}

export interface DeleteJournalFolderOk {
  ok: true;
  deleted: { id: string; name: string };
  deletedContents: number;
  deletedSubfolders: number;
  reparentedEntries: number;
  reparentedSubfolders: number;
}

export interface DeleteJournalFolderErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT' | 'FOUNDRY_REJECTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type DeleteJournalFolderResult = DeleteJournalFolderOk | DeleteJournalFolderErr;

export async function deleteJournalFolderBody(
  input: DeleteJournalFolderInput,
): Promise<DeleteJournalFolderResult> {
  interface FoundryFolderLike {
    id?: string;
    name?: string;
    type?: string;
    folder?: FoundryFolderLike | null;
    delete(options?: Record<string, unknown>): Promise<unknown>;
  }
  interface FoundryJournalEntryLike {
    id?: string;
    folder?: FoundryFolderLike | null;
  }
  interface FoundryGameForDelete {
    folders?: {
      get(id: string): FoundryFolderLike | null | undefined;
      contents?: FoundryFolderLike[];
    };
    journal?: {
      get(id: string): FoundryJournalEntryLike | null | undefined;
      contents?: FoundryJournalEntryLike[];
    };
  }

  const game = (globalThis as unknown as { game?: FoundryGameForDelete }).game;
  if (!game) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Foundry game object is not ready.' },
    };
  }

  const folder = game.folders?.get(input.folderId) ?? null;
  if (!folder || typeof folder.id !== 'string') {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `No folder found with id "${input.folderId}".`,
        details: { reason: 'FOLDER_NOT_FOUND', folderId: input.folderId },
      },
    };
  }
  if (folder.type !== 'JournalEntry') {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Folder "${input.folderId}" is type "${folder.type}", not "JournalEntry".`,
        details: { reason: 'FOLDER_WRONG_TYPE', folderId: input.folderId, folderType: folder.type },
      },
    };
  }

  const id = folder.id;
  const name = typeof folder.name === 'string' ? folder.name : '';

  // Snapshot the subtree before deleting: every descendant folder id and
  // every journal entry id contained anywhere within the subtree.
  const allFolders = game.folders?.contents ?? [];
  const descendantFolderIds = new Set<string>();
  let frontier: string[] = [id];
  let guard = 0;
  while (frontier.length > 0 && guard < 1024) {
    guard += 1;
    const next: string[] = [];
    for (const f of allFolders) {
      const childId = f.id;
      const parentId = f.folder?.id ?? null;
      if (
        typeof childId === 'string' &&
        childId !== id &&
        !descendantFolderIds.has(childId) &&
        parentId !== null &&
        frontier.includes(parentId)
      ) {
        descendantFolderIds.add(childId);
        next.push(childId);
      }
    }
    frontier = next;
  }
  const subtreeFolderIds = new Set<string>([id, ...descendantFolderIds]);
  const entryIds: string[] = [];
  for (const e of game.journal?.contents ?? []) {
    const entryId = e.id;
    const entryFolderId = e.folder?.id ?? null;
    if (
      typeof entryId === 'string' &&
      entryFolderId !== null &&
      subtreeFolderIds.has(entryFolderId)
    ) {
      entryIds.push(entryId);
    }
  }

  try {
    await folder.delete({
      deleteSubfolders: input.deleteSubfolders === true,
      deleteContents: input.deleteContents === true,
    });
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'FOUNDRY_REJECTED',
        message: `Foundry rejected folder delete: ${e instanceof Error ? e.message : String(e)}`,
        details: { reason: 'DELETE_THREW', folderId: input.folderId },
      },
    };
  }

  let deletedSubfolders = 0;
  let reparentedSubfolders = 0;
  for (const fid of descendantFolderIds) {
    if (game.folders?.get(fid)) reparentedSubfolders += 1;
    else deletedSubfolders += 1;
  }
  let deletedContents = 0;
  let reparentedEntries = 0;
  for (const eid of entryIds) {
    if (game.journal?.get(eid)) reparentedEntries += 1;
    else deletedContents += 1;
  }

  return {
    ok: true,
    deleted: { id, name },
    deletedContents,
    deletedSubfolders,
    reparentedEntries,
    reparentedSubfolders,
  };
}
