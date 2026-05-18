# GM-Puppeteer — AI agent installation guide

This file is written for an AI coding agent installing the GM-Puppeteer
MCP server on the user's behalf. Follow the steps in order. GM-Puppeteer
is a **stdio** MCP server: the MCP client launches it as a child process
and talks JSON-RPC over stdin/stdout.

## What you are installing

An MCP server that drives a headless Puppeteer-managed Chromium logged
into a Foundry VTT v14 world as a Gamemaster, exposing typed tools to
control scenes, tokens, journals, combat, ownership, and system-aware
Pathfinder 2e / D&D 5e workflows.

## Step 1 — Check prerequisites

Confirm each of these before installing. Stop and tell the user if one
is unmet — none can be worked around from the agent side.

- **Node.js 24+** on the machine that will run the server (the Foundry
  host). Verify with `node --version`.
- **Foundry VTT v14**, with a world **launched and active** — not just
  installed. The server logs into a running world.
- A **Gamemaster-role user** on that active world. Default name `AI-GM`;
  the user may have an empty password or one the user supplies. If it
  does not exist, ask the user to create it — this is the single most
  common cause of a silent launch failure.
- On Linux, the usual headless-Chrome shared libraries (Puppeteer
  downloads Chromium itself on `npm install`, but not the system libs).

## Step 2 — Clone and build

```bash
git clone https://github.com/mnemeth1/gm-puppeteer.git
cd gm-puppeteer
npm install
npm run build
```

`npm install` downloads the Chromium build Puppeteer uses. `npm run
build` compiles TypeScript to `dist/`; the server entry point is
`dist/index.js`. Both must succeed before continuing. Note the absolute
path to `dist/index.js` — the client config needs it.

## Step 3 — Configure

All configuration is environment variables; every one has a safe
default except where noted. The recommended path is a `.env` file that
Node loads inside the server's working directory:

```bash
cp .env.example .env
```

Then edit `.env`. The variables that usually need attention:

| Variable | Default | Set it when |
| --- | --- | --- |
| `FOUNDRY_URL` | `http://localhost:30001` | Foundry is not on the default local port. |
| `FOUNDRY_GM_USERNAME` | `AI-GM` | The GM user has a different name. |
| `FOUNDRY_GM_PASSWORD` | _(empty)_ | The GM user has a password. |
| `ALLOW_EVAL` | `false` | The user wants the `foundry_eval` escape hatch (solo/dev only — see below). |
| `FORGE_MODE` | `false` | The world is Forge-hosted (`forge-vtt.com`) — see below. |

`.env.example` documents every supported variable, including the
compendium-warm and Forge timeout knobs. `.env` is gitignored; keep
secrets there, not in the committed client config.

### `ALLOW_EVAL`

`ALLOW_EVAL=true` registers `foundry_eval`, which runs arbitrary
JavaScript inside the live Foundry GM session — powerful, but it can
brick a world and is a real risk on any shared server. Leave it `false`
unless the user explicitly asks for it and confirms a solo/trusted
setup. Do not enable it on your own initiative.

### Forge-hosted worlds

If the world is on `forge-vtt.com`, set `FORGE_MODE=true` and point
`FOUNDRY_URL` at the game URL (`https://<slug>.forge-vtt.com/game`) —
**not** a one-shot invitation link. Forge mode needs a one-time
**visible** browser login that a human must complete on a machine with a
display; you cannot automate it. Tell the user this is required on first
run and let them do it. See `README.md` → "Forge-hosted Foundry".

## Step 4 — Register with the MCP client

Add an entry to the client's `mcpServers` config. Use the absolute path
to the clone directory from Step 2 as `cwd`.

Standard (client and server on the same OS):

```json
{
  "mcpServers": {
    "gm-puppeteer": {
      "command": "node",
      "args": ["--env-file=.env", "dist/index.js"],
      "cwd": "/abs/path/to/gm-puppeteer"
    }
  }
}
```

`--env-file=.env` makes Node load the `.env` from Step 3 (Node 24 has it
built in; there is no automatic discovery, so the flag is required). Both
`--env-file=.env` and `dist/index.js` are relative paths — they resolve
against `cwd`, so the `cwd` entry is **required**. Set it to the absolute
path of the clone directory; without it the server starts in the client's
own working directory and fails to find `.env`.

If the MCP client runs on **Windows** while Foundry and this server run
in **WSL**, launch through `wsl` so the server runs inside WSL:

```json
{
  "mcpServers": {
    "gm-puppeteer": {
      "command": "wsl",
      "args": [
        "--cd", "/home/<user>/projects/gm-puppeteer",
        "--", "node", "--env-file=.env", "dist/index.js"
      ]
    }
  }
}
```

Across the `wsl --` boundary a client `env` block does **not** reach the
Node process (WSL forwards only `WSLENV`-named variables), so the `.env`
file is the reliable channel — use it rather than an `env` block.

## Step 5 — Verify

There are two distinct checkpoints. The first confirms the install; the
second needs a live Foundry world.

**Install succeeded** — verifiable with no Foundry running:

1. Restart the MCP client so it picks up the new server.
2. Confirm `gm-puppeteer` appears in the client's MCP server list,
   **connected**, with its tools listed. The server completes the MCP
   handshake without contacting Foundry — it connects to Foundry lazily,
   on the first tool call — so a connected server with visible tools
   means the install itself is done. Stop here if Foundry is not running.

**Live-world smoke test** — the user's final check once Foundry is up:

3. With a Foundry world launched and active (Step 1), call the
   **`get_world_info`** tool. A successful response — world name, system,
   Foundry version, logged-in user — confirms login, the browser session,
   and the tool surface end to end. Until a world is running this call is
   expected to fail; that is not an install failure.

If `get_world_info` fails with a world running, set
`FOUNDRY_HEADLESS=false` and `LOG_LEVEL=debug` in `.env` and restart to
watch the Chromium window and login sequence. The usual cause is a
missing or misnamed GM user (Step 1).

## Reference

`README.md` carries the full tool catalog, the complete configuration
table, and the detailed Forge-hosted setup flow.
