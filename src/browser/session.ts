import type { Browser, Page } from 'puppeteer';
import puppeteer from 'puppeteer';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { ToolError } from '../errors.js';
import {
  dismissHwAccelWarningBody,
  type DismissHwAccelWarningResult,
} from '../evaluators/dismiss-hw-accel-warning.js';
import { loginVerifyBody, type LoginVerifyResult } from '../evaluators/login-verify.js';
import type { Logger } from '../logging.js';
import { startCompendiumWarm } from './warm-compendium-cache.js';

export interface FoundrySession {
  readonly page: Page;
  readonly browser: Browser;
  readonly verify: LoginVerifyResult;
}

type Screen = 'join' | 'setup' | 'in-game' | 'unknown';

const SELECTOR_USER_SELECT = 'select[name="userid"]';
const SELECTOR_PASSWORD = '#join-game-form input[name="password"]';
const SELECTOR_JOIN_SUBMIT = '#join-game-form button[name="join"]';

const VIEWPORT = { width: 1920, height: 1080 } as const;

// The sandbox-disabling flags are a Linux/WSL workaround (no user namespaces
// in the dev/CI containers) and a security downgrade we do not want on the
// bundled-Chromium Windows installer build, where the sandbox works fine.
// `--enable-unsafe-swiftshader` is needed on every platform: software WebGL
// is what lets Foundry's PIXI canvas render headless.
const CHROME_LAUNCH_ARGS = [
  ...(process.platform === 'win32' ? [] : ['--no-sandbox', '--disable-setuid-sandbox']),
  '--enable-unsafe-swiftshader',
] as const;

const DEBUG_DIR = 'debug-output';

// A gap longer than this since the last tool call means the cached session
// may have gone stale while idle (e.g. a Forge-hosted world idled its
// instance for inactivity); probe Foundry for liveness before trusting the
// cached page on the next call.
const STALE_PROBE_THRESHOLD_MS = 60_000;

// While polling for a screen to stabilize, reload the page once after this
// long — Forge sometimes serves its "waking up" interstitial without
// auto-redirecting into the game once the instance is back up.
const SCREEN_RELOAD_NUDGE_MS = 30_000;

/**
 * Owns the Chromium browser and its single Foundry page.
 *
 * Startup is lazy and one-shot: the MCP server can register and advertise
 * tools before a browser launch, and the first tool call that needs the
 * page triggers `ensureStarted()`. Concurrent first-callers all await the
 * same in-flight launch promise so we never double-launch.
 *
 * Two launch paths, selected by `config.forgeMode`:
 *
 * LAN mode (`forgeMode === false`, default) — `launchLocal()`:
 *   1. Launch Chromium + open page at FOUNDRY_URL.
 *   2. Detect which Foundry screen we landed on (setup / join / in-game).
 *   3. On the join screen, select FOUNDRY_GM_USERNAME, fill password,
 *      click Join, wait for `game.ready === true`.
 *   4. Verify the logged-in user is the configured GM and isGM=true.
 *
 * Forge mode (`forgeMode === true`) — `launchForge()`:
 *   A Forge-hosted world sits behind a Forge account login (OAuth / 2FA /
 *   CAPTCHA) that cannot be scripted. The session is persisted in a
 *   Chromium profile directory (`config.forgeProfileDir`):
 *   1. If a saved profile exists, try a headless restore from it.
 *   2. If there is no live session, open a visible window so a human can
 *      complete the Forge login once; the profile is saved on close.
 *   3. Relaunch headless from the now-saved profile for the working session.
 *
 * On any login failure, screenshots and a DOM dump are written to
 * `debug-output/` to aid diagnosis without re-running.
 */
