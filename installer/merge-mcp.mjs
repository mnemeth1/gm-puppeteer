#!/usr/bin/env node
/**
 * merge-mcp.mjs — safe MCP-client config writer for the gm-puppeteer installer.
 *
 * The Inno Setup installer bundles a Node runtime, so the wizard shells out to
 * this script (via `Exec`) instead of trying to parse/merge JSON in Pascal.
 * It adds or removes a single `gm-puppeteer` server entry in an MCP client's
 * config file, preserving every other key and writing a timestamped backup
 * first. A corrupt existing config is left untouched (the client is skipped).
 *
 * Usage:
 *   node merge-mcp.mjs --client <name> --config-path <file> --app-dir <dir> \
 *                      --action add|remove
 *
 *   --client       claude-desktop | claude-code | cursor | opencode
 *   --config-path  absolute path to the client's JSON config file
 *   --app-dir      gm-puppeteer install directory (holds node\, dist\, .env)
 *   --action       add (default) or remove
 *
 * Exit codes: 0 success (entry written / removed / already absent);
 *             2 bad arguments; 3 the existing config file is not valid JSON
 *             (left untouched); 1 any other failure.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SERVER_NAME = 'gm-puppeteer';

/** Clients whose servers live under a top-level `mcpServers` object. */
const MCP_SERVERS_CLIENTS = new Set(['claude-desktop', 'claude-code', 'cursor']);
/** Clients whose servers live under a top-level `mcp` object (OpenCode). */
const MCP_KEY_CLIENTS = new Set(['opencode']);

function parseArgs(argv) {
  const out = { action: 'add' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--client') out.client = value;
    else if (flag === '--config-path') out.configPath = value;
    else if (flag === '--app-dir') out.appDir = value;
    else if (flag === '--action') out.action = value;
    else continue;
    i += 1;
  }
  return out;
}

function fail(code, message) {
  process.stderr.write(`merge-mcp: ${message}\n`);
  process.exit(code);
}

/** Build the launch command for the bundled Node runtime + .env. */
function launchParts(appDir) {
  return {
    nodeExe: join(appDir, 'node', 'node.exe'),
    envArg: `--env-file=${join(appDir, '.env')}`,
    entry: join(appDir, 'dist', 'index.js'),
  };
}

/** The server entry in each client's expected shape. */
function buildEntry(client, appDir) {
  const { nodeExe, envArg, entry } = launchParts(appDir);
  if (MCP_KEY_CLIENTS.has(client)) {
    // OpenCode: array-form command, `type: "local"`.
    return { type: 'local', command: [nodeExe, envArg, entry], enabled: true };
  }
  // Claude Desktop / Claude Code / Cursor: separate command + args.
  return { command: nodeExe, args: [envArg, entry] };
}

/** Top-level key the client stores its servers under. */
function containerKey(client) {
  return MCP_KEY_CLIENTS.has(client) ? 'mcp' : 'mcpServers';
}

function readConfig(configPath) {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, 'utf8').trim();
  if (raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(3, `existing config is not a JSON object: ${configPath}`);
    }
    return parsed;
  } catch {
    fail(3, `existing config is not valid JSON, leaving it untouched: ${configPath}`);
  }
  return {};
}

function backup(configPath) {
  if (!existsSync(configPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${configPath}.${SERVER_NAME}-backup-${stamp}`;
  writeFileSync(backupPath, readFileSync(configPath));
  return backupPath;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.client || !args.configPath) {
    fail(2, 'missing --client or --config-path');
  }
  if (!MCP_SERVERS_CLIENTS.has(args.client) && !MCP_KEY_CLIENTS.has(args.client)) {
    fail(2, `unknown --client: ${args.client}`);
  }
  if (args.action === 'add' && !args.appDir) {
    fail(2, '--app-dir is required for --action add');
  }

  const key = containerKey(args.client);
  const config = readConfig(args.configPath);

  if (args.action === 'remove') {
    const container = config[key];
    if (!container || typeof container !== 'object' || !(SERVER_NAME in container)) {
      process.stderr.write(`merge-mcp: no ${SERVER_NAME} entry to remove\n`);
      process.exit(0);
    }
    const backupPath = backup(args.configPath);
    delete container[SERVER_NAME];
    writeFileSync(args.configPath, `${JSON.stringify(config, null, 2)}\n`);
    process.stderr.write(`merge-mcp: removed ${SERVER_NAME} (backup: ${backupPath})\n`);
    process.exit(0);
  }

  // action === 'add'
  if (!config[key] || typeof config[key] !== 'object' || Array.isArray(config[key])) {
    config[key] = {};
  }
  const backupPath = backup(args.configPath);
  config[key][SERVER_NAME] = buildEntry(args.client, args.appDir);

  mkdirSync(dirname(args.configPath), { recursive: true });
  writeFileSync(args.configPath, `${JSON.stringify(config, null, 2)}\n`);
  process.stderr.write(
    `merge-mcp: wrote ${SERVER_NAME} to ${args.configPath}` +
      (backupPath ? ` (backup: ${backupPath})` : ' (new file)') +
      '\n',
  );
  process.exit(0);
}

main();
