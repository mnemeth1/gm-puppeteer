/**
 * page.evaluate body for create_journal_page. Appends a new text page
 * to an existing JournalEntry.
 *
 * Markdown is the write format. Phase 1 probing
 * (`probe-journal-phase1.mjs`) established that Foundry does NOT compile
 * `text.markdown` into `text.content` during the JournalEntry.create /
 * createEmbeddedDocuments path — `content` stays null until the next
 * page.update. A page with null content renders blank in the UI, so
 * this tool renders the markdown to HTML itself (via the globally-
 * available `showdown` library) and writes BOTH `text.markdown` (the
 * source of truth) and `text.content` (the display cache) plus
 * `text.format = 2` (MARKDOWN).
 *
 * Page sort: Foundry does NOT auto-increment the embedded-page `sort`
 * field — every page created in one batch gets `sort: 0` (probe Q5).
 * When the caller omits `sort`, this tool assigns
 * `max(existing sorts) + 100000` so new pages land deterministically
 * after existing ones.
 *
 * v1 creates text pages only; image/pdf/video page creation is out of
 * scope (use `foundry_eval`).
 *
 * Note: serialized via `page.evaluate`. All helpers — including the
 * showdown converter call — are inlined.
 */
export interface CreateJournalPageInput {
  entryId: string;
  name: string;
  markdown?: string | undefined;
  sort?: number | undefined;
  titleShow?: boolean | undefined;
  titleLevel?: number | undefined;
}

export interface CreateJournalPageOk {
  ok: true;
  entryId: string;
  pageId: string;
  name: string;
  sort: number;
  warnings?: string[];
}

export interface CreateJournalPageErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT' | 'FOUNDRY_REJECTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type CreateJournalPageResult = CreateJournalPageOk | CreateJournalPageErr;

export async function createJournalPageBody(
  input: CreateJournalPageInput,
): Promise<CreateJournalPageResult> {
  // Inlined markdown renderer — showdown is loaded globally by Foundry's
  // own journal markdown editor. Returns null if unavailable.
  function renderMarkdown(md: string): string | null {
    const sd = (globalThis as unknown as { showdown?: unknown }).showdown as
      | { Converter?: new (opts?: Record<string, boolean>) => { makeHtml(s: string): string } }
      | undefined;
    if (!sd || typeof sd.Converter !== 'function') return null;
    const converter = new sd.Converter({
      tables: true,
      strikethrough: true,
      tasklists: true,
    });
    return converter.makeHtml(md);
  }

  interface FoundryJournalPageLike {
    id?: string;
    name?: string;
    sort?: number;
  }
  interface FoundryEmbeddedCollection {
    contents?: FoundryJournalPageLike[];
  }
  interface FoundryJournalEntryLike {
    id?: string;
    pages?: FoundryEmbeddedCollection | null;
    createEmbeddedDocuments(
      type: string,
      data: Record<string, unknown>[],
    ): Promise<FoundryJournalPageLike[]>;
  }
  interface FoundryGameForCreate {
    journal?: { get(id: string): FoundryJournalEntryLike | null | undefined };
  }

  const game = (globalThis as unknown as { game?: FoundryGameForCreate }).game;
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

  const warnings: string[] = [];
  const markdown = typeof input.markdown === 'string' ? input.markdown : '';
  let content = '';
  if (markdown.length > 0) {
    const rendered = renderMarkdown(markdown);
    if (rendered === null) {
      warnings.push(
        'showdown markdown renderer was unavailable; text.content left empty — the page ' +
          'will render blank until its next update_journal_page call re-renders it.',
      );
    } else {
      content = rendered;
    }
  }

  // Determine sort. Omitted → max(existing) + 100000; empty entry → 0.
  let sort: number;
  if (typeof input.sort === 'number') {
    sort = input.sort;
  } else {
    const existing = entry.pages?.contents ?? [];
    if (existing.length === 0) {
      sort = 0;
    } else {
      let max = Number.NEGATIVE_INFINITY;
      for (const p of existing) {
        const s = typeof p.sort === 'number' ? p.sort : 0;
        if (s > max) max = s;
      }
      sort = (Number.isFinite(max) ? max : 0) + 100000;
    }
  }

  const pageData: Record<string, unknown> = {
    name: input.name,
    type: 'text',
    sort,
    text: {
      format: 2,
      markdown,
      content,
    },
    title: {
      show: input.titleShow !== false,
      level: typeof input.titleLevel === 'number' ? input.titleLevel : 1,
    },
  };

  let created: FoundryJournalPageLike[];
  try {
    created = await entry.createEmbeddedDocuments('JournalEntryPage', [pageData]);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'FOUNDRY_REJECTED',
        message: `Foundry rejected page creation: ${e instanceof Error ? e.message : String(e)}`,
        details: { reason: 'CREATE_THREW', entryId: input.entryId },
      },
    };
  }

  const page = created?.[0];
  if (!page || typeof page.id !== 'string') {
    return {
      ok: false,
      error: {
        code: 'FOUNDRY_REJECTED',
        message: 'createEmbeddedDocuments returned no page id.',
        details: { reason: 'NO_ID_RETURNED' },
      },
    };
  }

  const result: CreateJournalPageOk = {
    ok: true,
    entryId: entry.id,
    pageId: page.id,
    name: typeof page.name === 'string' ? page.name : input.name,
    sort: typeof page.sort === 'number' ? page.sort : sort,
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}
