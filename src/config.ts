import { resolve } from 'node:path';
import { z } from 'zod';

const ConfigSchema = z.object({
  foundryUrl: z.string().url(),
  foundryGmUsername: z.string().min(1),
  foundryGmPassword: z.string(),
  foundryHeadless: z.boolean(),
  loginTimeoutMs: z.number().int().positive(),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']),
  warmCompendiumOnStart: z.boolean(),
  warmPhase2Packs: z.array(z.string()),
  warmDocBudget: z.number().int().nonnegative(),
  allowEval: z.boolean(),
  forgeMode: z.boolean(),
  forgeProfileDir: z.string().min(1),
  forgeManualLoginTimeoutMs: z.number().int().positive(),
  forgeWakeTimeoutMs: z.number().int().positive(),
});

export type Config = z.infer<typeof ConfigSchema>;

const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};

const parseInt32 = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Like parseInt32 but accepts 0 (used where 0 is a meaningful value, e.g. a
// warm budget of 0 means "warm nothing").
const parseNonNegInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const parseCsv = (raw: string | undefined, fallback: string[]): string[] => {
  if (raw === undefined) return fallback;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // An empty / whitespace-only env var returns [] — for WARM_PHASE2_PACKS
  // that means "no explicit override, use auto pack selection".
  return parts;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    foundryUrl: env.FOUNDRY_URL ?? 'http://localhost:30001',
    foundryGmUsername: env.FOUNDRY_GM_USERNAME ?? 'AI-GM',
    foundryGmPassword: env.FOUNDRY_GM_PASSWORD ?? '',
    foundryHeadless: parseBool(env.FOUNDRY_HEADLESS, true),
    loginTimeoutMs: parseInt32(env.FOUNDRY_LOGIN_TIMEOUT_MS, 60_000),
    logLevel: (env.LOG_LEVEL ?? 'info') as Config['logLevel'],
    warmCompendiumOnStart: parseBool(env.WARM_COMPENDIUM_ON_START, true),
    warmPhase2Packs: parseCsv(env.WARM_PHASE2_PACKS, []),
    warmDocBudget: parseNonNegInt(env.WARM_DOC_BUDGET, 1500),
    allowEval: parseBool(env.ALLOW_EVAL, false),
    forgeMode: parseBool(env.FORGE_MODE, false),
    // Resolved to an absolute path: the MCP server's cwd is set by the
    // launching client and is not guaranteed to be the project directory.
    forgeProfileDir: resolve(env.FORGE_PROFILE_DIR ?? '.puppeteer-profile'),
    forgeManualLoginTimeoutMs: parseInt32(env.FORGE_MANUAL_LOGIN_TIMEOUT_MS, 300_000),
    // A Forge instance idled for inactivity can take well over the 60s
    // login timeout to wake from cold when a tool call reconnects to it.
    forgeWakeTimeoutMs: parseInt32(env.FORGE_WAKE_TIMEOUT_MS, 180_000),
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }

  return parsed.data;
}
