/**
 * Manual end-to-end exerciser for a single tool against the live world.
 *
 *   npm run build && node scripts/exercise-tool.mjs <toolName> [jsonArgs]
 *
 * Example:
 *   node scripts/exercise-tool.mjs foundry_eval '{"script":"return game.world.id;"}'
 *   node scripts/exercise-tool.mjs foundry_screenshot '{}'
 *   node scripts/exercise-tool.mjs get_current_scene '{}'
 *
 * Text content is printed to stdout. Image content is written to
 * debug-output/<toolName>-<timestamp>.png and the path is logged.
 *
 * Requires `npm run build` first — this imports compiled output from dist/.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const [, , toolName, argsJson] = process.argv;
if (!toolName) {
  console.error('usage: node scripts/exercise-tool.mjs <toolName> [jsonArgs]');
  process.exit(2);
}

const tool = tools.find((t) => t.name === toolName);
if (!tool) {
  console.error(`unknown tool: ${toolName}`);
  console.error(`available: ${tools.map((t) => t.name).join(', ')}`);
  process.exit(2);
}

const args = argsJson ? JSON.parse(argsJson) : {};
const parsedArgs = tool.inputSchema.safeParse(args);
if (!parsedArgs.success) {
  console.error('input validation failed:');
  console.error(JSON.stringify(parsedArgs.error.issues, null, 2));
  process.exit(2);
}

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

try {
  log.info({ tool: toolName, args }, 'logging in');
  await session.ensureStarted();

  log.info({ tool: toolName }, 'invoking tool');
  const t0 = Date.now();
  const content = await tool.handler(parsedArgs.data, { browser: session, log });
  const elapsedMs = Date.now() - t0;
  log.info({ tool: toolName, elapsedMs, blocks: content.length }, 'tool returned');

  await mkdir('debug-output', { recursive: true });
  for (const [i, block] of content.entries()) {
    if (block.type === 'text') {
      console.log(`--- block ${i} (text) ---`);
      try {
        console.log(JSON.stringify(JSON.parse(block.text), null, 2));
      } catch {
        console.log(block.text);
      }
    } else if (block.type === 'image') {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const ext = block.mimeType.split('/')[1] ?? 'bin';
      const path = `debug-output/${toolName}-${ts}.${ext}`;
      await writeFile(path, Buffer.from(block.data, 'base64'));
      console.log(
        `--- block ${i} (image, ${block.mimeType}, ${block.data.length} b64 chars) -> ${path}`,
      );
    } else {
      console.log(`--- block ${i} (unknown type) ---`);
      console.log(JSON.stringify(block, null, 2));
    }
  }
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'tool invocation failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch((err) => log.warn({ err: String(err) }, 'stop failed'));
}
