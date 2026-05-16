/**
 * page.evaluate body for get_journal_page. Reads a single JournalEntryPage
 * and returns its full projected content.
 *
 * Per page type:
 *  - text: returns `{format, markdown?, content?}`. For format=2 (MARKDOWN)
 *    pages, `markdown` is the source of truth and `content` is the rendered
 *    HTML Foundry compiles at update-time. For format=1 (HTML) pages,
 *    `content` is the source and `markdown` is typically null. Both fields
 *    are surfaced when present so the caller can pick.
 *  - image: returns `{src, caption}`.
 *  - pdf: returns `{src}`.
 *  - video: returns `{src, controls, loop, autoplay, volume, timestamp,
 *    width, height}`.
 *
 * `ownership` returns the raw `{[userId|"default"]: number}` map; use
 * `list_journal_ownership` for a name-resolved view with INHERIT and
 * level-string semantics.
 *
 * Behavior confirmed by `probe-journal-phase1.mjs`:
 *  - On JournalEntry.create with format=2 + markdown, text.content stays
 *    null (Foundry does not auto-compile during the create path). On a
 *    subsequent page.update of text.markdown, Foundry DOES compile via
 *    the globally-available showdown library and populates text.content.
 *    Read tools therefore must tolerate `content: null` on freshly-
 *    created markdown pages and surface what's present without inferring.
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export interface GetJournalPageInput {
  entryId: string;
  pageId: string;
}

export interface JournalPageTextProjection {
  format: number;
  markdown: string | null;
  content: string | null;
}

export interface JournalPageImageProjection {
  src: string | null;
  caption: string | null;
}

export interface JournalPagePdfProjection {
  src: string | null;
}

export interface JournalPageVideoProjection {
  src: string | null;
  controls: boolean;
  loop: boolean;
  autoplay: boolean;
  volume: number;
  timestamp: number | null;
  width: number | null;
  height: number | null;
}

export interface JournalPageProjection {
  id: string;
  name: string;
  type: string;
  sort: number;
  title: {
    show: boolean;
    level: number;
  };
  text?: JournalPageTextProjection;
  image?: JournalPageImageProjection;
  pdf?: JournalPagePdfProjection;
  video?: JournalPageVideoProjection;
  ownership: Record<string, number>;
}

export interface GetJournalPageOk {
  ok: true;
  entry: { id: string; name: string };
  page: JournalPageProjection;
}

export interface GetJournalPageErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type GetJournalPageResult = GetJournalPageOk | GetJournalPageErr;

export function getJournalPageBody(input: GetJournalPageInput): GetJournalPageResult {
  interface FoundryPageTextLike {
    format?: number;
    markdown?: string | null;
    content?: string | null;
  }
  interface FoundryPageImageLike {
    caption?: string | null;
  }
  interface FoundryPageVideoLike {
    controls?: boolean;
    loop?: boolean;
    autoplay?: boolean;
    volume?: number;
    timestamp?: number | null;
    width?: number | null;
    height?: number | null;
  }
  interface FoundryPageTitleLike {
    show?: boolean;
    level?: number;
  }
  interface FoundryJournalPageLike {
    id?: string;
    name?: string;
    type?: string;
    sort?: number;
    src?: string | null;
    text?: FoundryPageTextLike | null;
    image?: FoundryPageImageLike | null;
    video?: FoundryPageVideoLike | null;
    title?: FoundryPageTitleLike | null;
    ownership?: Record<string, number> | null;
  }
  interface FoundryEmbeddedCollection {
    get(id: string): FoundryJournalPageLike | null | undefined;
  }
  interface FoundryJournalEntryLike {
    id?: string;
    name?: string;
    pages?: FoundryEmbeddedCollection | null;
  }
  interface FoundryGameForJournals {
    journal?: { get(id: string): FoundryJournalEntryLike | null | undefined };
  }

  const game = (globalThis as unknown as { game?: FoundryGameForJournals }).game;
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
        details: {
          reason: 'PAGE_NOT_FOUND',
          entryId: input.entryId,
          pageId: input.pageId,
        },
      },
    };
  }

  const projection: JournalPageProjection = {
    id: pg.id,
    name: typeof pg.name === 'string' ? pg.name : '',
    type: typeof pg.type === 'string' ? pg.type : '',
    sort: typeof pg.sort === 'number' ? pg.sort : 0,
    title: {
      show: pg.title?.show !== false,
      level: typeof pg.title?.level === 'number' ? pg.title.level : 1,
    },
    ownership: { ...(pg.ownership ?? {}) },
  };

  if (pg.type === 'text') {
    projection.text = {
      format: typeof pg.text?.format === 'number' ? pg.text.format : 1,
      markdown: typeof pg.text?.markdown === 'string' ? pg.text.markdown : null,
      content: typeof pg.text?.content === 'string' ? pg.text.content : null,
    };
  } else if (pg.type === 'image') {
    projection.image = {
      src: typeof pg.src === 'string' ? pg.src : null,
      caption: typeof pg.image?.caption === 'string' ? pg.image.caption : null,
    };
  } else if (pg.type === 'pdf') {
    projection.pdf = {
      src: typeof pg.src === 'string' ? pg.src : null,
    };
  } else if (pg.type === 'video') {
    projection.video = {
      src: typeof pg.src === 'string' ? pg.src : null,
      controls: pg.video?.controls !== false,
      loop: pg.video?.loop === true,
      autoplay: pg.video?.autoplay === true,
      volume: typeof pg.video?.volume === 'number' ? pg.video.volume : 0.5,
      timestamp: typeof pg.video?.timestamp === 'number' ? pg.video.timestamp : null,
      width: typeof pg.video?.width === 'number' ? pg.video.width : null,
      height: typeof pg.video?.height === 'number' ? pg.video.height : null,
    };
  }

  return {
    ok: true,
    entry: { id: entry.id, name: typeof entry.name === 'string' ? entry.name : '' },
    page: projection,
  };
}
