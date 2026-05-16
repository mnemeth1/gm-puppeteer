/**
 * page.evaluate body for delete_journal_entry. Removes a JournalEntry
 * and (cascading) all its embedded pages. Returns the deleted entry's
 * id, name, and how many pages went with it for audit.
 *
 * Foundry's `JournalEntry#delete()` cascades to embedded pages
 * automatically — no separate page-deletion call is needed.
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export interface DeleteJournalEntryInput {
  entryId: string;
}

export interface DeleteJournalEntryOk {
  ok: true;
  id: string;
  name: string;
  deletedPageCount: number;
}

export interface DeleteJournalEntryErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT' | 'FOUNDRY_REJECTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type DeleteJournalEntryResult = DeleteJournalEntryOk | DeleteJournalEntryErr;

export async function deleteJournalEntryBody(
  input: DeleteJournalEntryInput,
): Promise<DeleteJournalEntryResult> {
  interface FoundryEmbeddedCollection {
    size?: number;
  }
  interface FoundryJournalEntryLike {
    id?: string;
    name?: string;
    pages?: FoundryEmbeddedCollection | null;
    delete(): Promise<unknown>;
  }
  interface FoundryGameForDelete {
    journal?: { get(id: string): FoundryJournalEntryLike | null | undefined };
  }

  const game = (globalThis as unknown as { game?: FoundryGameForDelete }).game;
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

  const id = entry.id;
  const name = typeof entry.name === 'string' ? entry.name : '';
  const deletedPageCount = typeof entry.pages?.size === 'number' ? entry.pages.size : 0;

  try {
    await entry.delete();
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'FOUNDRY_REJECTED',
        message: `Foundry rejected entry delete: ${e instanceof Error ? e.message : String(e)}`,
        details: { reason: 'DELETE_THREW', entryId: input.entryId },
      },
    };
  }

  return { ok: true, id, name, deletedPageCount };
}
