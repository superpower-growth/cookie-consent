// Extensive deny-safety test: after denying everything, ONLY tracker scripts
// may disappear. Every other resource (site JS, custom scripts, CSS, fonts,
// media libs) must load identically, with no new JS errors and intact globals.
const { chromium } = require('playwright');
const fs = require('fs');
const assert = require('assert');

const TRACKER = /connect\.facebook\.net|facebook\.com|klaviyo\.com|licdn\.com|linkedin\.com|sc-static\.net|snapchat\.com|bat\.bing\.com|impact(cdn|radius)|ads-twitter\.com|tiktok\.com|doubleclick\.net|googleadservices\.com|posthog|google-analytics\.com|googletagmanager\.com|google\.com\/(ccm|pagead)|clarity\.ms|hotjar|segment\.(com|io)|amplitude|mixpanel|fullstory|googlesyndication\.com/i;

async function visit(browser, cc, denyAll) {
  const ctx = await browser.newContext();
  if (denyAll) {
    await ctx.addCookies([{
      name: 'fs-cc', domain: 'superpower-health.webflow.io', path: '/',
      value: encodeURIComponent(JSON.stringify({ id: 't', consents: { essential: true, analytics: false, marketing: false, personalization: false, uncategorized: false } }))
    }]);
  }
  const page = await ctx.newPage();
  await page.route(/cookie-consent@[^/]+\/cc(\.min)?\.js/, r =>
    r.fulfill({ contentType: 'application/javascript', body: cc }));

  const loaded = new Set(), failed = [], errors = [];
  page.on('response', r => {
    const t = r.request().resourceType();
    if (['script', 'stylesheet', 'font', 'media'].includes(t)) loaded.add(t + ' ' + r.url().split('?')[0]);
  });
  page.on('requestfailed', r => failed.push(r.url().split('?')[0]));
  page.on('pageerror', e => errors.push(String(e).slice(0, 160)));

  await page.goto('https://superpower-health.webflow.io/', { waitUntil: 'load' });
  await page.waitForTimeout(5000);
  await page.evaluate(() => window.scrollTo(0, 2000)); // trigger lazy/scroll code
  await page.waitForTimeout(2000);

  const state = await page.evaluate(() => ({
    gsap: !!window.gsap,
    scrollTrigger: !!(window.gsap && window.ScrollTrigger),
    jquery: !!window.jQuery,
    webflow: !!window.Webflow,
    plyr: !!window.Plyr,
    hls: !!window.Hls,
    fontsLoaded: document.fonts.size,
    heroText: !!document.querySelector('h1') && document.querySelector('h1').offsetHeight > 0,
    animatedEls: document.querySelectorAll('[style*="transform"]').length,
    bodyChildren: document.body.children.length
  }));
  const shot = denyAll ? 'deny-state.png' : 'allow-state.png';
  await page.screenshot({ path: __dirname + '/' + shot });
  await ctx.close();
  return { loaded, failed, errors, state };
}

(async () => {
  const cc = fs.readFileSync(__dirname + '/cc.js', 'utf8');
  const browser = await chromium.launch();

  const base = await visit(browser, cc, false);  // no choice = everything allowed
  const deny = await visit(browser, cc, true);   // returning visitor who denied all

  // 1. Resources present in baseline but missing after deny must ALL be trackers
  const missing = [...base.loaded].filter(u => !deny.loaded.has(u));
  const collateral = missing.filter(u => !TRACKER.test(u));
  console.log('baseline resources:', base.loaded.size, '| deny resources:', deny.loaded.size);
  console.log('missing after deny (' + missing.length + '):');
  missing.forEach(u => console.log('  ' + (TRACKER.test(u) ? '[tracker] ' : '[!! COLLATERAL] ') + u));
  assert.strictEqual(collateral.length, 0, 'NON-tracker resources lost after deny: ' + collateral.join(', '));

  // 2. Site functionality globals intact in deny state
  console.log('deny-state globals:', JSON.stringify(deny.state));
  for (const k of ['gsap', 'scrollTrigger', 'jquery', 'webflow', 'heroText']) {
    assert.strictEqual(deny.state[k], base.state[k], k + ' differs after deny (base=' + base.state[k] + ', deny=' + deny.state[k] + ')');
  }
  assert(deny.state.fontsLoaded > 0, 'webfonts loaded after deny');
  assert(deny.state.animatedEls > 0, 'animations ran after deny');

  // 3. No NEW page errors introduced by deny state
  const newErrors = deny.errors.filter(e => !base.errors.includes(e));
  console.log('page errors — baseline:', base.errors.length, '| deny:', deny.errors.length, '| new in deny:', newErrors);
  assert.strictEqual(newErrors.length, 0, 'new JS errors in deny state: ' + newErrors.join(' | '));

  // 4. No non-tracker request failures unique to deny
  const newFails = deny.failed.filter(u => !base.failed.includes(u) && !TRACKER.test(u));
  assert.strictEqual(newFails.length, 0, 'new failed requests in deny state: ' + newFails.join(', '));

  console.log('\nDENY-SAFETY PASS — only tracker resources removed; site JS/CSS/fonts/animations intact.');
  await browser.close();
})().catch(e => { console.error('DENY-SAFETY FAIL:', e.message); process.exit(1); });
