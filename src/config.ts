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
  allowEval: z.boolean(),
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

const parseCsv = (raw: string | undefined, fallback: string[]): string[] => {
  if (raw === undefined) return fallback;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Explicit empty string disables; an env var like "" or "   " returns [].
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
    warmPhase2Packs: parseCsv(env.WARM_PHASE2_PACKS, ['pf2e.pathfinder-monster-core']),
    allowEval: parseBool(env.ALLOW_EVAL, false),
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }

  return parsed.data;
}
