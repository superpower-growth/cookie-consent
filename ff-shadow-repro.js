// Theory check: a stale host-only fs-cc cookie (old Finsweet era) shadows the
// one cc.js writes on .superpower.com → reject never sticks, banner loops.
const { firefox } = require('playwright');

(async () => {
  const browser = await firefox.launch();
  const ctx = await browser.newContext();
  // Stale garbage cookie, host-only on www — simulates old-CMP leftovers
  await ctx.addCookies([{ name: 'fs-cc', value: 'legacy-garbage', domain: 'www.superpower.com', path: '/' }]);
  const page = await ctx.newPage();

  await page.goto('https://www.superpower.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  console.log('banner visible with stale cookie:', await page.isVisible('[fs-cc="banner"]'));

  if (await page.isVisible('[fs-cc="banner"]')) {
    await page.click('[fs-cc="banner"] [fs-cc="open-preferences"]');
    await page.click('[fs-cc="preferences"] [fs-cc="deny"]');
    await page.waitForTimeout(4000);
  }
  const jar = (await ctx.cookies()).filter(c => c.name === 'fs-cc').map(c => ({ domain: c.domain, value: c.value.slice(0, 30) }));
  console.log('cookie jar after deny:', JSON.stringify(jar));
  console.log('raw document.cookie fs-cc:', await page.evaluate(() => (document.cookie.match(/fs-cc=[^;]*/g) || []).map(v => v.slice(0, 40))));

  await page.goto('https://www.superpower.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  console.log('BANNER REAPPEARS AFTER REJECT:', await page.isVisible('[fs-cc="banner"]'));
  await browser.close();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
