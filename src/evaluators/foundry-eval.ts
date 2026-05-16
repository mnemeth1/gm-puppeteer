/**
 * Body executed inside the headless Foundry client by `foundry_eval`.
 * Kept in a dedicated file per the page.evaluate convention so the
 * client-side JS payload is easy to review independently of the
 * server-side tool wiring.
 *
 * The function receives a user-supplied script string and returns a
 * structured result that round-trips through page.evaluate's JSON
 * serialization boundary.
 */
export type FoundryEvalResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; message: string; stack?: string } };

export async function foundryEvalBody(script: string): Promise<FoundryEvalResult> {
  try {
    const fn = new Function(`"use strict"; return (async () => { ${script} })()`);
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    const e = err as Error;
    const stack = e.stack;
    return stack === undefined
      ? { ok: false, error: { name: e.name ?? 'Error', message: e.message ?? String(err) } }
      : { ok: false, error: { name: e.name ?? 'Error', message: e.message ?? String(err), stack } };
  }
}
