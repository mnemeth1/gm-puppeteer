# GM-Puppeteer — development guide

An MCP server that drives a headless Puppeteer-managed Chromium logged
into Foundry VTT v14 as a Gamemaster user, exposing typed tools over
MCP/stdio. The **core** tool suite is system-agnostic; the `pf2e_` and
`dnd5e_` suites each target one game system — the prefix names the
system that tool expects, and the live world's system is whatever
`get_world_info` reports.

See `@README.md` for the full tool catalog, installation, configuration,
and the Forge-hosted setup flow. This file covers development only.

## Architecture

Intentionally simple: **no custom Foundry module, no v13 compatibility.**
All Foundry-side work runs through `page.evaluate` against a Chromium tab
authenticated as the GM user.

`src/` layout:

- `index.ts` — process entry point.
- `server.ts` — MCP server setup and tool registration.
- `config.ts` — environment-variable configuration.
- `logging.ts` — Pino logger (stderr-only).
- `browser/session.ts` — Puppeteer session; dispatches `launchLocal()`
  vs. `launchForge()`.
- `evaluators/<tool>.ts` — one file per tool: the `page.evaluate` body
  that runs inside Foundry.
- `tools/<tool>.ts` — one file per tool: its Zod input schema and the
  handler that calls the evaluator.

Tools come in parallel `pf2e_`/`dnd5e_` families plus the core suite.

## Build & test

- `npm run build` — TypeScript → `dist/`. The entry point is
  `dist/index.js`. Re-run after every source change.
- `npm test` — vitest suite. `npm run lint`, `npm run format`.
- Dev loop: edit → `npm run build` → restart the MCP server → verify
  against a live world.
- `scripts/probe-*.mjs` are live-Foundry probes used to verify API shape
  before building a tool.

Conventions: Node 24, TypeScript strict. Tool names `snake_case`, TS
symbols `camelCase`, files `kebab-case`. Every `page.evaluate` body lives
in its own evaluator file, never inline in tool registration. All tools
return structured JSON. On Linux, Puppeteer's bundled Chromium needs the
usual headless-Chrome shared libraries installed.

## Adding a tool

Create the pair — an evaluator (`src/evaluators/<tool>.ts`) and a Zod
schema + handler (`src/tools/<tool>.ts`) — register it in `server.ts`,
and add a one-line description to `README.md` (the user-facing tool
catalog). Deep behavioral notes (return shape, error semantics,
surprising defaults) belong in JSDoc on the evaluator file.

## Critical implementation rules

These cause silent failures — a bad build, a wedged client, or a
corrupted world — not compile errors.

- **Stdout is sacred.** MCP servers must log to stderr only — stdout
  carries JSON-RPC. No `console.log` / `console.info` /
  `process.stdout.write` in `src/`; use the injected `Logger`, or
  `console.error` (Node routes it to stderr). Any stdout write breaks the
  stdio transport and the client rejects the server.

- **Evaluator bodies have no outer scope.** Anything an evaluator
  function references — constants, helpers, regexes — must be declared
  *inside* the function body. Puppeteer serializes the function to source
  and ships it to the browser context; module scope is not part of that
  payload, so a module-scope reference is a runtime `ReferenceError`, not
  a compile error. TypeScript will not warn you; the probe step catches
  it. Identifiers used only by the tool wrapper (after `page.evaluate`
  returns) may live at module scope freely.

- **A tool's top-level `inputSchema` must be `type: "object"`.** The MCP
  client rejects the entire `tools/list` response if any outer schema
  isn't an object — one bad tool makes every tool unreachable.
  `z.discriminatedUnion`/`z.union` emit a top-level `anyOf` with no
  `type` and trip this. Use a single `z.object({...}).strict()` and
  enforce field combinations with `.superRefine`. Inner properties may be
  unions; only the outer schema must be an object.

- **D&D 5e `system.uses` stores `spent`, derives `value`.** 5e charge
  tracking stores `{spent, max, recovery, autoDestroy}`; `uses.value`
  (remaining) is a derived getter and cannot be written. To set remaining
  charges, write `system.uses.spent` (`max − desired`) via
  `updateEmbeddedDocuments`.

## Workflow principles

