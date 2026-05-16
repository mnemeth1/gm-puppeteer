# GM-Puppeteer

**Hand your AI assistant the keys to your virtual tabletop — on Forge or
self-hosted.**

GM-Puppeteer is a powerful, module-free MCP server that lets your AI fully
control Foundry VTT v14 as a Game Master. It can build balanced encounters,
manage tokens, run the combat tracker, update journals, handle loot, apply
conditions, create scrolls and wands, and run deep Pathfinder 2e workflows —
all through natural language.

No modules required. Works on both local LAN and Forge-hosted worlds. Just give
it a GM account and let the AI do the busywork while you focus on running the
game.

**Under the hood:** an MCP server that launches a headless (or visible)
Chromium browser, logs into your Foundry world as a GM user, and exposes 62
typed tools over the Model Context Protocol. All actions run through real
Foundry APIs inside an authenticated GM session — giving it deep, reliable
control without any custom modules or v13 limitations.

The core toolset (scenes, tokens, journals, ownership, compendiums) works on
any game system. A specialized Pathfinder 2e layer adds powerful features like
condition management, encounter budgeting, scroll/wand creation, and creature
stat block handling.

## Tools

62 typed tools. The catalog below is grouped by area; the final group —
and `roll_check` / `request_check` — require the Pathfinder 2e system
loaded, the rest are Foundry-core.

### Scenes & canvas

- **`get_current_scene`** — typed metadata about the active scene.
- **`list_scenes`** — enumerate every scene in the world (id, name, active flag, folder).
- **`view_scene`** — repoint the headless GM's canvas at a different scene (GM-local; not broadcast).
- **`activate_scene`** — set a scene as the world-active scene (broadcasts to all clients).
- **`foundry_screenshot`** — capture the active scene canvas as a JPEG, with a screen↔canvas transform.

### Tokens

- **`get_scene_tokens`** — list tokens on a scene with ids, names, actor link, position, size, disposition.
- **`get_token_details`** — full-detail view of a single token: position, appearance, vision, light, bars.
- **`place_token_at_grid`** — place a token at grid coords `{i, j}` on the active scene.
- **`place_token_at_screen_pixel`** — place a token at a screenshot-pixel coord; auto-snaps on square grids.
- **`move_token`** — reposition an existing token via grid `{i, j}` or canvas `{x, y}` coords.
- **`delete_token`** — remove one or more tokens from a scene by token id.
- **`update_token`** — modify token name, disposition, hidden flag, display modes, and sight.

### Actors & inventory

- **`list_world_actors`** — enumerate every actor in the world (id, uuid, name, type, level, folder).
- **`create_actor_from_compendium`** — import a compendium actor into the world.
- **`get_actor_inventory`** — read-only list of an actor's physical inventory and currency.
- **`get_item_details`** — read-only full-detail view of any Foundry Item by UUID.
- **`add_item_to_actor`** — grant a physical item from a compendium source to an actor.
- **`remove_item_from_actor`** — delete an inventory item or decrement its quantity.
- **`update_item_quantity`** — set the absolute quantity of a physical item on an actor.
- **`update_item_uses`** — set the remaining charges/uses on an item (e.g. wand recharge).
- **`move_item_to_container`** — relocate a physical item between containers (or to/from root).
- **`transfer_item_between_actors`** — move a physical item (or container subtree) between actors.

### Combat

- **`start_combat`** — create (or return) the combat encounter for a scene; round 0.
- **`begin_combat`** — advance a scene's encounter to round 1 after initiative is rolled.
- **`end_combat`** — delete a scene's combat encounter (Foundry "End Combat"); idempotent.
- **`add_combatants`** — add scene tokens to the combat as combatants; partial success.
- **`remove_combatants`** — remove combatants from the combat by id; partial success.
- **`get_combat_state`** — read round, turn, started flag, and the ordered combatant list.

### Dice & checks

- **`roll_dice`** — evaluate a raw dice formula and post it to chat; optional NPC speaker, GM/blind visibility.
- **`roll_check`** — roll a non-PC actor's real statistic check via the PF2e pipeline and post the result (PF2e).
- **`request_check`** — post a whispered PF2e `@Check` inline button asking a player to roll for their PC (PF2e).

