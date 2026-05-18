/**
 * page.evaluate body for create_journal_folder. Creates a new Folder of
 * type "JournalEntry" in the world's folder directory, optionally nested
 * under an existing journal folder.
 *
 * `parentFolderId` null/omitted creates a root-level folder. A non-null
 * parent must exist and be of type "JournalEntry"; nesting that would
 * exceed Foundry's `CONST.FOLDER_MAX_DEPTH` is rejected up-front (a
 * graph-shape invariant Foundry does not reliably enforce itself).
 *
 * A Folder's parent is referenced by the `folder` field — the same
 * self-referential field used for documents-within-folders.
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export interface CreateJournalFolderInput {
  name: string;
  parentFolderId?: string | null | undefined;
}

export interface CreateJournalFolderOk {
  ok: true;
  id: string;
  name: string;
  parentFolderId: string | null;
  depth: number;
}

export interface CreateJournalFolderErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT' | 'FOUNDRY_REJECTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type CreateJournalFolderResult = CreateJournalFolderOk | CreateJournalFolderErr;

export async function createJournalFolderBody(
  input: CreateJournalFolderInput,
): Promise<CreateJournalFolderResult> {
  interface FoundryFolderLike {
    id?: string;
    name?: string;
    type?: string;
    folder?: FoundryFolderLike | null;
  }
  interface FoundryFolderConstructorLike {
    create(data: Record<string, unknown>): Promise<FoundryFolderLike | null | undefined>;
  }
  interface FoundryGameForCreate {
    folders?: { get(id: string): FoundryFolderLike | null | undefined };
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

  const game = (globalThis as unknown as { game?: FoundryGameForCreate }).game;
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

  const data: Record<string, unknown> = { name: input.name, type: 'JournalEntry' };
  let depth = 1;

  if (input.parentFolderId !== undefined && input.parentFolderId !== null) {
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
    const attemptedDepth = depthOf(parent) + 1;
    if (attemptedDepth > maxDepth) {
      return {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message:
            `Creating this folder under "${input.parentFolderId}" would nest it ` +
            `${attemptedDepth} levels deep, past the Foundry folder depth limit of ${maxDepth}.`,
          details: { reason: 'MAX_DEPTH_EXCEEDED', maxDepth, attemptedDepth },
        },
      };
    }
    data.folder = input.parentFolderId;
    depth = attemptedDepth;
  }

  const ctor = (globalThis as unknown as { Folder?: FoundryFolderConstructorLike }).Folder;
  if (!ctor) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Folder constructor is not available.' },
    };
  }

  let folder: FoundryFolderLike | null | undefined;
  try {
    folder = await ctor.create(data);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'FOUNDRY_REJECTED',
        message: `Foundry rejected Folder.create: ${e instanceof Error ? e.message : String(e)}`,
        details: { reason: 'CREATE_THREW' },
      },
    };
  }

  if (!folder || typeof folder.id !== 'string') {
    return {
      ok: false,
      error: {
        code: 'FOUNDRY_REJECTED',
        message: 'Folder.create returned no id.',
        details: { reason: 'NO_ID_RETURNED' },
      },
    };
  }

  return {
    ok: true,
    id: folder.id,
    name: typeof folder.name === 'string' ? folder.name : input.name,
    parentFolderId: folder.folder?.id ?? null,
    depth,
  };
}
