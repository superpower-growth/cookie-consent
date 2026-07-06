// Drive the user's visible Chrome through the full consent flow on staging.
// Real published cc.min.js — no interception. Slow pacing so it's watchable.
const { chromium } = require('playwright');
const assert = require('assert');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9223');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();

  const beacons = [];
  ctx.on('request', r => {
    if (/connect\.facebook\.net\/signals|facebook\.com\/tr|a\.klaviyo\.com|klaviyo\.com\/(api|onsite\/track)|posthog\.com.*(capture|batch|\/e\/)/.test(r.url()))
      beacons.push(r.url().split('?')[0]);
  });

  console.log('STEP 1: fresh visit — banner should slide up, trackers running');
  await page.goto('https://superpower-health.webflow.io/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const bannerVisible = await page.isVisible('[fs-cc="banner"]');
  const hitsBefore = beacons.length;
  console.log('  banner visible:', bannerVisible, '| tracker beacons pre-choice:', hitsBefore);

  console.log('STEP 2: open preferences, uncheck everything, save (= reject)');
  await page.click('[fs-cc="banner"] [fs-cc="open-preferences"]');
  await page.waitForTimeout(1500);
  if (await page.isVisible('[fs-cc="preferences"] [fs-cc="deny"]')) {
    await page.click('[fs-cc="preferences"] [fs-cc="deny"]');
  } else {
    for (const box of await page.$$('[fs-cc="preferences"] [fs-cc-checkbox]')) await box.uncheck();
    await page.waitForTimeout(800);
    await page.click('[fs-cc="preferences"] [fs-cc="submit"]');
  }
  console.log('  rejected — page reloads itself');
  await page.waitForTimeout(4000);

  console.log('STEP 3: after reject — banner gone, trackers dead');
  beacons.length = 0;
  await page.goto('https://superpower-health.webflow.io/', { waitUntil: 'load' });
  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => ({
    bannerGone: !document.querySelector('[fs-cc="banner"]') || getComputedStyle(document.querySelector('[fs-cc="banner"]')).display === 'none',
    consents: (document.cookie.match(/fs-cc=([^;]+)/) || [null, null])[1] ? JSON.parse(decodeURIComponent(document.cookie.match(/fs-cc=([^;]+)/)[1])).consents : null,
    adStorageDenied: (window.dataLayer || []).some(a => a[0] === 'consent' && a[2] && a[2].ad_storage === 'denied'),
    posthogOptedOut: !!(window.posthog && window.posthog.has_opted_out_capturing && window.posthog.has_opted_out_capturing()),
    klaviyoRan: !!(window.klaviyo && window.klaviyo.loaded),
    klaCookie: document.cookie.includes('__kla_id')
  }));
  console.log('  ', JSON.stringify(after, null, 2));
  console.log('  tracker beacons after reject:', beacons.length, beacons.slice(0, 3));

  assert(bannerVisible, 'banner visible on fresh visit');
  assert(after.bannerGone, 'banner hidden after reject');
  assert(after.consents && after.consents.marketing === false, 'marketing denied in cookie');
  assert(after.adStorageDenied, 'google consent denied');
  assert(after.posthogOptedOut, 'posthog opted out');
  assert(!after.klaviyoRan && !after.klaCookie, 'klaviyo dead');
  assert.strictEqual(beacons.length, 0, 'zero tracking beacons after reject');

  console.log('\nALL LIVE CHECKS PASS — browser left open, banner is gone for this profile.');
  console.log('To see the banner again: clear cookies for the site or use the footer Cookie Settings link.');
})().catch(e => { console.error('LIVE TEST FAIL:', e.message); process.exit(1); });
