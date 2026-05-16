/**
 * page.evaluate body for create_journal_entry. Creates a new JournalEntry
 * with no pages — pages are added via separate `create_journal_page` calls
 * (compose-primitives principle).
 *
 * Optional `defaultOwnership` lets the caller set the entry's baseline
 * ownership level at creation time, which is the common case for
 * "Campaign Story / players see it as OBSERVER" workflows. Per-user
 * ownership grants flow through `assign_journal_ownership`.
 *
 * Folder validation: Foundry rejects mismatched-type folders at the
 * document layer (a JournalEntry can only live in a JournalEntry folder),
 * so we forward `folderId` as-is and surface any thrown error.
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export type OwnershipLevelString = 'NONE' | 'LIMITED' | 'OBSERVER' | 'OWNER';

export interface CreateJournalEntryInput {
  name: string;
  folderId?: string | null | undefined;
  defaultOwnership?: OwnershipLevelString | undefined;
}

export interface CreateJournalEntryOk {
  ok: true;
  id: string;
  name: string;
  folderId: string | null;
  defaultOwnership: OwnershipLevelString;
}

export interface CreateJournalEntryErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT' | 'FOUNDRY_REJECTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type CreateJournalEntryResult = CreateJournalEntryOk | CreateJournalEntryErr;

export async function createJournalEntryBody(
  input: CreateJournalEntryInput,
): Promise<CreateJournalEntryResult> {
  const LEVEL_STRING_TO_NUM: Record<OwnershipLevelString, number> = {
    NONE: 0,
    LIMITED: 1,
    OBSERVER: 2,
    OWNER: 3,
  };
  const LEVEL_NUM_TO_STRING: Record<number, OwnershipLevelString> = {
    0: 'NONE',
    1: 'LIMITED',
    2: 'OBSERVER',
    3: 'OWNER',
  };

  interface FoundryFolderLike {
    id?: string;
    type?: string;
  }
  interface FoundryEntryConstructorLike {
    create(data: Record<string, unknown>): Promise<{
      id?: string;
      name?: string;
      folder?: FoundryFolderLike | null;
      ownership?: Record<string, number> | null;
    }>;
  }
  interface FoundryGameForCreate {
    folders?: { get(id: string): FoundryFolderLike | null | undefined };
  }

  const game = (globalThis as unknown as { game?: FoundryGameForCreate }).game;
  if (!game) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Foundry game object is not ready.' },
    };
  }

  const data: Record<string, unknown> = { name: input.name };

  if (input.folderId !== undefined && input.folderId !== null) {
    const folder = game.folders?.get(input.folderId) ?? null;
    if (!folder) {
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
    data.folder = input.folderId;
  }

  if (input.defaultOwnership !== undefined) {
    const lvl = LEVEL_STRING_TO_NUM[input.defaultOwnership];
    if (typeof lvl !== 'number') {
      return {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: `Unknown ownership level "${input.defaultOwnership}".`,
          details: { reason: 'INVALID_LEVEL', level: input.defaultOwnership },
        },
      };
    }
    data.ownership = { default: lvl };
  }

  const ctor = (globalThis as unknown as { JournalEntry?: FoundryEntryConstructorLike })
    .JournalEntry;
  if (!ctor) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'JournalEntry constructor is not available.' },
    };
  }

  let entry;
  try {
    entry = await ctor.create(data);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'FOUNDRY_REJECTED',
        message: `Foundry rejected JournalEntry.create: ${e instanceof Error ? e.message : String(e)}`,
        details: { reason: 'CREATE_THREW' },
      },
    };
  }

  if (!entry || typeof entry.id !== 'string') {
    return {
      ok: false,
      error: {
        code: 'FOUNDRY_REJECTED',
        message: 'JournalEntry.create returned no id.',
        details: { reason: 'NO_ID_RETURNED' },
      },
    };
  }

  const ownDefault = entry.ownership?.default;
  const defaultOwnership: OwnershipLevelString =
    typeof ownDefault === 'number' && LEVEL_NUM_TO_STRING[ownDefault]
      ? LEVEL_NUM_TO_STRING[ownDefault]
      : 'NONE';

  return {
    ok: true,
    id: entry.id,
    name: typeof entry.name === 'string' ? entry.name : input.name,
    folderId: entry.folder?.id ?? null,
    defaultOwnership,
  };
}
