/**
 * page.evaluate body for update_journal_folder. Mutates a journal
 * folder's metadata: `name` (rename) and/or `parentFolderId` (move).
 * Mirrors `update_journal_entry` — at least one field must be supplied
 * or the call is rejected, and a `changedFields` array is returned for
 * audit.
 *
 * `parentFolderId: null` moves the folder to the journal-directory root;
 * omitted means "do not touch". A move is validated in the tool, not
 * left to Foundry: a folder cannot be moved into itself or any of its
 * own descendants (cycle), and the move must not push the folder's
 * deepest descendant past `CONST.FOLDER_MAX_DEPTH` — a move carries the
 * folder's whole subtree, so the depth check uses the subtree height.
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export interface UpdateJournalFolderInput {
  folderId: string;
  name?: string | undefined;
  parentFolderId?: string | null | undefined;
}

export interface UpdateJournalFolderOk {
  ok: true;
  folder: { id: string; name: string; parentFolderId: string | null; depth: number };
  changedFields: string[];
}

export interface UpdateJournalFolderErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT' | 'FOUNDRY_REJECTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type UpdateJournalFolderResult = UpdateJournalFolderOk | UpdateJournalFolderErr;

export async function updateJournalFolderBody(
  input: UpdateJournalFolderInput,
): Promise<UpdateJournalFolderResult> {
  interface FoundryFolderLike {
    id?: string;
    name?: string;
    type?: string;
    folder?: FoundryFolderLike | null;
    update(changes: Record<string, unknown>): Promise<unknown>;
  }
  interface FoundryGameForUpdate {
    folders?: {
      get(id: string): FoundryFolderLike | null | undefined;
      contents?: FoundryFolderLike[];
    };
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

  const game = (globalThis as unknown as { game?: FoundryGameForUpdate }).game;
  if (!game) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Foundry game object is not ready.' },
    };
  }

  const g = globalThis as unknown as {
    CONST?: { FOLDER_MAX_DEPTH?: number };
    foundry?: { CONST?: { FOLDER_MAX_DEPTH?: number } };
  };
  const rawMaxDepth = g.CONST?.FOLDER_MAX_DEPTH ?? g.foundry?.CONST?.FOLDER_MAX_DEPTH;
  const maxDepth = typeof rawMaxDepth === 'number' ? rawMaxDepth : 3;

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

  const changes: Record<string, unknown> = {};
  const changedFields: string[] = [];

  if (typeof input.name === 'string') {
    if (input.name.length === 0) {
      return {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'name must be a non-empty string when provided.',
          details: { reason: 'EMPTY_NAME' },
        },
      };
    }
    if (input.name !== folder.name) {
      changes.name = input.name;
      changedFields.push('name');
    }
  }

  if (input.parentFolderId !== undefined) {
    if (input.parentFolderId === null) {
      if ((folder.folder?.id ?? null) !== null) {
        changes.folder = null;
        changedFields.push('parentFolderId');
      }
    } else {
      const parent = game.folders?.get(input.parentFolderId) ?? null;
      if (!parent) {
        return {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: `No folder found with id "${input.parentFolderId}".`,
            details: { reason: 'FOLDER_NOT_FOUND', folderId: input.parentFolderId },
          },
        };
      }
      if (parent.type !== 'JournalEntry') {
        return {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: `Folder "${input.parentFolderId}" is type "${parent.type}", not "JournalEntry".`,
            details: {
              reason: 'FOLDER_WRONG_TYPE',
              folderId: input.parentFolderId,
              folderType: parent.type,
            },
          },
        };
      }
      // Cycle guard: the new parent must not be the folder itself nor any
      // of its descendants. Walk up the proposed parent's ancestor chain;
      // reaching the folder being moved means the move would make the
      // folder its own ancestor.
      if (input.parentFolderId === folder.id) {
        return {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Cannot move a folder into itself.',
            details: { reason: 'FOLDER_CYCLE', folderId: input.folderId },
          },
        };
      }
      const visited = new Set<string>();
      let cursor: FoundryFolderLike | null | undefined = parent;
      let cycleHit = false;
      let walk = 0;
      while (cursor && typeof cursor.id === 'string') {
        if (visited.has(cursor.id)) break;
        visited.add(cursor.id);
        if (cursor.id === folder.id) {
          cycleHit = true;
          break;
        }
        cursor = cursor.folder ?? null;
        walk += 1;
        if (walk > 256) break;
      }
      if (cycleHit) {
        return {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message:
              `Cannot move folder "${input.folderId}" under "${input.parentFolderId}" — that ` +
              `folder is a descendant of the one being moved (cycle).`,
            details: {
              reason: 'FOLDER_CYCLE',
              folderId: input.folderId,
              parentFolderId: input.parentFolderId,
            },
          },
        };
      }
      // Depth guard: the move carries the whole subtree, so the deepest
      // descendant must still fit. attemptedDepth = parent depth +
      // height of the moved folder's subtree (a leaf folder has height 1).
      const allFolders = game.folders?.contents ?? [];
      let frontier: string[] = [folder.id];
      const seen = new Set<string>();
      let subtreeHeight = 0;
      while (frontier.length > 0) {
        subtreeHeight += 1;
        if (subtreeHeight > 256) break;
        const next: string[] = [];
        for (const id of frontier) {
          if (seen.has(id)) continue;
          seen.add(id);
          for (const f of allFolders) {
            const childId = f.id;
            if (
              typeof childId === 'string' &&
              !seen.has(childId) &&
              (f.folder?.id ?? null) === id
            ) {
              next.push(childId);
            }
          }
        }
        frontier = next;
      }
      const attemptedDepth = depthOf(parent) + subtreeHeight;
      if (attemptedDepth > maxDepth) {
        return {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message:
              `Moving folder "${input.folderId}" under "${input.parentFolderId}" would nest its ` +
              `deepest subfolder ${attemptedDepth} levels deep, past the folder depth limit ` +
              `of ${maxDepth}.`,
            details: { reason: 'MAX_DEPTH_EXCEEDED', maxDepth, attemptedDepth, subtreeHeight },
          },
        };
      }
      if ((folder.folder?.id ?? null) !== input.parentFolderId) {
        changes.folder = input.parentFolderId;
        changedFields.push('parentFolderId');
      }
    }
  }

  if (changedFields.length === 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'No changes specified. Pass at least one of `name` or `parentFolderId` ' +
          '(use parentFolderId: null to move to root).',
        details: { reason: 'NO_CHANGES' },
      },
    };
  }

  try {
    await folder.update(changes);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'FOUNDRY_REJECTED',
        message: `Foundry rejected folder update: ${e instanceof Error ? e.message : String(e)}`,
        details: { reason: 'UPDATE_THREW', changes },
      },
    };
  }

  return {
    ok: true,
    folder: {
      id: folder.id,
      name: typeof folder.name === 'string' ? folder.name : '',
      parentFolderId: folder.folder?.id ?? null,
      depth: depthOf(folder),
    },
    changedFields,
  };
}
