/**
 * Body executed inside the headless Foundry client to confirm we're
 * logged in as the configured GM and report version metadata. Kept in
 * a dedicated file per the page.evaluate convention.
 *
 * Relies on Foundry's `game` global (v14). Returns null fields when a
 * value is unavailable rather than throwing so the caller can produce
 * a precise error message.
 */
export interface LoginVerifyResult {
  user: string | null;
  isGM: boolean;
  worldId: string | null;
  worldTitle: string | null;
  foundryVersion: string | null;
  systemId: string | null;
  systemVersion: string | null;
}

// Foundry's `game` global — typed loosely so we don't pull in
// @league-of-foundry-developers/foundry-vtt-types.
interface FoundryGame {
  user?: { name?: string; isGM?: boolean };
  world?: { id?: string; title?: string };
  system?: { id?: string; version?: string };
  version?: string;
  ready?: boolean;
}

export function loginVerifyBody(): LoginVerifyResult {
  const g = (globalThis as unknown as { game?: FoundryGame }).game;
  return {
    user: g?.user?.name ?? null,
    isGM: g?.user?.isGM === true,
    worldId: g?.world?.id ?? null,
    worldTitle: g?.world?.title ?? null,
    foundryVersion: g?.version ?? null,
    systemId: g?.system?.id ?? null,
    systemVersion: g?.system?.version ?? null,
  };
}
