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
