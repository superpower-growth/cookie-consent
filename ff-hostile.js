// Reproduce James's bug: Firefox configs that break cookie persistence.
// Usage: node ff-hostile.js [local]  — "local" routes in ./cc.js instead of published.
const { firefox } = require('playwright');
const fs = require('fs');

const CONFIGS = {
  'default': {},
  'ETP-strict': { 'privacy.trackingprotection.enabled': true, 'privacy.trackingprotection.socialtracking.enabled': true, 'network.cookie.cookieBehavior': 5 },
  'block-all-cookies': { 'network.cookie.cookieBehavior': 2 },
  'session-only-cookies': { 'network.cookie.lifetimePolicy': 2 }
};

(async () => {
  const useLocal = process.argv[2] === 'local';
  const cc = useLocal ? fs.readFileSync(__dirname + '/cc.js', 'utf8') : null;

  for (const [name, prefs] of Object.entries(CONFIGS)) {
    const browser = await firefox.launch({ firefoxUserPrefs: prefs });
    const page = await (await browser.newContext()).newPage();
    if (cc) await page.route(/cookie-consent@[^/]+\/cc(\.min)?\.js/, r => r.fulfill({ contentType: 'application/javascript', body: cc }));
    try {
      await page.goto('https://superpower.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(4000);
      const bannerFresh = await page.isVisible('[fs-cc="banner"]');
      let result = 'banner-fresh:' + bannerFresh;
      if (bannerFresh) {
        await page.click('[fs-cc="banner"] [fs-cc="open-preferences"]');
        await page.click('[fs-cc="preferences"] [fs-cc="deny"]');
        await page.waitForTimeout(4500); // deny + possible auto-reload
        const bannerBack = await page.isVisible('[fs-cc="banner"]');
        const cookiePresent = await page.evaluate(() => document.cookie.includes('fs-cc'));
        const lsPresent = await page.evaluate(() => { try { return !!localStorage.getItem('fs-cc'); } catch (e) { return 'blocked'; } });
        result += ' | after-deny banner-back:' + bannerBack + ' cookie:' + cookiePresent + ' localStorage:' + lsPresent;
        // navigate again — does it come back on next page?
        await page.goto('https://superpower.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(4000);
        result += ' | next-nav banner:' + (await page.isVisible('[fs-cc="banner"]'));
      }
      console.log(name.padEnd(22), result);
    } catch (e) { console.log(name.padEnd(22), 'ERROR:', e.message.slice(0, 100)); }
    await browser.close();
  }
})();
