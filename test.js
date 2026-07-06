// Smoke test: marketing denied in fs-cc cookie → consent mode denies ads,
// fbq gets 'revoke', blocker installs. Run: node test.js
'use strict';
const assert = require('assert');
const fs = require('fs');

let observed = false;
global.window = global;
global.MutationObserver = function () { this.observe = () => { observed = true; }; };
global.getComputedStyle = () => ({ display: 'none' });
global.location = { reload() {} };

const el = () => ({ style: {}, textContent: '', parentNode: null, setAttribute() {}, removeAttribute() {} });
global.document = {
  cookie: 'fs-cc=' + encodeURIComponent(JSON.stringify({ id: 'x', consents: { essential: true, analytics: true, marketing: false, personalization: true, uncategorized: true } })),
  readyState: 'complete',
  createElement: el,
  head: { appendChild(e) { e.parentNode = { removeChild() {} }; } },
  documentElement: {},
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}
};

eval(fs.readFileSync(__dirname + '/cc.js', 'utf8'));

const consentCall = global.dataLayer.find(a => a[0] === 'consent');
assert(consentCall, 'consent call pushed to dataLayer');
assert.strictEqual(consentCall[1], 'default');
assert.strictEqual(consentCall[2].ad_storage, 'denied');
assert.strictEqual(consentCall[2].analytics_storage, 'granted');
assert(global.fbq.queue.some(a => a[0] === 'consent' && a[1] === 'revoke'), 'fbq revoke queued');
assert(observed, 'script blocker installed for denied category');

// No cookie → everything granted, no blocker
observed = false;
global.dataLayer = [];
delete global.fbq; delete global._fbq;
global.document.cookie = '';
eval(fs.readFileSync(__dirname + '/cc.js', 'utf8'));
const c2 = global.dataLayer.find(a => a[0] === 'consent');
assert.strictEqual(c2[2].ad_storage, 'granted');
assert.strictEqual(c2[2].analytics_storage, 'granted');
assert(global.fbq.queue.some(a => a[0] === 'consent' && a[1] === 'grant'), 'fbq grant queued');
assert(!observed, 'no blocker when nothing denied');

console.log('ALL CHECKS PASS');
process.exit(0); // cc.js polls for posthog; don't wait it out

