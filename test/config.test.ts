import { isAbsolute, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults when env is empty', () => {
    const cfg = loadConfig({});
    expect(cfg.foundryUrl).toBe('http://localhost:30001');
    expect(cfg.foundryGmUsername).toBe('AI-GM');
    expect(cfg.foundryGmPassword).toBe('');
    expect(cfg.foundryHeadless).toBe(true);
    expect(cfg.loginTimeoutMs).toBe(60_000);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.allowEval).toBe(false);
    expect(cfg.forgeMode).toBe(false);
    expect(cfg.forgeManualLoginTimeoutMs).toBe(300_000);
    expect(cfg.forgeWakeTimeoutMs).toBe(180_000);
    expect(isAbsolute(cfg.forgeProfileDir)).toBe(true);
    expect(cfg.forgeProfileDir.endsWith('.puppeteer-profile')).toBe(true);
  });

  it('parses FORGE_MODE as boolean, defaulting to false', () => {
    expect(loadConfig({}).forgeMode).toBe(false);
    expect(loadConfig({ FORGE_MODE: 'true' }).forgeMode).toBe(true);
    expect(loadConfig({ FORGE_MODE: '1' }).forgeMode).toBe(true);
    expect(loadConfig({ FORGE_MODE: 'yes' }).forgeMode).toBe(true);
    expect(loadConfig({ FORGE_MODE: 'false' }).forgeMode).toBe(false);
  });

  it('resolves FORGE_PROFILE_DIR to an absolute path', () => {
    // Build the input via resolve() so the literal is absolute on both POSIX
    // and Windows (a bare '/srv/...' gains a drive letter on Windows).
    const absolute = resolve('/srv/forge/session');
    const cfg = loadConfig({ FORGE_PROFILE_DIR: absolute });
    expect(cfg.forgeProfileDir).toBe(absolute);
    // A relative path is resolved against cwd.
    expect(isAbsolute(loadConfig({ FORGE_PROFILE_DIR: 'my-profile' }).forgeProfileDir)).toBe(true);
  });

  it('parses FORGE_MANUAL_LOGIN_TIMEOUT_MS as an integer', () => {
    expect(loadConfig({ FORGE_MANUAL_LOGIN_TIMEOUT_MS: '120000' }).forgeManualLoginTimeoutMs).toBe(
      120_000,
    );
    // Invalid values fall back to default rather than throwing.
    expect(loadConfig({ FORGE_MANUAL_LOGIN_TIMEOUT_MS: 'nope' }).forgeManualLoginTimeoutMs).toBe(
      300_000,
    );
  });

  it('parses FORGE_WAKE_TIMEOUT_MS as an integer', () => {
    expect(loadConfig({ FORGE_WAKE_TIMEOUT_MS: '240000' }).forgeWakeTimeoutMs).toBe(240_000);
    // Invalid values fall back to default rather than throwing.
    expect(loadConfig({ FORGE_WAKE_TIMEOUT_MS: 'nope' }).forgeWakeTimeoutMs).toBe(180_000);
  });

  it('parses ALLOW_EVAL as boolean, defaulting to false', () => {
    expect(loadConfig({}).allowEval).toBe(false);
    expect(loadConfig({ ALLOW_EVAL: 'true' }).allowEval).toBe(true);
    expect(loadConfig({ ALLOW_EVAL: '1' }).allowEval).toBe(true);
    expect(loadConfig({ ALLOW_EVAL: 'yes' }).allowEval).toBe(true);
    expect(loadConfig({ ALLOW_EVAL: 'false' }).allowEval).toBe(false);
    expect(loadConfig({ ALLOW_EVAL: '0' }).allowEval).toBe(false);
  });

  it('parses FOUNDRY_HEADLESS as boolean', () => {
    expect(loadConfig({ FOUNDRY_HEADLESS: 'false' }).foundryHeadless).toBe(false);
    expect(loadConfig({ FOUNDRY_HEADLESS: '0' }).foundryHeadless).toBe(false);
    expect(loadConfig({ FOUNDRY_HEADLESS: 'true' }).foundryHeadless).toBe(true);
    expect(loadConfig({ FOUNDRY_HEADLESS: 'yes' }).foundryHeadless).toBe(true);
  });

  it('reads custom GM username and password', () => {
    const cfg = loadConfig({
      FOUNDRY_GM_USERNAME: 'Human-GM',
      FOUNDRY_GM_PASSWORD: 'hunter2',
    });
    expect(cfg.foundryGmUsername).toBe('Human-GM');
    expect(cfg.foundryGmPassword).toBe('hunter2');
  });

  it('parses FOUNDRY_LOGIN_TIMEOUT_MS as an integer', () => {
    expect(loadConfig({ FOUNDRY_LOGIN_TIMEOUT_MS: '30000' }).loginTimeoutMs).toBe(30_000);
    // Invalid values fall back to default rather than throwing.
    expect(loadConfig({ FOUNDRY_LOGIN_TIMEOUT_MS: 'nope' }).loginTimeoutMs).toBe(60_000);
  });

  it('rejects an invalid log level', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'chatty' })).toThrow(/Invalid configuration/);
  });

  it('rejects a non-URL FOUNDRY_URL', () => {
    expect(() => loadConfig({ FOUNDRY_URL: 'not-a-url' })).toThrow(/Invalid configuration/);
  });
});
