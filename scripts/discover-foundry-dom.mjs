/**
 * Throwaway discovery script — launches Puppeteer against the live Foundry
 * sandbox, waits for the join form to hydrate, and dumps the structure of
 * key elements so we can identify selectors. Not shipped as part of the
 * tool; this only exists to inform what gets hardcoded in BrowserSession.
 *
 * Usage:  node scripts/discover-foundry-dom.mjs
 * Env:    FOUNDRY_URL (default http://localhost:30001)
 */
import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';

const url = process.env.FOUNDRY_URL ?? 'http://localhost:30001';

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

try {
  const page = await browser.newPage();
  page.on('console', (msg) => console.log(`[page console:${msg.type()}]`, msg.text()));
  page.on('pageerror', (err) => console.log('[page error]', err.message));

  console.log(`navigating: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });

  // Wait for any form-ish element to appear, max 15s.
  await page
    .waitForFunction(
      () => document.querySelector('form, select, input[type="password"], button[type="submit"]'),
      { timeout: 15_000 },
    )
    .catch(() => console.log('!! no form-ish element appeared within 15s'));

  // Brief settle for any post-hydration tweaks.
  await new Promise((r) => setTimeout(r, 1000));

  const summary = await page.evaluate(() => {
    const root = document.body;
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: el.className && typeof el.className === 'string' ? el.className : null,
      name: el.getAttribute('name'),
      type: el.getAttribute('type'),
      placeholder: el.getAttribute('placeholder'),
      value: el.value ?? null,
      text: (el.textContent ?? '').trim().slice(0, 80),
    });
    return {
      url: location.href,
      title: document.title,
      bodyClasses: root.className,
      forms: Array.from(document.querySelectorAll('form')).map(describe),
      selects: Array.from(document.querySelectorAll('select')).map((s) => ({
        ...describe(s),
        options: Array.from(s.options).map((o) => ({
          value: o.value,
          text: (o.textContent ?? '').trim(),
        })),
      })),
      inputs: Array.from(document.querySelectorAll('input')).map(describe),
      buttons: Array.from(document.querySelectorAll('button')).map(describe),
      h1: Array.from(document.querySelectorAll('h1')).map((h) => (h.textContent ?? '').trim()),
      // Capture any obvious top-level containers near the form
      mainContainers: Array.from(
        document.querySelectorAll('#join-game, #setup, [data-tab], section, main'),
      ).map((el) => ({
        ...describe(el),
        innerHTMLPreview: el.innerHTML.slice(0, 300),
      })),
    };
  });

  console.log('=== DOM summary ===');
  console.log(JSON.stringify(summary, null, 2));

  // Also dump full hydrated HTML for grep-ability.
  const html = await page.content();
  writeFileSync('debug-output/join-rendered.html', html);
  console.log(`\nfull HTML written to debug-output/join-rendered.html (${html.length} bytes)`);

  await page.screenshot({ path: 'debug-output/join-rendered.png', fullPage: true });
  console.log('screenshot: debug-output/join-rendered.png');
} finally {
  await browser.close();
}