### Journals

- **`list_journals`** — enumerate world journal entries (id, name, folder, page count, ownership).
- **`get_journal_entry`** — table-of-contents view of one entry: per-page id/name/type/sort.
- **`get_journal_page`** — full content of one page (text, or image/pdf/video projection).
- **`search_journals`** — ranked full-text search across entry names, page names, and text bodies.
- **`create_journal_entry`** — create a new world journal entry.
- **`update_journal_entry`** — change an entry's name and/or folder.
- **`delete_journal_entry`** — delete an entry and all its pages.
- **`create_journal_page`** — append a Markdown text page to an entry.
- **`update_journal_page`** — edit a text page body (replace/append/prepend), name, sort, or title.
- **`delete_journal_page`** — delete a single page from an entry.
- **`show_journal_entry`** — broadcast an entry to connected players' screens.

### Ownership & users

- **`list_users`** — enumerate Foundry users in the world (id, name, role, isGM, active).
- **`list_actor_ownership`** — show per-actor ownership: `default` + per-user level.
- **`assign_actor_ownership`** — set a user's (or `default`) ownership level on an actor.
- **`remove_actor_ownership`** — clear a user's explicit ownership entry on an actor.
- **`list_journal_ownership`** — entry- and per-page ownership: `default` + per-user levels.
- **`assign_journal_ownership`** — set a user's (or `default`) ownership on an entry or page.
- **`remove_journal_ownership`** — clear a user's explicit ownership entry on an entry or page.

### Compendium

- **`search_compendium`** — name/structured-filter search across compendium packs.
- **`list_compendium_packs`** — enumerate compendium packs (id, label, system, document type).

### World & diagnostics

- **`get_world_info`** — top-level world metadata: world, system, Foundry version, active scene, user.
- **`foundry_eval`** — run arbitrary JS in the Foundry GM client; registered only when `ALLOW_EVAL` is set.

### Pathfinder 2e–specific

Require the PF2e system loaded on the world.

- **`get_creature_details`** — full stat-block view of any NPC, hazard, or familiar by UUID.
- **`get_actor_state`** — read-only projection of an actor's combat-relevant state.
- **`get_available_conditions`** — enumerate PF2e conditions with valued/unvalued status and caps.
- **`apply_condition`** — apply a PF2e condition to an actor (take-max semantics).
- **`remove_condition`** — decrement or remove a PF2e condition from an actor.
- **`set_condition_value`** — set a valued PF2e condition to an absolute value on an actor.
- **`create_scroll_or_wand`** — generate a spell-specific scroll or wand from a Spell UUID onto an actor.
- **`use_item`** — run the PF2e use pipeline for one consumable or equipment activation.
- **`calculate_encounter_budget`** — PF2e GMG XP budget, cost table, and mix skeletons for a party.

## Prerequisites

- **Node.js 24+** on the machine that runs the MCP server (the Foundry host).
- **Foundry VTT v14** with a world created and **launched and active**. The
  **Pathfinder 2e** system is required for the PF2e tool layer; the
  Foundry-core tools run without it.
- A **Gamemaster-role user** on the active world whose name matches
  `FOUNDRY_GM_USERNAME` (default `AI-GM`). The headless Chromium logs in
  as this user. It can have no password (set `FOUNDRY_GM_PASSWORD` empty) or a
  password you supply via config.
- An MCP-capable client to connect to the server.

The headless Chromium is downloaded by Puppeteer on `npm install`. On Linux it
needs a handful of shared libraries — if Chromium fails to launch, install the
usual headless-Chrome system dependencies for your distro.

## Install & build

```
git clone <repo-url> gm-puppeteer
cd gm-puppeteer
npm install
npm run build
```

This compiles TypeScript to `dist/`. The server entry point is
`dist/index.js`. Re-run `npm run build` after any source change.

## Configuration

