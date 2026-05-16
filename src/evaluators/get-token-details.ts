/**
 * page.evaluate body for get_token_details. Resolves a single token document
 * by `tokenId` (scene-scoped) and projects the full configurable surface
 * — identity, position, appearance, vision, light, detection modes, bars,
 * v14-specific ring / turn marker / shape — for callers that need more than
 * the projection-narrow `get_scene_tokens` view.
 *
 * Stat-block / combat data does NOT belong here; that lives on the linked
 * actor and is owned by `get_actor_state` and `get_creature_details`. This
 * tool returns the token document only and surfaces `actorId` + `actorMissing`
 * so a caller can chain.
 *
 * Behavior nuances confirmed against Foundry v14.361 + PF2e 8.1.2 via
 * `scripts/probe-get-token-details.mjs` and `-supplemental.mjs`:
 *
 *  - **Live document vs `toObject()`.** PF2e re-derives some fields at
 *    runtime; `disposition` in particular diverges (e.g. linked Valeros
 *    shows `1` / friendly live but `-1` / hostile in the persisted
 *    `toObject()`). We read every field off the LIVE document so the
 *    projection reflects what is actually rendered. `includeRawDocument`
 *    surfaces `toObject()` for callers that want the persisted form.
 *
 *  - **Tint is a Foundry `Color` instance.** `texture.tint` is a class
 *    instance with `.css`, `.toString()`, and a numeric `.valueOf()`. We
 *    normalize via `.css` to a CSS hex string ('#ffffff'), with null for
 *    absent/unrecognized values. Raw `Color` would not survive the
 *    Puppeteer JSON round-trip cleanly without this normalization.
 *
 *  - **No top-level `mirrorX` / `mirrorY` in v14.** Mirroring is encoded
 *    via the sign of `texture.scaleX` / `texture.scaleY`; we expose the
 *    raw scale values and let callers infer.
 *
 *  - **v14 texture shape changed.** The fields are now
 *    `{src, scaleX, scaleY, anchorX, anchorY, fit, tint, alphaThreshold}`
 *    — no `offsetX` / `offsetY` / `rotation` as in earlier Foundry
 *    versions.
 *
 *  - **No top-level `img`.** The token document's image source lives
 *    only on `texture.src`. Callers should read that path.
 *
 *  - **v14 surprise fields surfaced.** `locked`, `movementAction`,
 *    `occludable`, `shape`, `ring`, `turnMarker` are projected because
 *    a GM-deputy is plausibly going to need to read or eventually
 *    update them. `attachments`, `auras`, `delta`, `depth`, `level` are
 *    deliberately omitted — runtime-only, rarely useful, or (in the
 *    case of `delta`) too heavy a payload for a projection. Callers
 *    that need them can pass `includeRawDocument: true`.
 *
 *  - **Orphaned-actor semantics.** When the linked actor has been
 *    deleted, Foundry returns `token.actor === null` while `token.actorId`
 *    retains the original id. We compute `actorMissing` as
 *    `typeof actorId === 'string' && token.actor == null`. The current
 *    probe world has no orphaned tokens; this is best-effort until
 *    a follow-up probe confirms the exact semantics in the
 *    actor-deleted state.
 *
 *  - **Scene resolution.** Mirrors `get_scene_tokens` / `move_token` /
 *    `delete_token`: explicit `sceneId` looked up via `game.scenes.get`,
 *    otherwise fall back to `game.scenes.active`. Missing scene resolves
 *    to `SCENE_NOT_FOUND`; absent active scene resolves to
 *    `NO_ACTIVE_SCENE`. Missing token within a resolved scene resolves
 *    to `TOKEN_NOT_FOUND`.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime — every
 * helper is defined inline.
 */

export interface GetTokenDetailsInput {
  tokenId: string;
  sceneId?: string;
  includeRawDocument?: boolean;
}

export interface TokenTextureProjection {
  src: string;
  scaleX: number;
  scaleY: number;
  anchorX: number;
  anchorY: number;
  fit: string;
  tint: string | null;
  alphaThreshold: number;
}

