/**
 * page.evaluate body that silences Foundry's persistent "no hardware
 * acceleration" warning. The headless Chromium has no GPU, so this
 * warning is guaranteed noise in every screenshot unless dismissed.
 *
 * Why DOM removal instead of the ui.notifications API: Foundry v14's
 * Notifications class exposes no enumerable notification store — no Map,
 * no active/queue arrays, only `remove(id) / has(id) / update(id) / clear`.
 * `remove(id)` needs an id we have no way to recover (the HW-accel warning
 * is fired by Foundry's own canvas init, not by us), and `clear()` would
 * wipe legitimate notifications too. The rendered `<li>` under
 * `#notifications` is the only place the warning is observable from our
 * side, so we match on its text and remove that node directly.
 *
 * The body is intentionally defensive: it never throws and silently does
 * nothing when the warning isn't present (GPU was available, or it has
 * already been dismissed on a prior call — this function is idempotent).
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers and outer closures are NOT available at runtime — every helper
 * is defined inline.
 */
export interface DismissHwAccelWarningResult {
  removed: number;
}

export function dismissHwAccelWarningBody(): DismissHwAccelWarningResult {
  let removed = 0;
  try {
    const nodes = document.querySelectorAll('#notifications li, #notifications .notification');
    nodes.forEach((node) => {
      const text = node.textContent ?? '';
      if (/hardware\s+acceleration/i.test(text)) {
        node.remove();
        removed++;
      }
    });
  } catch {
    /* never let a missing selector or DOM error abort startup */
  }
  return { removed };
}
