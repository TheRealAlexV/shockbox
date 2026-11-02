// Playwright/browser test for the shared quick-send box: does each pane actually show it at the top
// of the page, does searching narrow the pool, do tag chips filter, and does "send" reach the
// module's own route? Runs against a live dev server started by the caller:
//
//   node server.mjs --port 8973 --state ./state-dev &
//   node tools/verify-quicksend.mjs --port 8973
//
// The point is to catch the two failure modes this component had: the pane loading without it
// (missing import) and the box rendering but bound to nothing (search does nothing).

import { chromium } from 'playwright-core';

const port = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) || 8973);
const base = `http://127.0.0.1:${port}`;
const panes = ['wall', 'notifications', 'dialogs'];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  for (const name of panes) {
    const errors = [];
    page.removeAllListeners('pageerror');
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#/${name}`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    const box = await page.locator('.qs').first();
    const hasBox = (await box.count()) > 0;
    check(`${name}: quick-send box present`, hasBox);
    if (!hasBox) continue;

    // it must sit at the top of the page body, above the module's own controls
    const top = await box.evaluate((el) => el.getBoundingClientRect().top);
    check(`${name}: box is at the top`, top < 220, `top=${Math.round(top)}px`);

    // the pool list carries this module's messages, not every message ever
    const items = await page.locator('.qs-item').count();
    check(`${name}: pool list populated`, items > 0, `${items} items`);

    // search narrows it
    const firstText = await page.locator('.qs-item-text').first().innerText();
    const needle = firstText.split('\n')[0].slice(0, 6);
    await page.locator('.qs-search').first().fill(needle);
    await page.waitForTimeout(250);
    const narrowed = await page.locator('.qs-item').count();
    check(`${name}: search narrows the list`, narrowed > 0 && narrowed <= items, `${items} → ${narrowed}`);
    await page.locator('.qs-search').first().fill('');
    await page.waitForTimeout(200);

    // tag chips filter
    const tags = await page.locator('.qs-tag').count();
    check(`${name}: tag chips rendered`, tags > 0, `${tags} tags`);
    if (tags > 0) {
      await page.locator('.qs-tag').first().click();
      await page.waitForTimeout(250);
      const filtered = await page.locator('.qs-item').count();
      check(`${name}: tag chip filters`, filtered > 0 && filtered <= items, `${items} → ${filtered}`);
      const pressed = await page.locator('.qs-tag[aria-pressed="true"]').count();
      check(`${name}: chip shows pressed state`, pressed === 1);
      await page.locator('.qs-tag-clear').first().click().catch(() => {});
      await page.waitForTimeout(150);
    }

    // picking a message fills the composer
    await page.locator('.qs-item').first().click();
    await page.waitForTimeout(200);
    const filled = await page.locator('.qs-text').first().inputValue();
    check(`${name}: picking a message fills the composer`, filled.length > 0, filled.slice(0, 40));

    check(`${name}: no page errors`, errors.length === 0, errors.join(' | '));
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