export interface TokenRingProjection {
  enabled: boolean;
  colors: { ring: string | null; background: string | null };
  effects: number;
  subject: { scale: number; texture: string | null };
}

export interface TokenTurnMarkerProjection {
  mode: number;
  animation: string | null;
  src: string | null;
  disposition: boolean;
}

export interface TokenSightProjection {
  enabled: boolean;
  range: number;
  angle: number;
  visionMode: string;
  color: string | null;
  brightness: number;
  saturation: number;
  contrast: number;
  attenuation: number;
}

export interface TokenLightAnimationProjection {
  type: string | null;
  speed: number;
  intensity: number;
  reverse: boolean;
}

export interface TokenLightProjection {
  bright: number;
  dim: number;
  angle: number;
  color: string | null;
  alpha: number;
  coloration: number;
  luminosity: number;
  saturation: number;
  contrast: number;
  shadows: number;
  attenuation: number;
  negative: boolean;
  priority: number;
  animation: TokenLightAnimationProjection;
  darkness: { min: number; max: number };
}

export interface TokenDetectionModeProjection {
  id: string;
  enabled: boolean;
  range: number;
}

export interface TokenDetails {
  // identity
  id: string;
  name: string;
  documentName: 'Token';

  // linkage
  actorId: string | null;
  actorLink: boolean;
  actorMissing: boolean;

  // position / size
  x: number;
  y: number;
  width: number;
  height: number;
  elevation: number;
  rotation: number;
  sort: number;
  shape: number;
  lockRotation: boolean;
  locked: boolean;
  movementAction: string;
  occludable: { radius: number };

  // visibility / disposition (live values, see JSDoc)
  disposition: number;
  hidden: boolean;
  displayName: number;
  displayBars: number;
  alpha: number;

  // appearance
  texture: TokenTextureProjection;
  ring: TokenRingProjection;
  turnMarker: TokenTurnMarkerProjection;

  // resource bars
  bar1: { attribute: string | null };
  bar2: { attribute: string | null };

  // vision
  sight: TokenSightProjection;

  // light emission
  light: TokenLightProjection;

  // detection modes (special senses)
  detectionModes: TokenDetectionModeProjection[];

  // escape hatch (opt-in)
  rawDocument?: Record<string, unknown>;
}

export type GetTokenDetailsErrCode = 'SCENE_NOT_FOUND' | 'NO_ACTIVE_SCENE' | 'TOKEN_NOT_FOUND';

export type GetTokenDetailsResult =
  | { ok: true; sceneId: string; token: TokenDetails }
  | {
      ok: false;
      error: {
        code: GetTokenDetailsErrCode;
        message: string;
        details?: Record<string, unknown>;
      };
    };

