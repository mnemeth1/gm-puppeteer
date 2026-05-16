#!/usr/bin/env node
import { BrowserSession } from './browser/session.js';
import { loadConfig } from './config.js';
import { createLogger } from './logging.js';
import { createServer, runStdio } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config);
  const browser = new BrowserSession(config, log);
  const server = createServer(browser, log, config);

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    await browser.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  log.info('mcp server starting on stdio');
  await runStdio(server);
}

main().catch((err: unknown) => {
  console.error('fatal:', err);
  process.exit(1);
});
