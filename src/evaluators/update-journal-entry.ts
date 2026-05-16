/**
 * page.evaluate body for update_journal_entry. Modifies entry-level
 * metadata: `name` and/or `folderId`. Ownership flows through the
 * dedicated ownership tools (`assign_journal_ownership`,
 * `remove_journal_ownership`); pages flow through `update_journal_page`.
 *
 * `folderId: null` unparents the entry to the root of the journal
 * directory. Omitted means "do not touch". An update with neither
 * field present is rejected — call sites must pass at least one
 * meaningful change.
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export interface UpdateJournalEntryInput {
  entryId: string;
  name?: string | undefined;
  folderId?: string | null | undefined;
}

export interface UpdateJournalEntryOk {
  ok: true;
  entry: { id: string; name: string; folderId: string | null };
  changedFields: string[];
}

export interface UpdateJournalEntryErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT' | 'FOUNDRY_REJECTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type UpdateJournalEntryResult = UpdateJournalEntryOk | UpdateJournalEntryErr;

export async function updateJournalEntryBody(
  input: UpdateJournalEntryInput,
): Promise<UpdateJournalEntryResult> {
  interface FoundryFolderLike {
    id?: string;
    type?: string;
  }
  interface FoundryJournalEntryLike {
    id?: string;
    name?: string;
    folder?: FoundryFolderLike | null;
    update(changes: Record<string, unknown>): Promise<unknown>;
  }
  interface FoundryGameForUpdate {
    journal?: { get(id: string): FoundryJournalEntryLike | null | undefined };
    folders?: { get(id: string): FoundryFolderLike | null | undefined };
  }

  const game = (globalThis as unknown as { game?: FoundryGameForUpdate }).game;
  if (!game) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Foundry game object is not ready.' },
    };
  }

  const entry = game.journal?.get(input.entryId) ?? null;
  if (!entry || typeof entry.id !== 'string') {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `No journal entry found with id "${input.entryId}".`,
        details: { reason: 'ENTRY_NOT_FOUND', entryId: input.entryId },
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
    if (input.name !== entry.name) {
      changes.name = input.name;
      changedFields.push('name');
    }
  }

  if (input.folderId !== undefined) {
    if (input.folderId === null) {
      const wasFoldered = entry.folder?.id ?? null;
      if (wasFoldered !== null) {
        changes.folder = null;
        changedFields.push('folderId');
      }
    } else {
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
            details: {
              reason: 'FOLDER_WRONG_TYPE',
              folderId: input.folderId,
              folderType: folder.type,
            },
          },
        };
      }
      if ((entry.folder?.id ?? null) !== input.folderId) {
        changes.folder = input.folderId;
        changedFields.push('folderId');
      }
    }
  }

  if (changedFields.length === 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'No changes specified. Pass at least one of `name` or `folderId` (use folderId: null to unparent).',
        details: { reason: 'NO_CHANGES' },
      },
    };
  }

  try {
    await entry.update(changes);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'FOUNDRY_REJECTED',
        message: `Foundry rejected entry update: ${e instanceof Error ? e.message : String(e)}`,
        details: { reason: 'UPDATE_THREW', changes },
      },
    };
  }

  return {
    ok: true,
    entry: {
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : '',
      folderId: entry.folder?.id ?? null,
    },
    changedFields,
  };
}
