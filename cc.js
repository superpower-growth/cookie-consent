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
  // Works on superpower.com (shared across subdomains) and webflow.io staging.
  var DOMAIN = /superpower\.com$/.test(location.hostname) ? '.superpower.com' : location.hostname;
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

    // Klaviyo has no consent API — kill its identity cookie on deny
    // (both host-only and domain-scoped variants).
    if (!M) {
      document.cookie = '__kla_id=; Max-Age=0; path=/';
      document.cookie = '__kla_id=; Max-Age=0; path=/; domain=' + DOMAIN;
    }
  }

  function deniedCats(c) {
    if (!c) return [];
    return Object.keys(DENY).filter(function (k) { return c[k] === false; });
  }

  function installBlocker(cats) {
    if (!cats.length) return;

    function blockedSrc(url) {
      for (var j = 0; j < cats.length; j++) if (DENY[cats[j]].test(url)) return true;
      return false;
    }

    // Primary: intercept script creation so a denied src is never set — kills
    // the Meta pixel snippet and everything GTM injects before any fetch.
    var create = document.createElement;
    document.createElement = function () {
      var el = create.apply(document, arguments);
      if (String(arguments[0]).toLowerCase() === 'script') {
        var desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
        Object.defineProperty(el, 'src', {
          get: function () { return desc.get.call(el); },
          set: function (v) {
            if (blockedSrc(String(v))) { el.type = 'javascript/blocked'; el.setAttribute('data-cc-blocked', v); return; }
            desc.set.call(el, v);
          }
        });
        var setAttr = el.setAttribute;
        el.setAttribute = function (name, value) {
          if (String(name).toLowerCase() === 'src' && blockedSrc(String(value))) {
            el.type = 'javascript/blocked';
            return setAttr.call(el, 'data-cc-blocked', value);
          }
          return setAttr.apply(el, arguments);
        };
      }
      return el;
    };

    // Backstop for parser-inserted static tags (e.g. klaviyo.js in the head).
    // The preload request may still fire; execution is neutralized.
    new MutationObserver(function (muts) {
      for (var m = 0; m < muts.length; m++) {
        var nodes = muts[m].addedNodes;
        for (var i = 0; i < nodes.length; i++) {
          var s = nodes[i];
          if (!s.tagName || s.tagName !== 'SCRIPT' || !s.src) continue;
          if (blockedSrc(s.src)) {
            s.type = 'javascript/blocked';
            s.removeAttribute('src');
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------------- UI (same fs-cc data attributes) ---------------- */

  function q(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  // Finsweet cloneables sit in a hidden state via inline IX2 transforms
  // (translate3d(0,100%,0), opacity:0). Animate past them directly instead of
  // replaying Webflow interactions via [fs-cc="interaction"] trigger clicks.
  function show(el) {
    if (!el) return;
    el.style.display = '';
    if (getComputedStyle(el).display === 'none') el.style.display = 'flex';
    el.style.transition = 'transform .4s ease, opacity .4s ease';
    requestAnimationFrame(function () {
      el.style.transform = 'none';
      el.style.opacity = '1';
    });
  }
  function hide(el) {
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(function () { el.style.display = 'none'; }, 400);
  }

  // Pre-hide consent components before first paint (script runs in <head>).
  var preHide = document.createElement('style');
  preHide.textContent = '[fs-cc="banner"],[fs-cc="preferences"],[fs-cc="manager"]{display:none!important}';
  document.head.appendChild(preHide);

  var initial = readConsents();

  // Use custom [fs-cc] markup if the page (or the SOURCE page) has it,
  // otherwise inject the built-in default banner — same behavior as fs-cc.js.
  function ensureComponents() {
    if (document.querySelector('[fs-cc="banner"]')) return Promise.resolve();
    var pull = location.pathname === SOURCE
      ? Promise.resolve()
      : fetch(SOURCE).then(function (r) { return r.text(); }).then(function (html) {
          var doc = new DOMParser().parseFromString(html, 'text/html');
          ['banner', 'preferences', 'manager'].forEach(function (k) {
            var el = doc.querySelector('[fs-cc="' + k + '"]');
            if (el && !document.querySelector('[fs-cc="' + k + '"]')) {
              document.body.appendChild(document.importNode(el, true));
            }
          });
        }).catch(function () {});
    return pull.then(function () {
      if (!document.querySelector('[fs-cc="banner"]')) injectDefaultUI();
    });
  }

  // Build a real [fs-cc="banner"] in Webflow to replace this — it takes over automatically.
  function injectDefaultUI() {
    document.body.insertAdjacentHTML('beforeend',
      '<style>' +
      '.spcc{position:fixed;bottom:20px;left:20px;z-index:2147483000;max-width:360px;' +
      'background:#0d0d0d;color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:14px;' +
      'padding:20px;font-size:14px;line-height:1.5;box-shadow:0 8px 30px rgba(0,0,0,.35)}' +
      '.spcc a{color:#fff;text-decoration:underline;cursor:pointer}' +
      '.spcc-btns{display:flex;gap:8px;margin-top:14px;justify-content:flex-end}' +
      '.spcc-btn{padding:8px 16px;border-radius:8px;border:1px solid #fff;background:#fff;' +
      'color:#000;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}' +
      '.spcc-ghost{background:transparent;color:#fff;border-color:rgba(255,255,255,.3)}' +
      '.spcc-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.5);' +
      'align-items:center;justify-content:center}' +
      '.spcc-modal{background:#0d0d0d;color:#fff;border:1px solid rgba(255,255,255,.12);' +
      'border-radius:16px;padding:24px;max-width:400px;width:calc(100% - 40px);font-size:14px;line-height:1.5}' +
      '.spcc-modal h3{margin:0 0 12px;font-size:16px;color:#fff}' +
      '.spcc-modal label{display:flex;gap:10px;margin:10px 0;align-items:flex-start;cursor:pointer}' +
      '.spcc-note{opacity:.6;font-size:12px;margin:12px 0 0}' +
      '@media(max-width:480px){.spcc{left:16px;right:16px;bottom:16px;max-width:none}}' +
      '</style>' +
      '<div class="spcc" fs-cc="banner">' +
      'We use cookies to analyze traffic and improve your experience. <a fs-cc="open-preferences">Preferences</a>' +
      '<div class="spcc-btns">' +
      '<button class="spcc-btn spcc-ghost" fs-cc="deny">Decline</button>' +
      '<button class="spcc-btn" fs-cc="allow">Accept</button>' +
      '</div></div>' +
      '<div class="spcc-overlay" fs-cc="preferences"><div class="spcc-modal">' +
      '<h3>Cookie preferences</h3>' +
      '<label><input type="checkbox" fs-cc-checkbox="analytics" checked> Analytics &mdash; usage &amp; performance</label>' +
      '<label><input type="checkbox" fs-cc-checkbox="marketing" checked> Marketing &mdash; ads &amp; attribution</label>' +
      '<p class="spcc-note">Essential cookies are always on.</p>' +
      '<div class="spcc-btns">' +
      '<button class="spcc-btn spcc-ghost" fs-cc="close">Cancel</button>' +
      '<button class="spcc-btn" fs-cc="submit">Save</button>' +
      '</div></div></div>');
  }

  function initUI() {
    ensureComponents().then(setup);
  }

  function setup() {
    preHide.parentNode && preHide.parentNode.removeChild(preHide);

    var banner = document.querySelector('[fs-cc="banner"]');
    var prefs = document.querySelector('[fs-cc="preferences"]');
    var manager = document.querySelector('[fs-cc="manager"]');

    // Instant hide (no fade) before first reveal — kills the peeking sliver.
    [banner, prefs, manager].forEach(function (el) { if (el) el.style.display = 'none'; });
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
      if (/^(allow|deny|submit|open-preferences|manager|close)$/.test(action)) e.preventDefault();

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
