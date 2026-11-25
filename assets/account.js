// SPDX-License-Identifier: GPL-3.0-only
// web-pay-7: the account page gleamvox.com/account/ (WEB_PAY.md section 5, variant 2). Talks to api.gleamvox.com (routes:
// server/README.md, "Кабинет на сайте"). Rules: the web pass goes only in the Authorization header; the Google ticket is
// removed from the address bar before anything else; answers of the server are put on the page only with textContent.
// web-session-1 (owner decision 25.11, variant B, WEB_PAY.md 5б): the pass and its end are kept in sessionStorage of THIS
// tab (never the local storage, never a cookie), so the sign-in survives a reload and a visit to /pay/ or another page of the
// site; the end stays at most 1 hour from the sign-in (no extension). A kept pass is checked (form, end) before use; a
// broken or expired one is deleted. Sign out, deleting the account, 401 and the end of the hour delete it at once.
// sessionStorage also holds the PKCE verifier and the language page while the browser is away at Google; both are deleted
// as soon as the browser comes back. "Sign out" also revokes the pass on the server (web-logout-1, WEB_PAY.md 5a).
(function (root) {
  'use strict';
  var TICKET = /^[A-Za-z0-9_-]{43}$/;
  var PASS = /^w1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  var ACCOUNT_PATH = /^\/(?:[a-z]{2}\/)?account\/$/;
  var LOGIN_ERRORS = ['cancelled', 'expired', 'failed', 'unavailable'];
  var VKEY = 'gv_acc_v', RKEY = 'gv_acc_ret';
  // the kept pass: PKEY = the pass, EKEY = its end (unix seconds). lang.js reads only EKEY (header "Account" on every page).
  var PKEY = 'gv_web_pass', EKEY = 'gv_web_exp', LIFE = 3600, MARGIN = 30;

  // a kept pass is taken only with the right form and an end that is more than MARGIN s and at most LIFE (+60 s for
  // clocks) away from now; else null (then it is deleted)
  function keptPass(p, e, now) {
    if (typeof p !== 'string' || p.length > 4096 || !PASS.test(p)) return null;
    if (typeof e !== 'string' || !/^[0-9]{1,12}$/.test(e)) return null;
    var exp = Number(e), left = exp - now;
    return left > MARGIN && left <= LIFE + 60 ? { pass: p, exp: exp } : null;
  }

  // '#ticket=…' / '#error=…' -> {ticket} / {error}; nothing -> null. A broken or repeated value is a failed sign-in.
  function parseHash(hash) {
    var h = String(hash || '').replace(/^#/, '');
    if (!h) return null;
    var p = Object.create(null), dup = false;
    h.split('&').forEach(function (x) {
      var i = x.indexOf('=');
      if (i < 1) return;
      var k = x.slice(0, i);
      if (k in p) dup = true;
      p[k] = x.slice(i + 1);
    });
    if (p.ticket === undefined && p.error === undefined) return null;
    if (dup || (p.ticket !== undefined && p.error !== undefined)) return { error: 'failed' };
    if (p.ticket !== undefined) return TICKET.test(p.ticket) ? { ticket: p.ticket } : { error: 'failed' };
    return { error: LOGIN_ERRORS.indexOf(p.error) > -1 ? p.error : 'failed' };
  }

  function maskEmail(e) {
    e = String(e || '');
    var i = e.lastIndexOf('@');
    if (i < 1 || i === e.length - 1) return '•••';
    return e.charAt(0) + '•••@' + e.slice(i + 1);
  }

  function b64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return root.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // A URL from the server may be opened only if it is https and is our payment page or a Paddle page.
  // Our payment page is opened in the language of this page (/ru/pay/ ...). Anything else -> null.
  function safeUrl(u, site, lang, kind) {
    var x;
    try { x = new root.URL(String(u)); } catch (e) { return null; }
    if (x.protocol !== 'https:' || x.username || x.password || x.port) return null;
    if (kind === 'checkout' && x.hostname === site) {
      if (x.pathname !== '/pay/') return null;
      if (lang !== 'en') x.pathname = '/' + lang + '/pay/';
      return x.href;
    }
    if (/^([a-z0-9-]+\.)*paddle\.(com|net)$/.test(x.hostname)) return x.href;
    return null;
  }

  function fill(s, v) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] !== undefined ? String(v[k]) : m; });
  }

  // Lines about the subscription in plain words (array of strings), from GET /v1/account.
  function statusLines(acc, T, fmt) {
    var s = (acc && acc.subscription) || {};
    var st = String(s.state || 'none'), out = [];
    if (st === 'active') out.push(s.tier === 'trial' ? T.st_trial : s.tier === 'paid' ? T.st_active : T.st_access);
    else out.push(T['st_' + st] || T.st_none);
    if (acc && acc.entitled && s.expiresAt) out.push(fill(T.until, { date: fmt(s.expiresAt) }));
    if (acc && acc.entitled && s.autoRenew && st !== 'canceled') out.push(T.renew_on);
    if (s.plan === 'monthly') out.push(T.plan_monthly);
    else if (s.plan === 'yearly') out.push(T.plan_yearly);
    if (s.source === 'google_play') out.push(T.via_play);
    return out;
  }

  function hasSiteSub(acc) {
    return !!(acc && Array.isArray(acc.sources) && acc.sources.some(function (x) { return x && x.kind === 'site'; }));
  }

  function start(doc, win) {
    var main = doc.getElementById('acc');
    if (!main) return;
    var API = main.getAttribute('data-api'), SITE = main.getAttribute('data-site');
    var LANG = main.getAttribute('data-lang') || 'en', PAY_OPEN = main.getAttribute('data-pay') === '1';
    var T = JSON.parse(doc.getElementById('acc-i18n').textContent);
    var $ = function (id) { return doc.getElementById(id); };
    var S = { pass: null, exp: 0, timer: null, busy: false, email: '' };   // the web pass: here and in sessionStorage of this tab

    function store() { try { return win.sessionStorage; } catch (e) { return null; } }
    function nowSec() { return Math.floor(Date.now() / 1000); }
    // the header shows "Account" instead of "Sign in" while <html data-gv-in> is set (lang.js sets it on the other pages)
    function mark(on) {
      var D = doc.documentElement;
      if (!D) return;
      if (on) D.setAttribute('data-gv-in', ''); else D.removeAttribute('data-gv-in');
    }
    // the end first and removed first: lang.js trusts the end only while account.js keeps the pass next to it.
    // forget(p): only if the kept pass is p (or none): another page of this tab may have signed in again since (back button);
    // its new pass must stay. Returns false when a different pass was left in place.
    function forget(only) {
      var st = store();
      try {
        if (!st) return true;
        var cur = st.getItem(PKEY);
        if (only && cur !== null && cur !== only) return false;
        st.removeItem(EKEY); st.removeItem(PKEY);
      } catch (e) { /* blocked */ }
      return true;
    }
    function keep(p, exp) {
      var st = store();
      try { if (st) { st.setItem(PKEY, p); st.setItem(EKEY, String(exp)); } } catch (e) { forget(); }  // full or blocked: memory only
    }
    function loadKept() {
      var st = store(), p = null, e = null;
      try { if (st) { p = st.getItem(PKEY); e = st.getItem(EKEY); } } catch (x) { return null; }
      if (p === null && e === null) return null;
      var k = keptPass(p, e, nowSec());
      if (!k) forget();
      return k;
    }
    function fmt(sec) {
      try { return new Date(sec * 1000).toLocaleDateString(LANG, { year: 'numeric', month: 'long', day: 'numeric' }); }
      catch (e) { return new Date(sec * 1000).toISOString().slice(0, 10); }
    }
    // progress and plain notes go to #acc-msg (role=status), errors to #acc-err (role=alert); the other one is emptied
    function say(text, bad) { $('acc-msg').textContent = bad ? '' : (text || ''); $('acc-err').textContent = bad ? (text || '') : ''; }
    function show(id, on) { $(id).hidden = !on; }
    function clearNode(n) { while (n.firstChild) n.removeChild(n.firstChild); }

    function errText(r) {
      var c = r && r.data && r.data.error;
      if (r.status === 0) return T.err_network;
      if (r.status === 429) return T.err_rate;
      if (c === 'already_paid') return r.data.until ? fill(T.err_already_paid, { date: fmt(r.data.until) }) : T.st_active;
      var k = { code_invalid: 'err_code_invalid', email_login_disabled: 'err_email_login_disabled',
        mail_unavailable: 'err_mail_unavailable', ticket_invalid: 'err_ticket', payment_pending: 'err_payment_pending',
        pay_unavailable: 'err_pay_unavailable', no_subscription: 'err_no_subscription' }[c];
      return T[k] || T.err_generic;
    }

    function call(method, path, body) {
      var h = {}, sent = S.pass;
      if (sent) h.Authorization = 'Bearer ' + sent;
      if (body !== undefined) h['Content-Type'] = 'application/json';
      var o = { method: method, headers: h, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' };
      if (body !== undefined) o.body = JSON.stringify(body);
      return win.fetch(API + path, o).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var res = { status: r.status, ok: r.ok, data: j && typeof j === 'object' ? j : {} };
          if (r.status === 401 && sent) {   // the pass expired, broke or the account was deleted
            // two requests can come back with 401 together: only the first one signs out and speaks
            // the end of a sign-in is a plain note (role=status); a deleted account stays an error
            if (S.pass === sent) { if (res.data.error === 'signed_out') signOut(T.err_signed_out_acc, true); else signOut(T.err_session); }
            res.handled = true;
          }
          return res;
        });
      }, function () { return { status: 0, ok: false, data: {} }; });
    }

    function busy(on) {
      S.busy = on;
      ['acc-send', 'acc-verify', 'acc-google', 'acc-buy-m', 'acc-buy-y', 'acc-portal', 'acc-logout', 'acc-del', 'acc-del-yes']
        .forEach(function (id) { var b = $(id); if (b) b.disabled = on; });
    }

    function signOut(msg, bad) {
      var gone = S.pass;
      S.pass = null; S.exp = 0; S.email = '';
      if (forget(gone)) mark(false);
      if (S.timer) { win.clearTimeout(S.timer); S.timer = null; }
      clearNode($('acc-devices'));
      ['acc-mail', 'acc-status', 'acc-dev-count'].forEach(function (id) { $(id).textContent = ''; });
      show('acc-view', false); show('acc-login', true); show('acc-code-form', false); show('acc-email-form', true);
      $('acc-code-in').value = '';
      say(msg || '', bad);
    }

    function gotPass(r) {
      var p = r.data.pass;
      if (!r.ok || typeof p !== 'string' || p.length > 4096 || !PASS.test(p)) { say(r.ok ? T.err_generic : errText(r), true); return; }
      // the end from the server, but never later than 1 hour from now (the server gives exactly 1 hour)
      var now = nowSec(), exp = r.data.expiresAt;
      exp = typeof exp === 'number' && isFinite(exp) && exp > 0 ? Math.min(Math.floor(exp), now + LIFE) : now + LIFE;
      enter(p, exp);
      $('acc-email-in').value = ''; $('acc-code-in').value = '';
      say('');
      if (r.data.account) render(r.data.account);
      loadAll();
    }

    // signed in: with a new pass (gotPass) or with the one kept in this tab (page load)
    function enter(p, exp) {
      S.pass = p; S.exp = exp;
      keep(p, exp); mark(true);
      if (S.timer) win.clearTimeout(S.timer);
      var ms = Math.max(0, exp * 1000 - Date.now() - MARGIN * 1000);
      S.timer = win.setTimeout(function () { signOut(T.err_session); }, Math.min(ms, 2147483647));  // timer limit of browsers
      show('acc-login', false); show('acc-view', true);
    }

    function render(acc) {
      $('acc-mail').textContent = maskEmail(acc.email);
      var box = $('acc-status');
      clearNode(box);
      statusLines(acc, T, fmt).forEach(function (line) {
        var p = doc.createElement('p'); p.textContent = line; box.appendChild(p);
      });
      var canBuy = !acc.entitled;
      show('acc-buy', PAY_OPEN && canBuy);
      show('acc-buy-closed', !PAY_OPEN && canBuy);
      $('acc-trial').textContent = acc.trialUsed ? T.no_trial : T.trial_hint;
      show('acc-portal-box', hasSiteSub(acc));
      var d = acc.devices || {};
      if (typeof d.active === 'number' && typeof d.max === 'number') $('acc-dev-count').textContent = fill(T.dev_count, { n: d.active, max: d.max });
    }

    function renderDevices(list) {
      var ul = $('acc-devices');
      clearNode(ul);
      if (!list.length) { var e = doc.createElement('li'); e.textContent = T.dev_none; ul.appendChild(e); return; }
      list.forEach(function (dv) {
        if (!dv || typeof dv.deviceId !== 'string') return;
        var li = doc.createElement('li');
        var name = doc.createElement('strong');
        name.textContent = T['dev_' + ({ android: 'android', pc: 'pc' }[dv.platform] || 'other')];
        var info = doc.createElement('span');
        var parts = [];
        if (typeof dv.createdAt === 'number') parts.push(fill(T.dev_added, { date: fmt(dv.createdAt) }));
        if (typeof dv.lastSeenAt === 'number') parts.push(fill(T.dev_seen, { date: fmt(dv.lastSeenAt) }));
        info.textContent = parts.length ? ' — ' + parts.join(', ') : '';
        var b = doc.createElement('button');
        b.type = 'button'; b.className = 'btn2'; b.textContent = T.dev_logout;
        b.addEventListener('click', function () {
          if (S.busy || !win.confirm(T.dev_logout_ask)) return;
          busy(true);
          call('POST', '/v1/devices/logout', { deviceId: dv.deviceId }).then(function (r) {
            busy(false);
            if (r.handled) return;
            if (r.ok || r.status === 404) { say(T.dev_logged_out); loadAll(); } else say(errText(r), true);
          });
        });
        li.appendChild(name); li.appendChild(info); li.appendChild(b);
        ul.appendChild(li);
      });
    }

    // back from the payment page (?paid=1): the webhook may be late, so the status is asked again (5 times, every 3 s)
    var WAIT = /[?&]paid=1(&|$)/.test(String(win.location && win.location.search || '')) ? 5 : 0, waiting = false;
    function loadAccount() {
      call('GET', '/v1/account').then(function (r) {
        if (r.handled) return;
        if (r.ok) {
          render(r.data);
          if (WAIT > 0 && !hasSiteSub(r.data)) {
            WAIT -= 1; waiting = true; say(T.wait_pay);
            win.setTimeout(function () { if (S.pass) loadAccount(); }, 3000);
          } else if (waiting) { waiting = false; WAIT = 0; say(''); }
        } else { WAIT = 0; waiting = false; say(errText(r), true); }
      });
    }

    function loadAll() {
      loadAccount();
      call('GET', '/v1/devices').then(function (r) {
        if (r.handled) return;
        if (r.ok && Array.isArray(r.data.devices)) renderDevices(r.data.devices); else if (!r.ok) say(errText(r), true);
      });
    }

    function open(r, kind, waitText) {
      if (r.handled) return;
      if (!r.ok) { say(errText(r), true); return; }
      var u = safeUrl(r.data.url, SITE, LANG, kind);
      if (!u) { say(T.err_bad_link, true); return; }
      say(waitText);
      win.location.assign(u);
    }

    // ---- sign-in with a code to the e-mail: the block opens on "Sign in with e-mail" (Google is the main way, site-design-2)
    function emailBox(on) {
      show('acc-email-box', on);
      $('acc-email-toggle').setAttribute('aria-expanded', on ? 'true' : 'false');
    }
    $('acc-email-toggle').addEventListener('click', function () {
      // waiting for the code: the block never closes (the code field must stay on the page); the button only brings it back to focus
      var waiting = !$('acc-code-form').hidden;
      var on = waiting || $('acc-email-box').hidden;
      emailBox(on);
      if (on) { try { $(waiting ? 'acc-code-in' : 'acc-email-in').focus(); } catch (e) { /* no focus in tests */ } }
    });
    $('acc-email-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (S.busy) return;
      var email = String($('acc-email-in').value || '').trim();
      if (email.length < 3 || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { say(T.bad_email, true); return; }
      busy(true); say(T.sending);
      call('POST', '/v1/auth/email/request', { email: email }).then(function (r) {
        busy(false);
        if (!r.ok) { say(errText(r), true); return; }
        S.email = email;
        emailBox(true);   // waiting for the code: the e-mail block stays open
        show('acc-email-form', false); show('acc-code-form', true);
        say(fill(T.code_sent, { email: email }));
        try { $('acc-code-in').focus(); } catch (e) { /* no focus in tests */ }
      });
    });
    $('acc-code-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (S.busy) return;
      var code = String($('acc-code-in').value || '').replace(/\s+/g, '');
      if (!/^[0-9]{6,12}$/.test(code)) { say(T.bad_code, true); return; }
      busy(true); say(T.signing_in);
      call('POST', '/v1/auth/web/email/verify', { email: S.email, code: code }).then(function (r) { busy(false); gotPass(r); });
    });
    $('acc-email-change').addEventListener('click', function () {
      show('acc-code-form', false); show('acc-email-form', true); say('');
    });

    // ---- sign-in with Google: the browser goes to the server, comes back to /account/#ticket=…
    $('acc-google').addEventListener('click', function () {
      if (S.busy) return;
      var st = store(), c = win.crypto;
      if (!st || !c || !c.subtle) { say(T.err_storage, true); return; }
      var bytes = new Uint8Array(32);
      c.getRandomValues(bytes);
      var verifier = b64url(bytes);
      try { st.setItem(VKEY, verifier); st.setItem(RKEY, win.location.pathname); } catch (e) { say(T.err_storage, true); return; }
      busy(true);
      c.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (h) {
        var challenge = b64url(new Uint8Array(h));
        win.location.assign(API + '/v1/auth/google/start?challenge=' + challenge + '&platform=web');
      }, function () { busy(false); say(T.err_storage, true); });
    });

    // ---- buttons of the account
    function checkout(plan) {
      if (S.busy) return;
      busy(true); say(T.opening_pay);
      call('POST', '/v1/pay/checkout', { plan: plan }).then(function (r) { busy(false); open(r, 'checkout', T.opening_pay); });
    }
    $('acc-buy-m').addEventListener('click', function () { checkout('monthly'); });
    $('acc-buy-y').addEventListener('click', function () { checkout('yearly'); });
    $('acc-portal').addEventListener('click', function () {
      if (S.busy) return;
      busy(true); say(T.opening_portal);
      call('GET', '/v1/pay/portal').then(function (r) { busy(false); open(r, 'portal', T.opening_portal); });
    });
    // web-logout-1: "Sign out" forgets the pass at once, then asks the server to revoke it (POST /v1/auth/web/logout),
    // so a copy of the pass stops working before its hour is over. The page never waits for the answer.
    // keepalive lets the request finish even if the tab is closed right away; one more try without keepalive if the
    // first one fails (network, or a browser that refuses keepalive with a preflight) or the server answers 5xx.
    // The server answers a repeat with 200, so two tries are safe. If both fail, the pass still ends within the hour.
    function revoke(p) {
      function send(keep) {
        var o = { method: 'POST', headers: { Authorization: 'Bearer ' + p }, credentials: 'omit', cache: 'no-store',
          redirect: 'error', referrerPolicy: 'no-referrer' };
        if (keep) o.keepalive = true;
        try { return win.fetch(API + '/v1/auth/web/logout', o); } catch (e) { return Promise.reject(e); }
      }
      send(true).then(function (r) { if (r.status >= 500) return send(false); }, function () { return send(false); })
        .catch(function () {});
    }
    $('acc-logout').addEventListener('click', function () {
      var p = S.pass;
      signOut(T.signed_out);
      if (p) revoke(p);
    });
    $('acc-del').addEventListener('click', function () { show('acc-del-confirm', true); });
    $('acc-del-no').addEventListener('click', function () { show('acc-del-confirm', false); });
    $('acc-del-yes').addEventListener('click', function () {
      if (S.busy) return;
      busy(true); say(T.deleting);
      call('DELETE', '/v1/account', { confirm: 'DELETE' }).then(function (r) {
        busy(false);
        if (r.handled) return;
        if (!r.ok || r.data.deleted !== true) { say(errText(r), true); return; }
        show('acc-del-confirm', false);
        signOut(r.data.cancelInGooglePlay ? T.deleted_play : T.deleted);
      });
    });

    // the back button may bring this page back from the browser cache with an old pass in memory, while another page of the
    // tab has signed out or in since: then the page is loaded anew (it takes the pass of the tab as it is now)
    if (typeof win.addEventListener === 'function') {
      win.addEventListener('pageshow', function (ev) {
        if (!ev || !ev.persisted) return;
        var st = store(), cur = null;
        try { cur = st ? st.getItem(PKEY) : null; } catch (e) { /* blocked */ }
        if ((cur || null) !== (S.pass || null)) win.location.reload();
      });
    }

    // ---- coming back from Google: first take the ticket out of the address bar
    var back = parseHash(win.location.hash);
    if (back) {
      var st = store(), ret = null, verifier = null;
      try { ret = st && st.getItem(RKEY); verifier = st && st.getItem(VKEY); } catch (e) { /* blocked */ }
      if (ret && ACCOUNT_PATH.test(ret) && ret !== win.location.pathname) {
        // the server always returns to /account/; the person started on another language page -> go there with the same hash
        try { st.removeItem(RKEY); } catch (e) { /* blocked */ }
        win.location.replace(ret + win.location.hash);
        return;
      }
      try { win.history.replaceState(null, '', win.location.pathname + win.location.search); } catch (e) { /* old browser */ }
      try { if (st) { st.removeItem(VKEY); st.removeItem(RKEY); } } catch (e) { /* blocked */ }
      // a new sign-in: an older kept pass of this tab is not used any more and is revoked on the server too
      var old = loadKept();
      forget(); mark(false);
      if (old) revoke(old.pass);
      if (back.error) { say(T['err_' + back.error] || T.err_ticket, true); return; }
      if (!verifier) { say(T.err_ticket, true); return; }
      busy(true); say(T.signing_in);
      call('POST', '/v1/auth/web/ticket', { ticket: back.ticket, codeVerifier: verifier }).then(function (r) { busy(false); gotPass(r); });
      return;
    }
    // ---- no return from Google: the pass kept in this tab (a reload, back from /pay/ or from another page)
    var kept = loadKept();
    if (kept) { enter(kept.pass, kept.exp); loadAll(); } else mark(false);
  }

  var api = { parseHash: parseHash, maskEmail: maskEmail, safeUrl: safeUrl, statusLines: statusLines, b64url: b64url,
    keptPass: keptPass, start: start };
  if (typeof root.__gvAccountTest === 'function') { root.__gvAccountTest(api); return; }
  start(root.document, root);
})(this);