- **Probe before designing.** Before building a tool that depends on
  Foundry or game-system API behavior, write a `scripts/probe-*.mjs` that
  runs against live Foundry to verify API shape, return values, and edge
  cases. Delete speculative defensive branches once a probe answers the
  question.

- **Typed tools over eval, but eval is first-class.** `foundry_eval` is
  the deliberate escape hatch for probing, diagnostics, and capability
  gaps — not a workaround. Every recurring eval pattern is a tool
  candidate.

- **Compose primitives; do not conflate.** One tool, one job. Resist
  convenience parameters that bundle separate concerns into one call; an
  extra round-trip from the caller is fine.

- **Visual verification follows token placement.** Grid coordinates are
  deterministic within a scene but not portable across scenes with
  different padding. After placing or moving tokens on a new scene, call
  `foundry_screenshot` and check the result.

- **Probe discipline for state-mutating tools.** Probes of mutating tools
  must restore world state exactly, not just by count: snapshot affected
  documents at start, restore at end, then assert. For destructive tools,
  snapshot full `toObject()` payloads so teardown can recreate what was
  deleted. For use/activity/roll-pipeline tools, do all probe work on a
  *disposable* actor (teardown is `actor.delete()`, which removes
  unnamed side-effect documents too), put teardown in a `finally`, and
  race every handler call against a timeout — a wedged call hangs the
  headless client, and an orphaned embedded document can brick the world.

- **Validate relational-field mutations in the tool.** Foundry enforces
  storage-layer schema invariants but not graph-shape ones — it accepts
  `containerId` cycles of depth 2+ and accepts a non-container target.
  Any tool mutating a relational field must do its own cycle-walk and
  target-type check.

- **Rules-text lookups are per-system.** PF2e rules text comes from
  Archives of Nethys (`2e.aonprd.com`) via web-fetch; D&D 5e rules text
  comes from `dnd5e_search_rules`. Compendium *content* search
  (`*_search_compendium`) is for world content — stat blocks, items,
  monsters — not rules text.

- **Client guidance lives in tool descriptions/output, not this file.**
  An MCP client connecting over stdio never sees CLAUDE.md — its only
  surfaces are tool schemas/descriptions and returned JSON. To steer
  client behavior, surface the deciding signal as an output field and
  state the rule in the tool's `description` or a parameter `.describe()`.

## Foundry v14 facts

- **Grid orientation.** `i` = row (increases south), `j` = column
  (increases east). A token's `x,y` is the top-left of its bounding box.
- **Wall collision.** Use `ClockwiseSweepPolygon.testCollision({x,y},
  {x,y}, {type:'move', mode:'any'})`. `canvas.walls.checkCollision` does
  not exist.
- **`actorLink` override.** PF2e forces `actorLink: true` on character
  actors at `_preCreate` regardless of payload — a document-layer
  override.
- **Damage pipeline.** Use `actor.applyDamage({damage, token, ...})`, not
  `actor.update({'system.attributes.hp.value': N})`. The pipeline handles
  resistances, weaknesses, persistent damage, shield block, and the chat
  audit trail.
- **Strike dialog bypass.** `{event: new MouseEvent('click', {shiftKey:
  true})}` skips PF2e's roll-config dialog.

## Hard do-NOTs

- **Don't re-enable UPnP** in Foundry options — it exposes the server to
  the public internet.
- **Don't write HP directly** via `actor.update`. Use
  `actor.applyDamage()` so the game-system pipeline runs.

## Releases

`.github/workflows/build-installer.yml` builds the Windows installer. It
runs on **manual dispatch** (uploads a workflow artifact only) or on a
**`v*` tag push** (also publishes a GitHub Release with the `.exe`
attached). Ordinary pushes to `main` do not trigger a build — keep
per-push build jobs out, since the installer artifacts are large.

Two Inno Setup traps surface only in CI (ISCC does not run in the local
dev loop):

- **No line-start `#`** in `.iss`/`.pas` files — ISPP treats the first
  non-whitespace `#` as a directive. Lead continuation lines with `+` or
  a string literal.
- **`{ }` comments don't nest** — a `{...}` token (e.g. `{app}`) inside a
  `{ }` comment closes it early and the rest of the line compiles as
  code. Use `(* *)` comments or avoid brace tokens in comment prose.
