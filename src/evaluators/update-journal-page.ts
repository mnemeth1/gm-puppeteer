/**
 * page.evaluate body for update_journal_page. Mutates an existing text
 * page: name, sort, title, and/or body content.
 *
 * Body content is always Markdown. Three modes when `markdown` is given:
 *  - replace (default): the page body becomes exactly the supplied
 *    Markdown. Works on pages of EITHER format — an HTML-format page is
 *    converted to Markdown format (format=2) because "replace" means the
 *    whole body is being overwritten with Markdown anyway.
 *  - append: supplied Markdown is concatenated AFTER the existing
 *    Markdown source, joined by `separator`.
 *  - prepend: supplied Markdown is concatenated BEFORE the existing
 *    Markdown source, joined by `separator`.
 *
 * append / prepend require a format=2 (MARKDOWN) page. On a format=1
 * (HTML) page they are rejected with `INCOMPATIBLE_FORMAT`: there is no
 * lossless way to splice Markdown into hand-authored HTML. The caller's
 * workaround is read-then-replace — get_journal_page to read the HTML,
 * convert it, then update with mode "replace".
 *
 * Rendering: like create_journal_page, this writes BOTH `text.markdown`
 * (source) and `text.content` (HTML rendered via the global `showdown`
 * library), because Foundry's compile-on-update behaviour is not
 * something v1 relies on (phase 1 found create does not auto-compile;
 * being explicit keeps create and update uniform).
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export type UpdateJournalPageMode = 'replace' | 'append' | 'prepend';

export interface UpdateJournalPageInput {
  entryId: string;
  pageId: string;
  name?: string | undefined;
  sort?: number | undefined;
  titleShow?: boolean | undefined;
  titleLevel?: number | undefined;
  markdown?: string | undefined;
  mode?: UpdateJournalPageMode | undefined;
  separator?: string | undefined;
}

export interface UpdateJournalPageOk {
  ok: true;
  entryId: string;
  pageId: string;
  changedFields: string[];
  mode: UpdateJournalPageMode | null;
  warnings?: string[];
}

export interface UpdateJournalPageErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT' | 'INCOMPATIBLE_FORMAT' | 'FOUNDRY_REJECTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type UpdateJournalPageResult = UpdateJournalPageOk | UpdateJournalPageErr;

export async function updateJournalPageBody(
  input: UpdateJournalPageInput,
): Promise<UpdateJournalPageResult> {
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

  interface FoundryPageTextLike {
    format?: number;
    markdown?: string | null;
    content?: string | null;
  }
  interface FoundryJournalPageLike {
    id?: string;
    name?: string;
    type?: string;
    text?: FoundryPageTextLike | null;
    update(changes: Record<string, unknown>): Promise<unknown>;
  }
  interface FoundryEmbeddedCollection {
    get(id: string): FoundryJournalPageLike | null | undefined;
  }
  interface FoundryJournalEntryLike {
    id?: string;
    pages?: FoundryEmbeddedCollection | null;
  }
  interface FoundryGameForUpdate {
    journal?: { get(id: string): FoundryJournalEntryLike | null | undefined };
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

  if (pg.type !== 'text') {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Page "${input.pageId}" is type "${pg.type}", not "text". This tool only edits text pages.`,
        details: { reason: 'NOT_TEXT_PAGE', pageType: pg.type },
      },
    };
  }

  const changes: Record<string, unknown> = {};
  const changedFields: string[] = [];
  const warnings: string[] = [];

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
    if (input.name !== pg.name) {
      changes.name = input.name;
      changedFields.push('name');
    }
  }

  if (typeof input.sort === 'number') {
    changes.sort = input.sort;
    changedFields.push('sort');
  }

  if (typeof input.titleShow === 'boolean') {
    changes['title.show'] = input.titleShow;
    changedFields.push('title.show');
  }
  if (typeof input.titleLevel === 'number') {
    changes['title.level'] = input.titleLevel;
    changedFields.push('title.level');
  }

  let appliedMode: UpdateJournalPageMode | null = null;

  if (typeof input.markdown === 'string') {
    const mode: UpdateJournalPageMode = input.mode ?? 'replace';
    appliedMode = mode;
    const separator = typeof input.separator === 'string' ? input.separator : '\n\n';
    const currentFormat = typeof pg.text?.format === 'number' ? pg.text.format : 1;
    const currentMarkdown = typeof pg.text?.markdown === 'string' ? pg.text.markdown : '';

    let nextMarkdown: string;
    if (mode === 'replace') {
      nextMarkdown = input.markdown;
    } else {
      // append / prepend require a markdown-format page.
      if (currentFormat !== 2) {
        return {
          ok: false,
          error: {
            code: 'INCOMPATIBLE_FORMAT',
            message:
              `Cannot ${mode} Markdown onto page "${input.pageId}" — it is an HTML-format ` +
              'page (format=1). append/prepend require a Markdown-format page. Workaround: ' +
              'read the page with get_journal_page, convert the HTML to Markdown yourself, ' +
              'then call update_journal_page with mode "replace".',
            details: { reason: 'INCOMPATIBLE_FORMAT', pageFormat: currentFormat, mode },
          },
        };
      }
      if (mode === 'append') {
        nextMarkdown =
          currentMarkdown.length > 0
            ? `${currentMarkdown}${separator}${input.markdown}`
            : input.markdown;
      } else {
        nextMarkdown =
          currentMarkdown.length > 0
            ? `${input.markdown}${separator}${currentMarkdown}`
            : input.markdown;
      }
    }

    const rendered = renderMarkdown(nextMarkdown);
    let content = '';
    if (nextMarkdown.length > 0) {
      if (rendered === null) {
        warnings.push(
          'showdown markdown renderer was unavailable; text.content left empty — the page ' +
            'will render blank until a later update re-renders it.',
        );
      } else {
        content = rendered;
      }
    }
    changes['text.format'] = 2;
    changes['text.markdown'] = nextMarkdown;
    changes['text.content'] = content;
    changedFields.push('text');
  }

  if (changedFields.length === 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'No changes specified. Pass at least one of `name`, `sort`, `titleShow`, ' +
          '`titleLevel`, or `markdown`.',
        details: { reason: 'NO_CHANGES' },
      },
    };
  }

  try {
    await pg.update(changes);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'FOUNDRY_REJECTED',
        message: `Foundry rejected page update: ${e instanceof Error ? e.message : String(e)}`,
        details: { reason: 'UPDATE_THREW' },
      },
    };
  }

  const result: UpdateJournalPageOk = {
    ok: true,
    entryId: entry.id,
    pageId: pg.id,
    changedFields,
    mode: appliedMode,
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}