export class BrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private verify: LoginVerifyResult | null = null;
  private starting: Promise<void> | null = null;
  /** Timestamp of the last tool call that reached `ensureStarted()`. */
  private lastActivityAt = 0;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  /**
   * Return the live Foundry session, launching or reconnecting as needed.
   *
   * Fast path: when the cached session is synchronously alive and a tool
   * call ran recently, it is returned untouched — no round-trip to the page.
   *
   * After an idle gap the session may have gone stale: a Forge-hosted world
   * idles its instance after inactivity, dropping Foundry's socket while the
   * Chromium tab stays open. Recovery is funnelled through the `starting`
   * guard so an N-way concurrent death triggers exactly one teardown +
   * relaunch and every caller awaits it.
   */
  async ensureStarted(): Promise<FoundrySession> {
    if (this.sessionLooksAlive() && !this.isStale()) {
      this.lastActivityAt = Date.now();
      return this.currentSession();
    }
    if (!this.starting) {
      this.starting = this.ensureLive().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
    if (!this.sessionLooksAlive()) {
      throw new ToolError('BROWSER_NOT_READY', 'Browser failed to start or reconnect');
    }
    this.lastActivityAt = Date.now();
    return this.currentSession();
  }

  /**
   * Bring the session to a verified-live state: launch it if it has never
   * started or is hard-dead, or — when it is synchronously alive but stale —
   * probe Foundry and reconnect only if the probe fails. Single-flighted
   * behind the `starting` guard by `ensureStarted()`.
   */
  private async ensureLive(): Promise<void> {
    if (!this.sessionLooksAlive()) {
      // Never started, or the Chromium process / tab died outright.
      await this.teardownStaleSession();
      await this.launchAndLogin();
      return;
    }
    // Synchronously alive but idle long enough to have gone stale. A Forge
    // idle is a soft death — `browser.connected` and the tab both survive,
    // only Foundry's socket drops — so only a live probe can tell.
    if (await this.probeGameReady()) return;
    this.log.warn('session probe failed after idle; reconnecting');
    await this.teardownStaleSession();
    await this.launchAndLogin();
  }

  /** Synchronous, zero-cost liveness check — catches a dead Chromium process or tab. */
  private sessionLooksAlive(): boolean {
    return (
      this.browser !== null &&
      this.page !== null &&
      this.verify !== null &&
      this.browser.connected &&
      !this.page.isClosed()
    );
  }

  /** True when no tool call has run recently, so the cached session may be stale. */
  private isStale(): boolean {
    return Date.now() - this.lastActivityAt > STALE_PROBE_THRESHOLD_MS;
  }

  /** Non-null accessor for the published triple; call only after `sessionLooksAlive()`. */
  private currentSession(): FoundrySession {
    if (!this.browser || !this.page || !this.verify) {
      throw new ToolError('BROWSER_NOT_READY', 'Browser session is not available');
    }
    return { browser: this.browser, page: this.page, verify: this.verify };
  }

  /**
   * Probe whether the cached page is still a live Foundry game. A thrown
   * error (target detached, socket gone) counts as not-ready.
   */
  private async probeGameReady(): Promise<boolean> {
    if (!this.page) return false;
    try {
      return await this.page.evaluate(() => {
        const g = (globalThis as { game?: { ready?: boolean } }).game;
        return g?.ready === true;
      });
    } catch {
      return false;
    }
  }

  /**
   * Discard a dead or stale browser handle. The published fields are nulled
   * first so a concurrent caller never observes a half-dead triple; the
   * actual close is best-effort (the browser may already be gone).
   */
  private async teardownStaleSession(): Promise<void> {
    const stale = this.browser;
    this.browser = null;
    this.page = null;
    this.verify = null;
    if (stale) {
      this.log.warn('session lost; tearing down stale browser');
      await stale.close().catch(() => undefined);
    }
  }

  private async launchAndLogin(): Promise<void> {
    if (this.config.forgeMode) {
      await this.launchForge();
    } else {
      await this.launchLocal();
    }
  }

  /**
   * LAN-mode startup: launch Chromium, navigate, and script the Foundry
   * join form. This is the original flow and is unchanged in behavior.
   */
  private async launchLocal(): Promise<void> {
    const browser = await this.launchBrowser({ headless: this.config.foundryHeadless });
    let page: Page | undefined;
    try {
      page = await browser.newPage();
      this.attachPageListeners(page);
      await this.navigate(page);

      const screen = await this.detectScreen(page);
      this.log.info({ screen, pathname: new URL(page.url()).pathname }, 'screen detected');

      switch (screen) {
        case 'setup':
          throw new ToolError(
            'FOUNDRY_NOT_READY',
            'Foundry is on the Setup screen — no world is launched. Launch the world manually before starting the MCP server.',
            { url: page.url() },
          );

        case 'unknown':
          await this.dumpDebug(page, 'unknown-screen');
          throw new ToolError(
            'FOUNDRY_NOT_READY',
            'Could not identify Foundry screen at the configured URL (not setup, join, or in-game).',
            { url: page.url() },
          );

        case 'in-game': {
          // Session was already authenticated (e.g., persistent cookie).
          // Confirm the logged-in user matches the configured GM.
          this.log.info('already in-game; verifying user identity');
          const verify = await this.runVerify(page);
          this.assertVerifyMatches(verify);
          await this.finishStartup(browser, page, verify);
          return;
        }

        case 'join': {
          await this.submitJoinForm(page);
          await this.waitForGameReady(page);
          const verify = await this.runVerify(page);
          this.assertVerifyMatches(verify);
          await this.finishStartup(browser, page, verify);
          return;
        }
      }
    } catch (err) {
      // Capture diagnostics before tearing down, but only for unexpected failures.
      if (page && !(err instanceof ToolError)) {
        await this.dumpDebug(page, 'launch-failure').catch(() => undefined);
      }
      await browser.close().catch(() => undefined);
      throw err;
    }
  }

  /**
   * Forge-mode startup. Tries to restore a persisted session headlessly;
   * if none is live, opens a visible window for a one-time human login,
   * then relaunches headless from the now-saved profile.
   */
  private async launchForge(): Promise<void> {
    const profileDir = this.config.forgeProfileDir;

    if (this.profileDirHasSession(profileDir)) {
      this.log.info({ profileDir }, 'forge: saved profile found, attempting headless restore');
      if (await this.tryRestoreSession(profileDir)) return;
      this.log.warn('forge: saved session is not live; falling back to visible login');
    } else {
      this.log.info({ profileDir }, 'forge: no saved profile; visible login required');
    }

    await this.runVisibleLogin(profileDir);

    // The session is now persisted in the profile; relaunch headless for
    // the actual working session. Honors "visible only for initial login"
    // and immediately self-verifies that persistence worked.
    this.log.info('forge: visible login complete, relaunching headless from saved profile');
    if (!(await this.tryRestoreSession(profileDir))) {
      throw new ToolError(
        'FOUNDRY_NOT_READY',
        'Visible login succeeded but the headless restore from the saved profile failed. ' +
          'The Chromium profile may not be persisting correctly — check that FORGE_PROFILE_DIR is writable.',
        { profileDir },
      );
    }
  }

  /**
   * Launch headless using the persisted Chromium profile and check whether
   * a live GM session is available.
   *
   * Returns `true` only when the session is fully verified. Returns `false`
   * when there is no live session (so the caller can fall back to a visible
   * login). A verify mismatch (wrong user / not a GM) is a configuration
   * error, not an expired session, so it is rethrown rather than swallowed.
   */
  private async tryRestoreSession(profileDir: string): Promise<boolean> {
    const browser = await this.launchBrowser({
      headless: this.config.foundryHeadless,
      profileDir,
    });
    let page: Page | undefined;
    try {
      page = await browser.newPage();
      this.attachPageListeners(page);
      await this.navigate(page);

      const screen = await this.waitForStableScreen(page, this.config.forgeWakeTimeoutMs);
      this.log.info({ screen, url: page.url() }, 'forge: restore screen detected');

      if (screen === 'in-game') {
        const verify = await this.runVerify(page);
        this.assertVerifyMatches(verify);
        await this.finishStartup(browser, page, verify);
        return true;
      }

      if (screen === 'join') {
        // The Forge account session is still valid but the Foundry world
        // session lapsed — re-submit the join form headlessly with the
        // stored GM credentials.
        this.log.info('forge: at join screen, re-submitting join form headlessly');
        await this.submitJoinForm(page);
        await this.waitForGameReady(page);
        const verify = await this.runVerify(page);
        this.assertVerifyMatches(verify);
        await this.finishStartup(browser, page, verify);
        return true;
      }

      // 'setup' or 'unknown' (e.g. the Forge account login page) — a human
      // must complete the login in a visible window. Capture a debug
      // artifact so the actual page state is inspectable afterwards.
      this.log.info({ screen, url: page.url() }, 'forge: no live session at this screen');
      await this.dumpDebug(page, 'forge-restore-no-session');
      await browser.close().catch(() => undefined);
      return false;
    } catch (err) {
      await browser.close().catch(() => undefined);
      if (this.isVerifyMismatch(err)) throw err;
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'forge: headless restore failed; falling back to visible login',
      );
      return false;
    }
  }

  /**
   * Open a visible Chromium window so a human can complete the Forge
   * account login. Blocks until `game.ready` becomes true (up to
   * `forgeManualLoginTimeoutMs`), then closes the window — Chromium
   * flushes the session into the profile directory on close.
   */
  private async runVisibleLogin(profileDir: string): Promise<void> {
    this.log.warn(
      { url: this.config.foundryUrl, timeoutMs: this.config.forgeManualLoginTimeoutMs },
      'forge: opening a visible browser window — complete the Forge login manually; ' +
        'the server continues automatically once the world is ready',
    );

    let browser: Browser;
    try {
      browser = await this.launchBrowser({ headless: false, profileDir });
    } catch (err) {
      throw new ToolError(
        'BROWSER_NOT_READY',
        'Forge mode needs a visible browser for the first-time login, but Chromium could not ' +
          'open a window (no display available?). Perform the initial login on a machine with a ' +
          'desktop, then copy the FORGE_PROFILE_DIR directory to this host.',
        { profileDir, underlyingError: err instanceof Error ? err.message : String(err) },
      );
    }

    let page: Page | undefined;
    try {
      page = await browser.newPage();
      this.attachPageListeners(page);
      await this.navigate(page);
      await this.waitForGameReady(page, this.config.forgeManualLoginTimeoutMs);
    } finally {
      // Always close the visible window: the working session is the
      // headless relaunch from the now-saved profile.
      await browser.close().catch(() => undefined);
    }
  }

  /** True when the profile directory exists and has been populated before. */
  private profileDirHasSession(profileDir: string): boolean {
    try {
      return existsSync(profileDir) && readdirSync(profileDir).length > 0;
    } catch {
      return false;
    }
  }

  /** A verify mismatch is a config error (wrong user / not a GM), tagged by `details.verify`. */
  private isVerifyMismatch(err: unknown): boolean {
    return (
      err instanceof ToolError &&
      err.code === 'FOUNDRY_NOT_READY' &&
      err.details !== undefined &&
      'verify' in err.details
    );
  }

  private async launchBrowser(opts: { headless: boolean; profileDir?: string }): Promise<Browser> {
    this.log.info(
      { headless: opts.headless, profileDir: opts.profileDir ?? null },
      'launching chromium',
    );
    return puppeteer.launch({
      headless: opts.headless,
      defaultViewport: VIEWPORT,
      args: [...CHROME_LAUNCH_ARGS],
      ...(opts.profileDir ? { userDataDir: opts.profileDir } : {}),
    });
  }

  private async navigate(page: Page): Promise<void> {
    // A cold Forge instance can take well over the login timeout to respond;
    // give the navigation the longer Forge wake budget in Forge mode.
    const timeout = this.config.forgeMode
      ? this.config.forgeWakeTimeoutMs
      : this.config.loginTimeoutMs;
    this.log.info({ url: this.config.foundryUrl }, 'navigating to foundry');
    await page.goto(this.config.foundryUrl, {
      waitUntil: 'networkidle2',
      timeout,
    });
  }

  /**
   * Final shared startup steps once a verified GM session exists: dismiss
   * the hardware-acceleration banner, publish the browser/page/verify
   * handles, and kick off background compendium warming.
   */
  private async finishStartup(
    browser: Browser,
    page: Page,
    verify: LoginVerifyResult,
  ): Promise<void> {
    await this.dismissHwAccelWarning(page);
    this.browser = browser;
    this.page = page;
    this.verify = verify;
    this.logVerified(verify);
    this.maybeStartCompendiumWarm(page);
  }

  private async detectScreen(page: Page): Promise<Screen> {
    return page.evaluate(() => {
      const path = location.pathname;
      if (path.startsWith('/setup')) return 'setup';
      // After login Foundry replaces the page; window.game is the canonical signal.
      const g = (globalThis as { game?: { ready?: boolean } }).game;
      if (g && g.ready === true) return 'in-game';
      if (path.startsWith('/join') || document.body.classList.contains('join')) return 'join';
      return 'unknown';
    });
  }

  /**
   * Foundry served through Forge can sit in a transient booting /
   * redirecting state for several seconds after `networkidle2` resolves:
   * `game` is not yet defined and the path has not settled to /join or
   * the live game. A single `detectScreen` sample races that boot and
   * reads 'unknown'. Poll until the screen resolves to a terminal value
   * (in-game / join / setup) or the login timeout elapses.
   */
  private async waitForStableScreen(
    page: Page,
    timeoutMs: number = this.config.loginTimeoutMs,
  ): Promise<Screen> {
    const start = Date.now();
    const deadline = start + timeoutMs;
    let screen = await this.detectScreen(page);
    let reloaded = false;
    while (screen === 'unknown' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      // Forge can serve its "waking up" interstitial without auto-redirecting
      // into the game once the instance is back; one reload nudges it along
      // (and is HTTP traffic Forge counts as activity).
      if (!reloaded && Date.now() - start > SCREEN_RELOAD_NUDGE_MS) {
        reloaded = true;
        this.log.info('screen still unresolved; reloading once to nudge it');
        await page.reload({ waitUntil: 'networkidle2' }).catch(() => undefined);
      }
      screen = await this.detectScreen(page);
    }
    return screen;
  }

  private async submitJoinForm(page: Page): Promise<void> {
    const { foundryGmUsername, foundryGmPassword } = this.config;

    this.log.debug({ username: foundryGmUsername }, 'waiting for join form to hydrate');
    await page.waitForSelector(SELECTOR_USER_SELECT, { timeout: this.config.loginTimeoutMs });
    await page.waitForSelector(SELECTOR_JOIN_SUBMIT, { timeout: this.config.loginTimeoutMs });

    // Foundry options use generated IDs as values and display names as text.
    // Resolve text → value before calling page.select().
    const userId = await page.evaluate(
      (sel, username) => {
        const el = document.querySelector(sel);
        if (!(el instanceof HTMLSelectElement)) return null;
        for (const opt of Array.from(el.options)) {
          if ((opt.textContent ?? '').trim() === username) return opt.value;
        }
        return null;
      },
      SELECTOR_USER_SELECT,
      foundryGmUsername,
    );

    if (!userId) {
      const available = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!(el instanceof HTMLSelectElement)) return [];
        return Array.from(el.options).map((o) => (o.textContent ?? '').trim());
      }, SELECTOR_USER_SELECT);
      await this.dumpDebug(page, 'user-not-found');
      throw new ToolError(
        'FOUNDRY_NOT_READY',
        `Configured GM user "${foundryGmUsername}" not found in the join form's user list.`,
        { availableUsers: available },
      );
    }

    this.log.info({ username: foundryGmUsername, userId }, 'selecting user');
    await page.select(SELECTOR_USER_SELECT, userId);

    if (foundryGmPassword.length > 0) {
      this.log.debug('filling password');
      await page.type(SELECTOR_PASSWORD, foundryGmPassword);
    }

    this.log.info('submitting join form');
    await page.click(SELECTOR_JOIN_SUBMIT);
  }

  private async waitForGameReady(
    page: Page,
    timeoutMs: number = this.config.loginTimeoutMs,
  ): Promise<void> {
    this.log.info({ timeoutMs }, 'waiting for game.ready');
    try {
      await page.waitForFunction(
        () => (globalThis as { game?: { ready?: boolean } }).game?.ready === true,
        { timeout: timeoutMs, polling: 250 },
      );
    } catch (err) {
      await this.dumpDebug(page, 'game-not-ready');
      throw new ToolError(
        'FOUNDRY_NOT_READY',
        'game.ready did not become true within the login timeout. The login may not have ' +
          'completed, or the world failed to initialize.',
        { underlyingError: (err as Error).message },
      );
    }
  }

  private async runVerify(page: Page): Promise<LoginVerifyResult> {
    return (await page.evaluate(loginVerifyBody)) as LoginVerifyResult;
  }

  /**
   * Silence Foundry's persistent "no hardware acceleration" banner so it
   * stops appearing in screenshots. Headless Chromium has no GPU, so the
   * warning is guaranteed noise. Failure here is never fatal — startup
   * proceeds even if the dismiss call throws.
   */
  private async dismissHwAccelWarning(page: Page): Promise<void> {
    try {
      const result = (await page.evaluate(
        dismissHwAccelWarningBody,
      )) as DismissHwAccelWarningResult;
      if (result.removed > 0) {
        this.log.info(result, 'dismissed hardware-acceleration warning');
      } else {
        this.log.debug(result, 'no hardware-acceleration warning to dismiss');
      }
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'hardware-acceleration dismiss failed (non-fatal)',
      );
    }
  }

  private assertVerifyMatches(verify: LoginVerifyResult): void {
    const expected = this.config.foundryGmUsername;
    if (verify.user !== expected) {
      throw new ToolError(
        'FOUNDRY_NOT_READY',
        `Logged in as "${verify.user ?? '<unknown>'}" but expected "${expected}".`,
        { verify },
      );
    }
    if (!verify.isGM) {
      throw new ToolError(
        'FOUNDRY_NOT_READY',
        `User "${verify.user}" is not a Gamemaster on this world.`,
        { verify },
      );
    }
  }

  private logVerified(v: LoginVerifyResult): void {
    this.log.info(
      {
        user: v.user,
        worldId: v.worldId,
        foundryVersion: v.foundryVersion,
        systemId: v.systemId,
        systemVersion: v.systemVersion,
      },
      'logged in as GM, game ready',
    );
  }

  private attachPageListeners(page: Page): void {
    page.on('pageerror', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn({ err: message }, 'page error');
    });
    page.on('console', (msg) => {
      const type = msg.type();
      const text = msg.text();
      // Targeted forward: messages our own code emits inside the tab
      // are tagged with '[gm-puppeteer:...]' and routed to pino at the
      // matching level so background work (compendium warm, future
      // long-running tab operations) has visible diagnostics. Untagged
      // page console traffic stays at debug to avoid noise.
      if (text.startsWith('[gm-puppeteer:')) {
        if (type === 'error') this.log.error({ text }, 'page console (tagged)');
        else if (type === 'warn') this.log.warn({ text }, 'page console (tagged)');
        else this.log.info({ text }, 'page console (tagged)');
        return;
      }
      if (type === 'error' || type === 'warn') {
        this.log.debug({ type, text }, 'page console');
      }
    });
  }

  /**
   * Fire-and-forget compendium-cache warm. Runs in the background inside
   * the Foundry tab after the page is ready — the user's first tool call
   * is not blocked. Gated by config.warmCompendiumOnStart so dev or
   * memory-constrained deployments can disable it via the
   * WARM_COMPENDIUM_ON_START env var. Progress milestones flow to
   * stderr via the tagged-console forward above.
   */
  private maybeStartCompendiumWarm(page: Page): void {
    if (!this.config.warmCompendiumOnStart) {
      this.log.debug('compendium warm disabled by config; skipping');
      return;
    }
    startCompendiumWarm(page, this.log, {
      override: this.config.warmPhase2Packs,
      budget: this.config.warmDocBudget,
    });
  }

  private async dumpDebug(page: Page, label: string): Promise<void> {
    try {
      await mkdir(DEBUG_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const base = join(DEBUG_DIR, `${ts}-${label}`);
      await page.screenshot({ path: `${base}.png`, fullPage: true });
      const html = await page.content();
      await writeFile(`${base}.html`, html);
      this.log.warn({ artifacts: [`${base}.png`, `${base}.html`] }, 'wrote debug artifacts');
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'failed to write debug artifacts');
    }
  }

  async stop(): Promise<void> {
    if (this.browser) {
      this.log.info('closing browser session');
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.verify = null;
    }
  }
}
