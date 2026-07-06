/**
 * superpower.com cookie consent — UI + enforcement, zero dependencies.
 * Drop-in replacement for @finsweet/cookie-consent: reads/writes the same
 * `fs-cc` cookie and drives the same [fs-cc="..."] elements in Webflow.
 *
 * Model: opt-out. Nothing is blocked until the visitor denies a category.
 * Enforcement is vendor-API based (no script tagging) + a domain denylist
 * that blocks injected scripts (incl. everything GTM injects) on denied loads.
 *
 * MUST be the FIRST script in <head>, loaded synchronously (no async/defer),
 * so Google Consent Mode defaults land before gtag/GTM.
 */
(function () {
  'use strict';

  var COOKIE = 'fs-cc';
  var DOMAIN = '.superpower.com';
  var EXPIRES_DAYS = 180;
  var SOURCE = '/'; // page that holds the [fs-cc] components (fs-cc-source equivalent)
  var CATEGORIES = ['analytics', 'marketing', 'personalization', 'uncategorized'];

  // Common-sense domain → category map. Covers static tags AND scripts GTM
  // injects (Meta, LinkedIn, Snap, Bing, Impact live in GTM-PBS5NFXN).
  // ponytail: extend regex when a new vendor appears; Google + PostHog are
  // handled via their consent APIs below, not by blocking.
  var DENY = {
    marketing: /connect\.facebook\.net|klaviyo\.com|licdn\.com|ads\.linkedin\.com|sc-static\.net|snapchat\.com|bat\.bing\.com|impact(cdn|radius)|ads-twitter\.com|analytics\.tiktok\.com|doubleclick\.net|googleadservices\.com/i,
    analytics: /hotjar\.com|clarity\.ms|fullstory\.com|amplitude\.com|segment\.(com|io)|mixpanel\.com/i
  };

  /* ---------------- cookie ---------------- */

  function readConsents() {
    var m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE + '=([^;]+)'));
    if (!m) return null; // no choice yet = allow all
    try { return JSON.parse(decodeURIComponent(m[1])).consents || null; } catch (e) { return null; }
  }

  function writeConsents(consents) {
    consents.essential = true;
    var value = encodeURIComponent(JSON.stringify({
      id: 'cc-' + Math.random().toString(36).slice(2),
      consents: consents
    }));
    document.cookie = COOKIE + '=' + value +
      '; Max-Age=' + EXPIRES_DAYS * 86400 +
      '; path=/; domain=' + DOMAIN + '; SameSite=Lax; Secure';
  }

  /* ---------------- enforcement ---------------- */

  function g(allowed) { return allowed ? 'granted' : 'denied'; }
  function allowed(c, cat) { return !c || c[cat] !== false; }

  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }

  // Standard Meta fbq stub so consent calls queue before the pixel loads.
  if (!window.fbq) {
    var n = window.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!window._fbq) window._fbq = n;
    n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
  }

  var phTimer = null;
  function enforce(c, isUpdate) {
    var A = allowed(c, 'analytics');
    var M = allowed(c, 'marketing');

    // Google Consent Mode v2 — covers GA4 + every Google tag inside GTM.
    gtag('consent', isUpdate ? 'update' : 'default', {
      analytics_storage: g(A),
      ad_storage: g(M),
      ad_user_data: g(M),
      ad_personalization: g(M)
    });

    fbq('consent', M ? 'grant' : 'revoke');

    // PostHog persists its own opt-out, so explicitly opt back IN on accept.
    clearInterval(phTimer);
    var phTries = 0;
    phTimer = setInterval(function () {
      if (++phTries > 66) return clearInterval(phTimer); // give up after ~20s
      if (!window.posthog || !window.posthog.opt_out_capturing) return;
      clearInterval(phTimer);
      if (A) {
        if (posthog.has_opted_out_capturing && posthog.has_opted_out_capturing()) posthog.opt_in_capturing();
      } else {
        posthog.opt_out_capturing();
      }
    }, 300);

    // Klaviyo has no consent API — kill its identity cookie on deny.
    if (!M) document.cookie = '__kla_id=; Max-Age=0; path=/; domain=' + DOMAIN;
  }

  function deniedCats(c) {
    if (!c) return [];
    return Object.keys(DENY).filter(function (k) { return c[k] === false; });
  }

  function installBlocker(cats) {
    if (!cats.length) return;
    new MutationObserver(function (muts) {
      for (var m = 0; m < muts.length; m++) {
        var nodes = muts[m].addedNodes;
        for (var i = 0; i < nodes.length; i++) {
          var s = nodes[i];
          if (!s.tagName || s.tagName !== 'SCRIPT' || !s.src) continue;
          for (var j = 0; j < cats.length; j++) {
            if (DENY[cats[j]].test(s.src)) {
              s.type = 'javascript/blocked';
              s.removeAttribute('src');
              break;
            }
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------------- UI (same fs-cc data attributes) ---------------- */

  function q(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function show(el) {
    if (!el) return;
    el.style.display = '';
    if (getComputedStyle(el).display === 'none') el.style.display = 'flex';
  }
  function hide(el) { if (el) el.style.display = 'none'; }

  // Pre-hide consent components before first paint (script runs in <head>).
  var preHide = document.createElement('style');
  preHide.textContent = '[fs-cc="banner"],[fs-cc="preferences"],[fs-cc="manager"]{display:none!important}';
  document.head.appendChild(preHide);

  var initial = readConsents();

  // Banner markup lives only on the homepage — on other pages fetch and inject it.
  function ensureComponents() {
    if (document.querySelector('[fs-cc="banner"]')) return Promise.resolve();
    return fetch(SOURCE).then(function (r) { return r.text(); }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      ['banner', 'preferences', 'manager'].forEach(function (k) {
        var el = doc.querySelector('[fs-cc="' + k + '"]');
        if (el && !document.querySelector('[fs-cc="' + k + '"]')) {
          document.body.appendChild(document.importNode(el, true));
        }
      });
    }).catch(function () {}); // banner absent = no UI, enforcement still runs
  }

  function initUI() {
    ensureComponents().then(setup);
  }

  function setup() {
    preHide.parentNode && preHide.parentNode.removeChild(preHide);

    var banner = document.querySelector('[fs-cc="banner"]');
    var prefs = document.querySelector('[fs-cc="preferences"]');
    var manager = document.querySelector('[fs-cc="manager"]');

    hide(banner); hide(prefs); hide(manager);
    if (!initial) show(banner); else show(manager);

    function syncCheckboxes(c) {
      q('[fs-cc-checkbox]').forEach(function (box) {
        box.checked = allowed(c, box.getAttribute('fs-cc-checkbox'));
      });
    }
    syncCheckboxes(initial);

    function save(consents) {
      writeConsents(consents);
      hide(banner); hide(prefs); show(manager);
      // Newly denied category → reload so the blocker applies cleanly and
      // already-running trackers die. Otherwise update live.
      if (deniedCats(consents).length > deniedCats(initial).length) {
        location.reload();
      } else {
        enforce(consents, true);
        initial = consents;
        syncCheckboxes(consents);
      }
    }

    function all(value) {
      var c = {};
      CATEGORIES.forEach(function (k) { c[k] = value; });
      return c;
    }

    document.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[fs-cc]');
      if (!t) return;
      var action = t.getAttribute('fs-cc');

      if (action === 'allow') save(all(true));
      else if (action === 'deny') save(all(false));
      else if (action === 'submit') {
        var c = all(true);
        q('[fs-cc-checkbox]').forEach(function (box) {
          c[box.getAttribute('fs-cc-checkbox')] = box.checked;
        });
        save(c);
      }
      else if (action === 'open-preferences' || action === 'manager') {
        syncCheckboxes(readConsents());
        show(prefs);
      }
      else if (action === 'close') { hide(banner); hide(prefs); if (readConsents()) show(manager); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
  else initUI();

  /* ---------------- run ---------------- */

  enforce(initial, false);
  installBlocker(deniedCats(initial));
})();
