import pino from 'pino';
import type { Config } from './config.js';

export type Logger = pino.Logger;

/**
 * Build the project-wide logger.
 *
 * The destination is locked to **stderr (fd 2)**, not stdout. Stdout in
 * this process is owned exclusively by the MCP SDK's stdio transport for
 * JSON-RPC framing — any other write there breaks the protocol and
 * the connected MCP client will reject the server. See CLAUDE.md
 * "Conventions" for the project-wide rule.
 */
export function createLogger(config: Pick<Config, 'logLevel'>): Logger {
  return pino(
    {
      level: config.logLevel,
      base: { service: 'gm-puppeteer' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination({ fd: 2, sync: false }),
  );
}
