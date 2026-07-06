// E2E against staging: serve local cc.js in place of the jsDelivr file.
const { chromium } = require('playwright');
const fs = require('fs');
const assert = require('assert');

(async () => {
  const cc = fs.readFileSync(__dirname + '/cc.js', 'utf8');
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const trackerHits = [];
  await page.route(/cookie-consent@[^/]+\/cc(\.min)?\.js/, r =>
    r.fulfill({ contentType: 'application/javascript', body: cc }));
  // Bare CDN file fetches (static.klaviyo.com/onsite/js, fbevents.js) can be
  // triggered by browser preloading and can't be stopped; what matters is the
  // scripts never EXECUTE: no pixel config loads, no /tr or track beacons.
  page.on('request', r => {
    if (/connect\.facebook\.net\/signals|facebook\.com\/tr|a\.klaviyo\.com|klaviyo\.com\/(api|onsite\/track)/.test(r.url())) trackerHits.push(r.url());
  });

  await page.goto('https://superpower-health.webflow.io/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // 1. Banner visible on fresh visit (Webflow component slides up past its IX2 transform)
  assert(await page.isVisible('[fs-cc="banner"]'), 'banner visible on first visit');
  const bannerPos = await page.evaluate(() => {
    const el = document.querySelector('[fs-cc="banner"]');
    const r = el.getBoundingClientRect();
    return { onScreen: r.top >= 0 && r.top + r.height <= innerHeight + 1, transform: getComputedStyle(el).transform };
  });
  assert(bannerPos.onScreen, 'banner fully on screen, not stuck offscreen: ' + JSON.stringify(bannerPos));
  await page.screenshot({ path: __dirname + '/banner-visible.png' });
  const hitsBefore = trackerHits.length; // trackers allowed pre-choice

  // 2. Decline (deny lives in the preferences modal on the real component)
  const bannerDeny = await page.isVisible('[fs-cc="banner"] [fs-cc="deny"]');
  if (bannerDeny) {
    await page.click('[fs-cc="banner"] [fs-cc="deny"]');
  } else {
    await page.click('[fs-cc="banner"] [fs-cc="open-preferences"]');
    await page.click('[fs-cc="preferences"] [fs-cc="deny"]');
  }
  await page.waitForTimeout(2500);
  const cookie = (await ctx.cookies()).find(c => c.name === 'fs-cc');
  assert(cookie, 'fs-cc cookie written');
  const consents = JSON.parse(decodeURIComponent(cookie.value)).consents;
  assert.strictEqual(consents.marketing, false, 'marketing denied');
  assert.strictEqual(consents.analytics, false, 'analytics denied');

  // 3. After reload: banner gone, denied trackers blocked
  trackerHits.length = 0;
  await page.goto('https://superpower-health.webflow.io/', { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  assert(!(await page.isVisible('[fs-cc="banner"]')), 'banner hidden after choice');
  assert.strictEqual(trackerHits.length, 0, 'no fb/klaviyo tracking after deny: ' + trackerHits.slice(0, 3).join(', '));
  const state = await page.evaluate(() => ({
    consent: (window.dataLayer || []).filter(a => a[0] === 'consent').map(a => [a[1], a[2] && a[2].ad_storage]),
    klaviyoRan: !!(window.klaviyo && window.klaviyo.loaded),
    klaCookie: document.cookie.includes('__kla_id'),
    posthogOptedOut: !!(window.posthog && window.posthog.has_opted_out_capturing && window.posthog.has_opted_out_capturing())
  }));
  assert(state.consent.some(c => c[0] === 'default' && c[1] === 'denied'), 'consent mode default denied');
  assert(!state.klaviyoRan, 'klaviyo did not initialize');
  assert(!state.klaCookie, 'no klaviyo identity cookie');
  assert(state.posthogOptedOut, 'posthog opted out');

  // 4. Accept path: trackers must run for consenting users
  await ctx.clearCookies();
  trackerHits.length = 0;
  await page.goto('https://superpower-health.webflow.io/', { waitUntil: 'domcontentloaded' });
  await page.click('[fs-cc="banner"] [fs-cc="allow"]');
  await page.waitForTimeout(3000);
  const accepted = await page.evaluate(() => ({
    consents: JSON.parse(decodeURIComponent(document.cookie.match(/fs-cc=([^;]+)/)[1])).consents,
    posthogOptedOut: !!(window.posthog && window.posthog.has_opted_out_capturing && window.posthog.has_opted_out_capturing())
  }));
  assert.strictEqual(accepted.consents.marketing, true, 'marketing granted');
  assert(!accepted.posthogOptedOut, 'posthog active after accept');
  assert(trackerHits.length > 0, 'trackers running after accept');

  console.log('E2E PASS', { hitsBeforeChoice: hitsBefore, deniedState: state, acceptHits: trackerHits.length });
  await browser.close();
})().catch(e => { console.error('E2E FAIL:', e.message); process.exit(1); });
