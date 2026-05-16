/**
 * page.evaluate body for show_journal_entry. Invokes Foundry's
 * `JournalEntry#show(force)` to broadcast a journal entry to connected
 * players — it pops the entry open on their screens.
 *
 *  - `force = false` (default): the entry opens for players, but each
 *    player still only sees content they have OBSERVER+ permission on.
 *    Players with NONE permission get nothing.
 *  - `force = true`: bypasses permission — every connected client is
 *    shown the entry regardless of ownership. Use sparingly; this is
 *    the "reveal a secret page to everyone right now" hammer.
 *
 * Phase 1 probing confirmed `show()` and `show(true)` both resolve
 * without throwing when called from the headless GM tab, and that the
 * headless client is a fully-connected GM client capable of
 * originating the broadcast. End-to-end delivery (a popup actually
 * appearing on another player's screen) is verified by a human
 * checkpoint in `probe-show-journal-entry.mjs`.
 *
 * `broadcastTo` reports how many users were active (connected) at call
 * time — informational, so the caller knows whether anyone was there
 * to receive it.
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export interface ShowJournalEntryInput {
  entryId: string;
  force?: boolean | undefined;
}

export interface ShowJournalEntryOk {
  ok: true;
  id: string;
  name: string;
  force: boolean;
  broadcastTo: number;
  activeUsers: { id: string; name: string; isGM: boolean }[];
}

export interface ShowJournalEntryErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT' | 'FOUNDRY_REJECTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ShowJournalEntryResult = ShowJournalEntryOk | ShowJournalEntryErr;

export async function showJournalEntryBody(
  input: ShowJournalEntryInput,
): Promise<ShowJournalEntryResult> {
  interface FoundryUserLike {
    id?: string;
    name?: string;
    isGM?: boolean;
    active?: boolean;
  }
  interface FoundryJournalEntryLike {
    id?: string;
    name?: string;
    show(force?: boolean): Promise<unknown>;
  }
  interface FoundryGameForShow {
    journal?: { get(id: string): FoundryJournalEntryLike | null | undefined };
    users?: { contents?: FoundryUserLike[] };
  }

  const game = (globalThis as unknown as { game?: FoundryGameForShow }).game;
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

  if (typeof entry.show !== 'function') {
    return {
      ok: false,
      error: {
        code: 'FOUNDRY_REJECTED',
        message: 'JournalEntry#show is not available on this entry.',
        details: { reason: 'NO_SHOW_METHOD' },
      },
    };
  }

  const force = input.force === true;

  try {
    await entry.show(force);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'FOUNDRY_REJECTED',
        message: `Foundry rejected JournalEntry#show: ${e instanceof Error ? e.message : String(e)}`,
        details: { reason: 'SHOW_THREW' },
      },
    };
  }

  const activeUsers: { id: string; name: string; isGM: boolean }[] = [];
  for (const u of game.users?.contents ?? []) {
    if (u?.active === true && typeof u.id === 'string') {
      activeUsers.push({
        id: u.id,
        name: typeof u.name === 'string' ? u.name : '',
        isGM: u.isGM === true,
      });
    }
  }

  return {
    ok: true,
    id: entry.id,
    name: typeof entry.name === 'string' ? entry.name : '',
    force,
    broadcastTo: activeUsers.length,
    activeUsers,
  };
}