export function getTokenDetailsBody(input: GetTokenDetailsInput): GetTokenDetailsResult {
  interface FoundryColorLike {
    css?: unknown;
    toString?: () => string;
  }
  interface FoundryAnimationLike {
    type?: unknown;
    speed?: unknown;
    intensity?: unknown;
    reverse?: unknown;
  }
  interface FoundryTextureLike {
    src?: unknown;
    scaleX?: unknown;
    scaleY?: unknown;
    anchorX?: unknown;
    anchorY?: unknown;
    fit?: unknown;
    tint?: unknown;
    alphaThreshold?: unknown;
  }
  interface FoundryRingLike {
    enabled?: unknown;
    colors?: { ring?: unknown; background?: unknown };
    effects?: unknown;
    subject?: { scale?: unknown; texture?: unknown };
  }
  interface FoundryTurnMarkerLike {
    mode?: unknown;
    animation?: unknown;
    src?: unknown;
    disposition?: unknown;
  }
  interface FoundrySightLike {
    enabled?: unknown;
    range?: unknown;
    angle?: unknown;
    visionMode?: unknown;
    color?: unknown;
    brightness?: unknown;
    saturation?: unknown;
    contrast?: unknown;
    attenuation?: unknown;
  }
  interface FoundryLightLike {
    bright?: unknown;
    dim?: unknown;
    angle?: unknown;
    color?: unknown;
    alpha?: unknown;
    coloration?: unknown;
    luminosity?: unknown;
    saturation?: unknown;
    contrast?: unknown;
    shadows?: unknown;
    attenuation?: unknown;
    negative?: unknown;
    priority?: unknown;
    animation?: FoundryAnimationLike;
    darkness?: { min?: unknown; max?: unknown };
  }
  interface FoundryDetectionModeLike {
    id?: unknown;
    enabled?: unknown;
    range?: unknown;
  }
  interface FoundryBarLike {
    attribute?: unknown;
  }
  interface FoundryOccludableLike {
    radius?: unknown;
  }
  interface FoundryTokenLike {
    id?: unknown;
    name?: unknown;
    actorId?: unknown;
    actor?: unknown;
    actorLink?: unknown;
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
    elevation?: unknown;
    rotation?: unknown;
    sort?: unknown;
    shape?: unknown;
    lockRotation?: unknown;
    locked?: unknown;
    movementAction?: unknown;
    occludable?: FoundryOccludableLike;
    disposition?: unknown;
    hidden?: unknown;
    displayName?: unknown;
    displayBars?: unknown;
    alpha?: unknown;
    texture?: FoundryTextureLike;
    ring?: FoundryRingLike;
    turnMarker?: FoundryTurnMarkerLike;
    bar1?: FoundryBarLike;
    bar2?: FoundryBarLike;
    sight?: FoundrySightLike;
    light?: FoundryLightLike;
    detectionModes?: FoundryDetectionModeLike[];
    toObject?: () => Record<string, unknown>;
  }
  interface FoundryTokensCollection {
    get(id: string): FoundryTokenLike | undefined;
  }
  interface FoundrySceneLike {
    id?: string;
    tokens?: FoundryTokensCollection;
  }
  interface FoundryScenesLike {
    get(id: string): FoundrySceneLike | undefined;
    active?: FoundrySceneLike | null;
  }
  interface FoundryGameLike {
    scenes?: FoundryScenesLike;
  }

  const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const bool = (v: unknown): boolean => v === true;
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
  const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const colorCss = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
    const c = (v as FoundryColorLike).css;
    if (typeof c === 'string') return c;
    try {
      const s = (v as FoundryColorLike).toString?.();
      if (typeof s === 'string' && s.length > 0) return s;
    } catch {
      // fall through
    }
    return null;
  };

  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;

  let scene: FoundrySceneLike | null | undefined;
  if (input.sceneId !== undefined) {
    scene = game?.scenes?.get(input.sceneId);
    if (!scene) {
      return {
        ok: false,
        error: {
          code: 'SCENE_NOT_FOUND',
          message: `No scene with id "${input.sceneId}".`,
          details: { sceneId: input.sceneId },
        },
      };
    }
  } else {
    scene = game?.scenes?.active ?? null;
    if (!scene) {
      return {
        ok: false,
        error: {
          code: 'NO_ACTIVE_SCENE',
          message:
            'No active scene in this world, and no sceneId provided. ' +
            'Activate a scene in Foundry or pass sceneId explicitly.',
        },
      };
    }
  }

  const token = scene.tokens?.get(input.tokenId);
  if (!token) {
    return {
      ok: false,
      error: {
        code: 'TOKEN_NOT_FOUND',
        message: `No token with id "${input.tokenId}" on scene "${scene.id ?? ''}".`,
        details: { tokenId: input.tokenId, sceneId: scene.id ?? null },
      },
    };
  }

  const texture: TokenTextureProjection = {
    src: str(token.texture?.src),
    scaleX: num(token.texture?.scaleX, 1),
    scaleY: num(token.texture?.scaleY, 1),
    anchorX: num(token.texture?.anchorX, 0.5),
    anchorY: num(token.texture?.anchorY, 0.5),
    fit: str(token.texture?.fit, 'contain'),
    tint: colorCss(token.texture?.tint),
    alphaThreshold: num(token.texture?.alphaThreshold, 0),
  };

  const ring: TokenRingProjection = {
    enabled: bool(token.ring?.enabled),
    colors: {
      ring: colorCss(token.ring?.colors?.ring),
      background: colorCss(token.ring?.colors?.background),
    },
    effects: num(token.ring?.effects),
    subject: {
      scale: num(token.ring?.subject?.scale, 1),
      texture: strOrNull(token.ring?.subject?.texture),
    },
  };

  const turnMarker: TokenTurnMarkerProjection = {
    mode: num(token.turnMarker?.mode),
    animation: strOrNull(token.turnMarker?.animation),
    src: strOrNull(token.turnMarker?.src),
    disposition: bool(token.turnMarker?.disposition),
  };

  const sight: TokenSightProjection = {
    enabled: bool(token.sight?.enabled),
    range: num(token.sight?.range),
    angle: num(token.sight?.angle, 360),
    visionMode: str(token.sight?.visionMode, 'basic'),
    color: colorCss(token.sight?.color),
    brightness: num(token.sight?.brightness),
    saturation: num(token.sight?.saturation),
    contrast: num(token.sight?.contrast),
    attenuation: num(token.sight?.attenuation),
  };

  const light: TokenLightProjection = {
    bright: num(token.light?.bright),
    dim: num(token.light?.dim),
    angle: num(token.light?.angle, 360),
    color: colorCss(token.light?.color),
    alpha: num(token.light?.alpha, 0.5),
    coloration: num(token.light?.coloration, 1),
    luminosity: num(token.light?.luminosity, 0.5),
    saturation: num(token.light?.saturation),
    contrast: num(token.light?.contrast),
    shadows: num(token.light?.shadows),
    attenuation: num(token.light?.attenuation, 0.5),
    negative: bool(token.light?.negative),
    priority: num(token.light?.priority),
    animation: {
      type: strOrNull(token.light?.animation?.type),
      speed: num(token.light?.animation?.speed, 5),
      intensity: num(token.light?.animation?.intensity, 5),
      reverse: bool(token.light?.animation?.reverse),
    },
    darkness: {
      min: num(token.light?.darkness?.min, 0),
      max: num(token.light?.darkness?.max, 1),
    },
  };

  const detectionModes: TokenDetectionModeProjection[] = [];
  const rawModes = Array.isArray(token.detectionModes) ? token.detectionModes : [];
  for (const m of rawModes) {
    detectionModes.push({
      id: str(m?.id),
      enabled: bool(m?.enabled),
      range: num(m?.range),
    });
  }

  const actorId = typeof token.actorId === 'string' ? token.actorId : null;
  const actorMissing = actorId !== null && (token.actor === null || token.actor === undefined);

  const details: TokenDetails = {
    id: str(token.id),
    name: str(token.name),
    documentName: 'Token',

    actorId,
    actorLink: bool(token.actorLink),
    actorMissing,

    x: num(token.x),
    y: num(token.y),
    width: num(token.width, 1),
    height: num(token.height, 1),
    elevation: num(token.elevation),
    rotation: num(token.rotation),
    sort: num(token.sort),
    shape: num(token.shape),
    lockRotation: bool(token.lockRotation),
    locked: bool(token.locked),
    movementAction: str(token.movementAction, 'travel'),
    occludable: { radius: num(token.occludable?.radius) },

    disposition: num(token.disposition),
    hidden: bool(token.hidden),
    displayName: num(token.displayName),
    displayBars: num(token.displayBars),
    alpha: num(token.alpha, 1),

    texture,
    ring,
    turnMarker,

    bar1: { attribute: strOrNull(token.bar1?.attribute) },
    bar2: { attribute: strOrNull(token.bar2?.attribute) },

    sight,
    light,

    detectionModes,
  };

  if (input.includeRawDocument === true) {
    try {
      const raw = token.toObject?.();
      if (raw && typeof raw === 'object') {
        details.rawDocument = raw as Record<string, unknown>;
      }
    } catch {
      // best-effort; absent raw is acceptable
    }
  }

  return { ok: true, sceneId: scene.id ?? '', token: details };
}
