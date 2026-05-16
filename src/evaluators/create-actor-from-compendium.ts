/**
 * page.evaluate body for create_actor_from_compendium. Resolves a
 * compendium Actor by UUID, round-trips it through `toObject()`, applies
 * the caller's name / actorLink / folder overrides, and creates the
 * world-side actor via `Actor.implementation.create()` (the PF2e-aware
 * subclass entry point in v14).
 *
 * Behavior nuances confirmed by scripts/probe-create-actor*.mjs against
 * Foundry v14.361 + PF2e 8.1.2:
 *  - `fromUuid` returns `null` for missing/malformed UUIDs (does not
 *    throw), so the null-check is the only error path we need.
 *  - The wrong-document-type check uses `documentName === 'Actor'`.
 *  - Deleting `_source._id` from the payload lets Foundry assign a fresh
 *    id; leaving it in risks an id collision if the same actor is
 *    imported twice.
 *  - For `character`-type actors, PF2e forces `prototypeToken.actorLink`
 *    to `true` at `_preCreate` regardless of the create payload. The
 *    returned `actorLink` field always reflects what PF2e actually
 *    stored, not what the caller requested.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline.
 */
export interface CreateActorFromCompendiumInput {
  uuid: string;
  name?: string;
  actorLink?: boolean;
  folder?: string;
}

export interface CreateActorFromCompendiumOk {
  ok: true;
  actorId: string;
  name: string;
  type: string;
  actorLink: boolean;
  prototypeTokenImg: string | null;
  prototypeTokenName: string;
  folder: string | null;
}

export interface CreateActorFromCompendiumErr {
  ok: false;
  error: {
    code: 'UUID_NOT_FOUND' | 'NOT_AN_ACTOR' | 'CREATE_FAILED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type CreateActorFromCompendiumResult =
  | CreateActorFromCompendiumOk
  | CreateActorFromCompendiumErr;

interface PrototypeTokenLike {
  name?: string;
  actorLink?: boolean;
  texture?: { src?: string | null };
  [k: string]: unknown;
}

interface ActorLikeSource {
  _id?: string;
  name?: string;
  type?: string;
  prototypeToken?: PrototypeTokenLike;
  folder?: string | null;
  [k: string]: unknown;
}

interface ActorDocLike {
  documentName?: string;
  id?: string;
  name?: string;
  type?: string;
  prototypeToken?: PrototypeTokenLike;
  folder?: { id?: string } | string | null;
  toObject(): ActorLikeSource;
}

declare function fromUuid(uuid: string): Promise<unknown>;
declare const Actor: {
  implementation: {
    create(data: ActorLikeSource): Promise<ActorDocLike>;
  };
};

export async function createActorFromCompendiumBody(
  input: CreateActorFromCompendiumInput,
): Promise<CreateActorFromCompendiumResult> {
  const source = (await fromUuid(input.uuid)) as ActorDocLike | null;
  if (!source) {
    return {
      ok: false,
      error: {
        code: 'UUID_NOT_FOUND',
        message: `fromUuid returned null for "${input.uuid}". The UUID is malformed, the pack is missing, or the document was deleted.`,
        details: { uuid: input.uuid },
      },
    };
  }

  if (source.documentName !== 'Actor') {
    return {
      ok: false,
      error: {
        code: 'NOT_AN_ACTOR',
        message: `UUID "${input.uuid}" resolved to a ${source.documentName ?? 'unknown'} document, not an Actor.`,
        details: { uuid: input.uuid, documentName: source.documentName ?? null },
      },
    };
  }

  const data = source.toObject();
  // Drop the source's _id so Foundry assigns a fresh one; otherwise re-importing
  // the same compendium actor would collide.
  delete data._id;

  // Name override + prototype-token name mirror.
  // (Anti-bug from the v13 bridge: a name override that didn't update the
  // prototype meant spawned tokens still hovered with the source creature's
  // name. We always mirror.)
  if (input.name !== undefined) {
    data.name = input.name;
    data.prototypeToken = {
      ...(data.prototypeToken ?? {}),
      name: input.name,
    };
  }

  // actorLink: explicit override wins over the heuristic at the payload
  // level. PF2e may still override for `character` at _preCreate (see
  // file header) — the returned value reflects what was actually stored.
  if (input.actorLink !== undefined) {
    data.prototypeToken = {
      ...(data.prototypeToken ?? {}),
      actorLink: input.actorLink,
    };
  } else {
    const heuristicLink = source.type === 'character';
    data.prototypeToken = {
      ...(data.prototypeToken ?? {}),
      actorLink: heuristicLink,
    };
  }

  if (input.folder !== undefined) {
    data.folder = input.folder;
  }

  let created: ActorDocLike;
  try {
    created = await Actor.implementation.create(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        code: 'CREATE_FAILED',
        message: `Actor.implementation.create() failed: ${message}`,
        details: { uuid: input.uuid },
      },
    };
  }

  if (!created || !created.id) {
    return {
      ok: false,
      error: {
        code: 'CREATE_FAILED',
        message: 'Actor.implementation.create() resolved without a created document.',
        details: { uuid: input.uuid },
      },
    };
  }

  const protoImgRaw = created.prototypeToken?.texture?.src;
  const folderField = created.folder;
  const folderId =
    folderField && typeof folderField === 'object'
      ? (folderField.id ?? null)
      : typeof folderField === 'string'
        ? folderField
        : null;

  return {
    ok: true,
    actorId: created.id,
    name: created.name ?? '',
    type: created.type ?? '',
    actorLink: created.prototypeToken?.actorLink === true,
    prototypeTokenImg: typeof protoImgRaw === 'string' ? protoImgRaw : null,
    prototypeTokenName: created.prototypeToken?.name ?? created.name ?? '',
    folder: folderId,
  };
}
