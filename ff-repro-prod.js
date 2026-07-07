// Reproduce Firefox bug: reject all → banner reappears.
const { firefox } = require('playwright');

(async () => {
  const browser = await firefox.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE ERR:', m.text().slice(0, 150)); });
  page.on('pageerror', e => console.log('PAGE ERR:', String(e).slice(0, 200)));

  await page.goto('https://superpower.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  console.log('banner visible (fresh):', await page.isVisible('[fs-cc="banner"]'));

  // Reject all via preferences
  await page.click('[fs-cc="banner"] [fs-cc="open-preferences"]');
  await page.click('[fs-cc="preferences"] [fs-cc="deny"]');
  await page.waitForTimeout(1000);

  // Cookie state immediately after deny, before/after the auto-reload
  const cookieNow = await page.evaluate(() => document.cookie.match(/fs-cc=[^;]*/) ? decodeURIComponent(document.cookie.match(/fs-cc=([^;]+)/)[1]) : 'NO COOKIE');
  console.log('cookie right after deny:', cookieNow.slice(0, 120));
  await page.waitForTimeout(3500); // let auto-reload finish

  const ctxCookies = (await ctx.cookies()).filter(c => c.name === 'fs-cc');
  console.log('ctx cookie jar:', JSON.stringify(ctxCookies.map(c => ({ domain: c.domain, path: c.path, secure: c.secure, sameSite: c.sameSite, expires: c.expires }))));
  console.log('banner visible after deny+auto-reload:', await page.isVisible('[fs-cc="banner"]'));

  // Fresh navigation — does the banner come back?
  await page.goto('https://superpower.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const cookieAfterNav = await page.evaluate(() => document.cookie.includes('fs-cc') ? 'present' : 'GONE');
  console.log('after new navigation — cookie:', cookieAfterNav, '| banner visible:', await page.isVisible('[fs-cc="banner"]'));

  await browser.close();
})().catch(e => { console.error('REPRO SCRIPT ERR:', e.message); process.exit(1); });
