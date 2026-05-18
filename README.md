# GM-Puppeteer

**Hand your AI assistant the keys to your virtual tabletop — on Forge or
self-hosted.**

GM-Puppeteer is a powerful, module-free MCP server that lets your AI fully
control Foundry VTT v14 as a Game Master. It can build balanced encounters,
manage tokens, run the combat tracker, update journals, handle loot, apply
conditions, and drive deep, system-aware workflows for both Pathfinder 2e and
D&D 5e — all through natural language.

No modules required. Works on both local LAN and Forge-hosted worlds. Just give
it a GM account and let the AI do the busywork while you focus on running the
game.

**Under the hood:** an MCP server that launches a headless (or visible)
Chromium browser, logs into your Foundry world as a GM user, and exposes 69
typed tools over the Model Context Protocol. All actions run through real
Foundry APIs inside an authenticated GM session — giving it deep, reliable
control without any custom modules or v13 limitations.

The core toolset (scenes, tokens, journals, ownership, compendiums) works on
any game system. On top of it sit two system-specific suites: a Pathfinder 2e
suite (condition management, encounter budgeting, scroll/wand creation,
inventory mutation, creature stat blocks) and a D&D 5e suite (compendium and
rules search, creature and item detail, inventory) — each tuned for its game
system.

## Download

> [!WARNING]
> The Windows installer is **not code-signed**. The first time you run it,
> Windows SmartScreen will show a blue **"Windows protected your PC"** screen —
> this is expected for any unsigned installer. To continue, click the small
> **More info** link, then press the **Run anyway** button that appears.

# ⬇️ [Download the latest Windows installer](https://github.com/mnemeth1/gm-puppeteer/releases/latest)

