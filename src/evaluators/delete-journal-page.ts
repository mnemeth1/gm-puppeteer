/**
 * page.evaluate body for delete_journal_page. Removes a single page from
 * a JournalEntry. The parent entry is left intact even if this was its
 * last page (Foundry permits zero-page entries).
 *
 * To delete the whole entry and all its pages at once, use
 * delete_journal_entry instead.
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export interface DeleteJournalPageInput {
  entryId: string;
  pageId: string;
}

export interface DeleteJournalPageOk {
  ok: true;
  entryId: string;
  pageId: string;
  name: string;
  remainingPageCount: number;
}

export interface DeleteJournalPageErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT' | 'FOUNDRY_REJECTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type DeleteJournalPageResult = DeleteJournalPageOk | DeleteJournalPageErr;

export async function deleteJournalPageBody(
  input: DeleteJournalPageInput,
): Promise<DeleteJournalPageResult> {
  interface FoundryJournalPageLike {
    id?: string;
    name?: string;
    delete(): Promise<unknown>;
  }
  interface FoundryEmbeddedCollection {
    get(id: string): FoundryJournalPageLike | null | undefined;
    size?: number;
  }
  interface FoundryJournalEntryLike {
    id?: string;
    pages?: FoundryEmbeddedCollection | null;
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

  const pg = entry.pages?.get(input.pageId) ?? null;
  if (!pg || typeof pg.id !== 'string') {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `No page "${input.pageId}" on journal entry "${input.entryId}".`,
        details: { reason: 'PAGE_NOT_FOUND', entryId: input.entryId, pageId: input.pageId },
      },
    };
  }

  const pageId = pg.id;
  const name = typeof pg.name === 'string' ? pg.name : '';

  try {
    await pg.delete();
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'FOUNDRY_REJECTED',
        message: `Foundry rejected page delete: ${e instanceof Error ? e.message : String(e)}`,
        details: { reason: 'DELETE_THREW' },
      },
    };
  }

  return {
    ok: true,
    entryId: entry.id,
    pageId,
    name,
    remainingPageCount: typeof entry.pages?.size === 'number' ? entry.pages.size : 0,
  };
}