All configuration comes from environment variables. Every variable has a safe
default except where noted; `.env.example` carries the full, commented list.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FOUNDRY_URL` | `http://localhost:30001` | URL the headless Chromium navigates to. |
| `FOUNDRY_GM_USERNAME` | `AI-GM` | GM user to log in as. **Must exist on the active world** with the Gamemaster role. |
| `FOUNDRY_GM_PASSWORD` | _(empty)_ | Password for that user; leave empty if the user has none. |
| `FOUNDRY_HEADLESS` | `true` | Run Chromium headless. Set `false` to watch the window while diagnosing login issues. |
| `FOUNDRY_LOGIN_TIMEOUT_MS` | `60000` | How long to wait for `game.ready` after submitting the join form. |
| `LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error`. All logs go to stderr. |
| `WARM_COMPENDIUM_ON_START` | `true` | Pre-warm Foundry's compendium index cache at startup (background; first tool call is not blocked). |
| `WARM_PHASE2_PACKS` | `pf2e.pathfinder-monster-core` | Comma-separated packs to fully warm for instant description search. Empty string disables phase 2. |
| `ALLOW_EVAL` | `false` | Register the `foundry_eval` tool — see below. |
| `FORGE_MODE` | `false` | Enable the Forge-hosted session flow — see [Forge-hosted Foundry](#forge-hosted-foundry). |
| `FORGE_PROFILE_DIR` | `.puppeteer-profile` | Chromium profile directory the Forge session is persisted in. Absolute path recommended. |
| `FORGE_MANUAL_LOGIN_TIMEOUT_MS` | `300000` | How long to wait for a human to finish the visible Forge login. |

### `ALLOW_EVAL` and the `foundry_eval` tool

`foundry_eval` runs **arbitrary JavaScript** inside the live Foundry GM
client. It is the deliberate escape hatch for probing APIs, diagnosing state,
and covering gaps not yet served by a typed tool — and it is invaluable during
development.

It is also a real risk on a server others connect to: Foundry-side content (a
journal entry, a chat message) that reaches a connected LLM could in principle
drive arbitrary execution. So it is **off by default** — when `ALLOW_EVAL` is
unset or `false`, `foundry_eval` is not registered and is invisible to the
client; every other tool is unaffected.

Set `ALLOW_EVAL=true` for your own development environment. Leave it off for
any shared or published deployment.

## Forge-hosted Foundry

By default GM-Puppeteer targets a **local/LAN Foundry** instance: it launches
headless Chromium and scripts Foundry's join form directly. Nothing in this
section applies — leave `FORGE_MODE` unset.

A **Forge-hosted** world (`forge-vtt.com`) sits behind a Forge account login —
OAuth, 2FA, or CAPTCHA — that cannot be scripted reliably. Set `FORGE_MODE=true`
to switch to a persisted-session flow:

1. **First run** — with no saved session, a **visible** Chromium window opens.
   Complete the Forge login by hand. When the world reaches `game.ready`, the
   window closes and the browser profile (cookies + localStorage) is saved to
   `FORGE_PROFILE_DIR`. The server then relaunches **headless** from that saved
   profile for the working session.
2. **Later runs** — the saved session is restored headlessly; no window opens.
   If only the Foundry world session lapsed (Forge account still valid), the
   join form is re-submitted headlessly using `FOUNDRY_GM_USERNAME` /
   `FOUNDRY_GM_PASSWORD`.
3. **Expired session** — if the saved session is no longer live, the visible
   login from step 1 repeats.

The LAN flow is completely unchanged when `FORGE_MODE` is `false` or unset.

**Set `FOUNDRY_URL` to the game URL — not the invitation link.** Use the real
game address, `https://<your-slug>.forge-vtt.com/game`. Do **not** use Forge's
one-shot player *invitation link* (`forge-vtt.com/invite/...`): it is a bootstrap
redirect, and re-visiting it as the authenticated game owner lands on the Forge
`/setup` screen instead of the world, which breaks the headless restore.

**Notes and caveats:**

- **A display is required for the first login.** `headless: false` cannot open
  a window on a server with no desktop. Do the initial login on a machine with
  a GUI (the project's WSL2 + WSLg dev box works), then copy the
  `FORGE_PROFILE_DIR` directory to the headless host.
- **`FORGE_PROFILE_DIR` holds a live session** — effectively a credential. Keep
  it gitignored (the default `.puppeteer-profile/` already is), restrict its
  file permissions, and never commit or copy it over an untrusted channel.
- Use an **absolute path** for `FORGE_PROFILE_DIR`; a relative path resolves
  against the server's working directory, which the MCP client controls.
- **One server instance per profile directory** — Chromium locks the profile,
  so two instances cannot share one `FORGE_PROFILE_DIR`.
- In Forge mode, `FOUNDRY_HEADLESS` controls only the restored/working session;
  the first-time login is always visible.
- `FORGE_MANUAL_LOGIN_TIMEOUT_MS` (default 5 min) bounds how long the server
  waits for the human login — raise it if 2FA takes longer.
- A Forge-hosted world boots more slowly than a LAN one (typically 20-40 s).
  The headless restore polls for the world to finish loading, bounded by
  `FOUNDRY_LOGIN_TIMEOUT_MS` (default 60 s) — raise that if a heavy world
  needs longer.

## Connecting an MCP client

GM-Puppeteer is a stdio MCP server: the client launches it as a child process
and talks JSON-RPC over stdin/stdout. Register it in your MCP client's server
configuration — consult your client's documentation for where that lives.

Most clients use the same JSON shape: an `mcpServers` map with one entry per
server, each giving a `command`, its `args`, and an optional `env` block. A
same-OS entry looks like:

```json
{
  "mcpServers": {
    "gm-puppeteer": {
      "command": "node",
      "args": ["/abs/path/to/gm-puppeteer/dist/index.js"],
      "env": {
        "FOUNDRY_URL": "http://localhost:30001",
        "FOUNDRY_GM_USERNAME": "AI-GM",
        "ALLOW_EVAL": "true"
      }
    }
  }
}
```

On this project's dev box the Foundry host is **WSL on Windows** while the MCP
client is a Windows application, so the server is launched through `wsl`:

```json
{
  "mcpServers": {
    "gm-puppeteer": {
      "command": "wsl",
      "args": [
        "--cd", "/home/<your-username>/projects/gm-puppeteer",
        "--", "node", "--env-file=.env", "dist/index.js"
      ]
    }
  }
}
```

### Passing configuration: use a `.env` file

Configuration reaches the server through environment variables. A Windows MCP
client's `env` block does **not** cross the `wsl --` boundary on its own — WSL
forwards only the variables named in `WSLENV`, so a bare `env` block arrives
empty at the Node process. (Verified on this dev box: `LOG_LEVEL` and
`ALLOW_EVAL` set in an `env` block produced no values inside WSL until each
name was added to `WSLENV`.)

The reliable path is a `.env` file, loaded by Node *inside* WSL where the
boundary is irrelevant. Copy `.env.example` to `.env` and fill it in; the
`--env-file=.env` flag in the launch config above tells Node to load it (there
is no automatic discovery, so the flag is required). `--env-file` is built into
Node 24; no extra dependency is needed. `.env` is gitignored — keep secrets
there, not in the committed client config.

If you would rather use the client's `env` block, you must also set `WSLENV`
to a colon-separated list of every variable name to forward — e.g.
`"WSLENV": "FOUNDRY_URL:FOUNDRY_GM_PASSWORD:ALLOW_EVAL"` alongside the
variables themselves. The `.env` file is simpler and less error-prone.

## First-launch checklist

1. The Foundry world is **launched and active** (not just installed).
2. A Gamemaster user matching `FOUNDRY_GM_USERNAME` **exists on that world**.
   This is the most common cause of a failed launch — Foundry shows no error,
   the login form just never completes.
3. `npm run build` has been run and `dist/index.js` exists.
4. The MCP entry is in your client's server config; restart the client so it
   picks up the change. The server should appear in the client's MCP list.
5. Smoke-test with the `get_world_info` tool — it returns world name, system,
   Foundry version, and the logged-in user. A correct response confirms login,
   the browser session, and the tool surface end to end.

If launch fails, set `FOUNDRY_HEADLESS=false` and `LOG_LEVEL=debug` to watch
the Chromium window and the login sequence.

## Development

- Test loop: edit → `npm run build` → restart the MCP server → verify.
- `npm test` runs the vitest suite; `npm run lint` / `npm run format`.
- `scripts/probe-*.mjs` are live-Foundry probes used to verify API shape
  before building a tool.

## License

See repository for license terms. PF2e rules content referenced by this
project is the property of Paizo Inc.