Grab the `gm-puppeteer-setup-*.exe` from the latest release: a self-contained,
per-user installer (~250–300 MB) that bundles its own Node runtime and Chromium
— no separate installs needed. See
[Install on Windows](#install-on-windows-installer) for what the setup wizard
walks you through.

## Tools

69 typed tools in three groups — a system-agnostic **core** plus a
**Pathfinder 2e** and a **D&D 5e** suite. The core works on any Foundry world;
each system suite expects its game system loaded and fails gracefully if
called on the wrong one. `foundry_eval` is registered only when `ALLOW_EVAL`
is set.

### Core tools

System-agnostic — these work on any Foundry VTT world regardless of game
system.

#### Scenes & canvas

- **`get_current_scene`** — typed metadata about the active scene.
- **`list_scenes`** — enumerate every scene in the world (id, name, active flag, folder).
- **`view_scene`** — repoint the headless GM's canvas at a different scene (GM-local; not broadcast).
- **`activate_scene`** — set a scene as the world-active scene (broadcasts to all clients).
- **`foundry_screenshot`** — capture the active scene canvas as a JPEG, with a screen↔canvas transform.

#### Tokens

- **`get_scene_tokens`** — list tokens on a scene with ids, names, actor link, position, size, disposition.
- **`get_token_details`** — full-detail view of a single token: position, appearance, vision, light, bars.
- **`place_token_at_grid`** — place a token at grid coords `{i, j}` on the active scene.
- **`place_token_at_screen_pixel`** — place a token at a screenshot-pixel coord; auto-snaps on square grids.
- **`move_token`** — reposition an existing token via grid `{i, j}` or canvas `{x, y}` coords.
- **`delete_token`** — remove one or more tokens from a scene by token id.
- **`update_token`** — modify token name, disposition, hidden flag, display modes, and sight.

#### Actors

- **`list_world_actors`** — enumerate every actor in the world (id, uuid, name, type, level, folder, active-scene presence).
- **`create_actor_from_compendium`** — import a compendium actor into the world.

#### Combat

- **`start_combat`** — create (or return) the combat encounter for a scene; round 0.
- **`begin_combat`** — advance a scene's encounter to round 1 after initiative is rolled.
- **`roll_npcs`** — roll initiative for every unrolled NPC combatant; PCs left for the GM.
- **`end_combat`** — delete a scene's combat encounter (Foundry "End Combat"); idempotent.
- **`add_combatants`** — add scene tokens to the combat as combatants; partial success.
- **`remove_combatants`** — remove combatants from the combat by id; partial success.
- **`get_combat_state`** — read round, turn, started flag, and the ordered combatant list.

#### Journals

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

#### Ownership & users

- **`list_users`** — enumerate Foundry users in the world (id, name, role, isGM, active, idle, idleSeconds).
- **`list_actor_ownership`** — show per-actor ownership: `default` + per-user level.
- **`assign_actor_ownership`** — set a user's (or `default`) ownership level on an actor.
- **`remove_actor_ownership`** — clear a user's explicit ownership entry on an actor.
- **`list_journal_ownership`** — entry- and per-page ownership: `default` + per-user levels.
- **`assign_journal_ownership`** — set a user's (or `default`) ownership on an entry or page.
- **`remove_journal_ownership`** — clear a user's explicit ownership entry on an entry or page.

#### Dice & chat

- **`roll_dice`** — evaluate a raw dice formula and post it to chat; optional NPC speaker, GM/blind visibility.
- **`get_chat_messages`** — read a window of the chat log; check/damage/activation cards parsed into structured form per system (PF2e and D&D 5e).
- **`post_chat_message`** — post a raw-HTML chat message; optional NPC speaker, public / GM-only / player-whisper.

#### Compendium, world & diagnostics

- **`list_compendium_packs`** — enumerate compendium packs (id, label, system, document type).
- **`get_world_info`** — top-level world metadata: world, system, Foundry version, active scene, user.
- **`foundry_eval`** — run arbitrary JS in the Foundry GM client; registered only when `ALLOW_EVAL` is set.

### Pathfinder 2e tools

Require the Pathfinder 2e system loaded on the world.

#### Creatures & state

- **`pf2e_get_creature_details`** — full stat-block view of any NPC, hazard, or familiar by UUID.
- **`pf2e_get_actor_state`** — read-only projection of an actor's combat-relevant state.

#### Inventory & items

- **`pf2e_get_actor_inventory`** — read-only list of an actor's physical inventory and currency.
- **`pf2e_get_item_details`** — read-only full-detail view of any Foundry Item by UUID.
- **`pf2e_add_item_to_actor`** — grant a physical item from a compendium source to an actor.
- **`pf2e_remove_item_from_actor`** — delete an inventory item or decrement its quantity.
- **`pf2e_update_item_quantity`** — set the absolute quantity of a physical item on an actor.
- **`pf2e_update_item_uses`** — set the remaining charges/uses on an item (e.g. wand recharge).
- **`pf2e_move_item_to_container`** — relocate a physical item between containers (or to/from root).
- **`pf2e_transfer_item_between_actors`** — move a physical item (or container subtree) between actors.

#### Conditions

- **`pf2e_get_available_conditions`** — enumerate PF2e conditions with valued/unvalued status and caps.
- **`pf2e_apply_condition`** — apply a PF2e condition to an actor (take-max semantics).
- **`pf2e_remove_condition`** — decrement or remove a PF2e condition from an actor.
- **`pf2e_set_condition_value`** — set a valued PF2e condition to an absolute value on an actor.

#### Checks

- **`pf2e_roll_check`** — roll a non-PC actor's real statistic check via the PF2e pipeline and post the result.
- **`pf2e_request_check`** — post a whispered full-sentence PF2e `@Check` prompt asking a player to roll for their PC.

#### Compendium & utilities

- **`pf2e_search_compendium`** — name/structured-filter search across compendium packs.
- **`pf2e_create_scroll_or_wand`** — generate a spell-specific scroll or wand from a Spell UUID onto an actor.
- **`pf2e_use_item`** — run the PF2e use pipeline for one consumable or equipment activation.
- **`pf2e_calculate_encounter_budget`** — PF2e GMG XP budget, cost table, and mix skeletons for a party.

### D&D 5e tools

Require the D&D 5e system loaded on the world.

#### Creatures & state

- **`dnd5e_get_creature_details`** — read-only D&D 5e NPC/vehicle stat block by UUID.
- **`dnd5e_get_actor_state`** — read-only projection of a D&D 5e actor's combat-relevant state.

#### Inventory & items

- **`dnd5e_get_actor_inventory`** — read-only list view of a D&D 5e actor's physical inventory plus currency.
- **`dnd5e_get_item_details`** — read-only full-detail view of any D&D 5e Item by UUID.
- **`dnd5e_add_item_to_actor`** — grant a physical compendium item (weapon, equipment, consumable, tool, loot, container) to a D&D 5e character or npc; handles quantity, container placement, identification, and stack-merging.
- **`dnd5e_remove_item_from_actor`** — remove an item from a D&D 5e character or npc, or decrement its quantity; deleting a container ejects its direct contents to the inventory root.
- **`dnd5e_update_item_quantity`** — set the absolute quantity of a physical item (weapon, equipment, consumable, tool, loot, container) on a D&D 5e character or npc.
- **`dnd5e_update_item_uses`** — set the remaining charges of a uses-tracking item (wand, staff, charged magic item, or feat/spell with limited activations) on a D&D 5e character or npc.
- **`dnd5e_move_item_to_container`** — relocate a physical item between containers, or to/from the inventory root, on a single D&D 5e character or npc; cycle-checked, with optional stack-merging at the destination.
- **`dnd5e_transfer_item_between_actors`** — move a physical item from one D&D 5e actor to another: full-stack transfer, partial-stack split, stack-merging into a matching destination stack, or full-cascade transfer of a container plus its nested contents.
- **`dnd5e_create_scroll`** — generate a D&D 5e spell-scroll consumable from a Spell UUID and place it on a character or npc; runs the dnd5e scroll factory, with optional upcast cast-level, quantity, container placement, and identification. Scroll-only — D&D 5e has no per-spell wand generation; grant finished named wands with `dnd5e_add_item_to_actor`.
- **`dnd5e_use_item`** — run the D&D 5e activity/use pipeline for a single item on a character or npc: posts the chat card and consumes charges or quantity (a potion heal, a wand charge, a weapon or feat activation), reporting before/after quantity and uses. Spell-scroll `cast` activities are rejected — casting a scroll through the API orphans a cached-spell document that corrupts world load, so cast scrolls from the Foundry UI instead.

#### Conditions

- **`dnd5e_get_available_conditions`** — enumerate every applyable D&D 5e status (condition, pseudo-condition, or plain status), with the valued flag, exhaustion cap, and a rules-reference UUID.
- **`dnd5e_apply_condition`** — apply a D&D 5e status to a character or npc; take-max exhaustion level, rider conditions surfaced as a cascade.
- **`dnd5e_remove_condition`** — remove a D&D 5e status from a character or npc, or decrement exhaustion by one level; rider conditions surfaced as a cascade.

#### Checks

- **`dnd5e_roll_check`** — roll a non-PC D&D 5e actor's real ability, skill, saving-throw, or tool check through the dnd5e roll pipeline and post the result; supply a DC for a success/failure outcome.
- **`dnd5e_request_check`** — post a whispered, clickable D&D 5e check button asking a player to roll an ability, skill, save, or tool check for their own character.

#### Encounters

- **`dnd5e_calculate_encounter_budget`** — compute a D&D 5e encounter XP budget for a party given per-character levels. Reads the world's rules edition live: 2024 (modern) rules return the three-tier low/moderate/high budget; 2014 (legacy) rules return the four-tier easy/medium/hard/deadly thresholds plus the encounter-size multiplier model. Returns the per-tier XP budgets, a CR-to-XP cost table with how many of each CR fit, and suggested creature-mix skeletons (solo boss, boss + minions, gang, horde, …).

#### Compendium & utilities

- **`dnd5e_search_compendium`** — name/structured-filter search across D&D 5e compendium packs, on the system's native Compendium Browser engine.
- **`dnd5e_search_rules`** — page-level full-text search across D&D 5e compendium rules-glossary journals.

## Prerequisites

- **Node.js 24+** on the machine that runs the MCP server (the Foundry host).
- **Foundry VTT v14** with a world created and **launched and active**. The
  core tools run on any game system; the Pathfinder 2e and D&D 5e tool suites
  each require their corresponding system loaded on the world.
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

## Install on Windows (installer)

For a non-developer Windows setup there is a self-contained installer — no
clone, no `npm`, no separate Node install. Download the latest
`gm-puppeteer-setup-*.exe` from the project's GitHub Releases and run it.

The installer:

- installs per-user to `%LOCALAPPDATA%\gm-puppeteer` (no administrator rights);
- bundles a Node 24 runtime, the prebuilt server, and its own Chromium, so it
  works fully offline once downloaded;
- collects every setting from the [Configuration](#configuration) table in a
  wizard and writes them to a `.env` in the install directory;
- detects Claude Desktop and Cursor, and can merge a `gm-puppeteer` MCP entry
  into the ones you tick (all unticked by default; a timestamped backup of
  each config is written first).

To reconfigure later, edit `%LOCALAPPDATA%\gm-puppeteer\.env` and restart your
MCP client — that one file is the single source of truth. The installer is
unsigned, so Windows SmartScreen will warn on first run ("More info" → "Run
anyway"). The installer is built by `.github/workflows/build-installer.yml`;
see [`installer/README.md`](installer/README.md) to build it locally.

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
| `WARM_COMPENDIUM_ON_START` | `true` | Pre-load compendium documents into Foundry's cache at startup (background; first tool call is not blocked). Set `false` to disable the warm entirely. |
| `WARM_DOC_BUDGET` | `1500` | Auto-mode document budget. The warm picks installed packs by type priority (JournalEntry → Actor → Item → RollTable), smallest first, until this many documents are warmed. `0` warms nothing. Raise it to warm more packs at the cost of a longer startup warm. |
| `WARM_PHASE2_PACKS` | _(empty)_ | Comma-separated pack collection ids to warm explicitly. When set, this overrides auto selection and `WARM_DOC_BUDGET` is ignored. Empty (the default) uses auto selection. |
| `ALLOW_EVAL` | `false` | Register the `foundry_eval` tool — see below. |
| `FORGE_MODE` | `false` | Enable the Forge-hosted session flow — see [Forge-hosted Foundry](#forge-hosted-foundry). |
| `FORGE_PROFILE_DIR` | `.puppeteer-profile` | Chromium profile directory the Forge session is persisted in. Absolute path recommended. |
| `FORGE_MANUAL_LOGIN_TIMEOUT_MS` | `300000` | How long to wait for a human to finish the visible Forge login. |
| `FORGE_WAKE_TIMEOUT_MS` | `180000` | How long to wait for a cold/idled Forge instance to wake when (re)connecting. A Forge world idled for inactivity can take well over the 60 s login timeout to come back. |

### `ALLOW_EVAL` and the `foundry_eval` tool

This is the most powerful feature in gm-puppeteer — the one that turns a smart
AI into a true AI Game Master with almost no limits.

When enabled, the `foundry_eval` tool lets the connected AI run any JavaScript
code it wants directly inside your live Foundry VTT GM session.

In plain English: if you ask the AI to do literally anything on the tabletop,
it can figure out how. It can create custom macros on the fly, tweak actor
data in ways no normal tool allows, hook into hidden Foundry APIs, build
complex multi-step automations, add temporary house rules, or solve edge cases
that nothing else can touch. A good AI model (Claude, Grok, GPT-4o, etc.)
basically has god-mode access to your entire Foundry world when this tool is
active.

That power is intentional — it's the escape hatch that makes gm-puppeteer
uniquely flexible. However, it is intentionally disabled by default for
safety. Because the AI can run arbitrary code, any Foundry content that
reaches the LLM (a journal entry, chat message, roll table result, etc.) could
in theory trigger execution. That's a real risk on any server where other
people (or untrusted AIs) might interact with it.

Be aware too that arbitrary, untested JavaScript run against a live world can
corrupt or brick the game world — a single bad mutation (an orphaned embedded
document, a malformed actor update) can leave the world un-loadable for every
client — so treat `foundry_eval` as a power tool on a real campaign, not a
scratchpad.

- When `ALLOW_EVAL` is unset or `false` → `foundry_eval` is completely hidden
  and unavailable. All other tools work normally.
- Set `ALLOW_EVAL=true` in your `.env` file only for your personal
  single-player setup or trusted development environment.

**Bottom line recommendation:**

- Leave it **OFF** for any shared server, public demo, or multi-user game.
- Turn it **ON** when you want the AI to have unlimited creative freedom for
  solo play or rapid prototyping.

This single toggle is what separates "helpful AI assistant" from "AI that can
genuinely run the entire game for you."

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
- **Idle recovery.** Forge idles an instance after a stretch with no
  mouse/keyboard activity in the Foundry tab. When a tool call arrives after
  such an idle, the server detects the dropped session and reconnects
  automatically — relaunching from `FORGE_PROFILE_DIR` and waking the
  instance — before running the tool. A cold wake can exceed the 60 s login
  timeout, so the reconnect (and the initial Forge restore) is bounded by
  `FORGE_WAKE_TIMEOUT_MS` (default 3 min) instead; raise it if your instance
  wakes slowly.

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

See repository for license terms. Pathfinder 2e content referenced by this
project is the property of Paizo Inc.; Dungeons & Dragons content is the
property of Wizards of the Coast.
