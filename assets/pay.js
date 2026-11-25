// SPDX-License-Identifier: GPL-3.0-only
// web-pay-7: the payment page gleamvox.com/pay/ = the "default payment link" of Paddle. The server creates a transaction and
// sends the person here as /pay/?_ptxn=txn_…; Paddle.js (loaded only from https://cdn.paddle.com/paddle/v2/paddle.js)
// opens the checkout for that transaction by itself after Paddle.Initialize (developer.paddle.com, checked 24.11.2026:
// "Default payment link", "Include Paddle.js", "Paddle.Environment.set"). The client-side token is public by design
// (Paddle: "test_…" sandbox, "live_…" live); there are no secrets on this page. Texts go on the page only with textContent.
// web-session-1: this page never reads the web pass (it does not need it): "Back to the account" is a plain link, the account
// page takes the pass kept in this tab by itself. Paddle.js could technically read the session storage of the tab here (WEB_PAY.md 5б).
(function (root) {
  'use strict';
  var TXN = /^txn_[a-z0-9]{26}$/;

  // exactly one _ptxn with the Paddle id format, else null (then Paddle.js is not started at all)
  function parseTxn(search) {
    var all;
    try { all = new root.URLSearchParams(String(search || '')).getAll('_ptxn'); } catch (e) { return null; }
    return all.length === 1 && TXN.test(all[0]) ? all[0] : null;
  }

  function fill(s, v) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] !== undefined ? String(v[k]) : m; }); }

  function start(doc, win) {
    var main = doc.getElementById('pay');
    if (!main) return;
    var T = JSON.parse(doc.getElementById('pay-i18n').textContent);
    var token = main.getAttribute('data-token') || '', env = main.getAttribute('data-env'), lang = main.getAttribute('data-lang');
    var msg = doc.getElementById('pay-msg'), err = doc.getElementById('pay-err'), backLink = doc.getElementById('pay-back');
    // progress and success -> #pay-msg (role=status), errors -> #pay-err (role=alert); the other one is emptied
    function say(k, bad) { msg.textContent = bad ? '' : T[k]; err.textContent = bad ? T[k] : ''; }
    if (!token) { say('closed'); return; }
    var txn = parseTxn(win.location.search);
    if (!txn) { say('no_txn'); backLink.hidden = false; return; }
    var P = win.Paddle;
    if (!P || !P.Initialize) { say('no_script', true); backLink.hidden = false; return; }
    var done = false, timer = null;
    var $ = function (id) { return doc.getElementById(id); };
    var CHECK = 'M14 25l7 7 14-15', CROSS = 'M16 16l16 16M32 16L16 32';
    var accHref = $('pay-go').getAttribute('href');
    function stopTimer() { if (timer !== null) { win.clearInterval(timer); timer = null; } }
    // success / "not completed" card instead of the form page (Paddle closes its own form: Paddle.Checkout.close)
    function card(ok, title, sub) {
      stopTimer();
      $('pay-main').hidden = true; $('pay-card').hidden = false;
      $('pay-mark').setAttribute('class', ok ? 'ok-mark' : 'ok-mark no');
      $('pay-mark-p').setAttribute('d', ok ? CHECK : CROSS);
      $('pay-card-h').textContent = title; $('pay-card-sub').textContent = sub; $('pay-card-count').textContent = '';
      $('pay-go').setAttribute('href', accHref + (ok ? '?paid=1' : ''));
      $('pay-retry').hidden = ok; $('pay-stay').hidden = !ok;
    }
    function countdown() {
      var n = 10;
      var tick = function () { $('pay-card-count').textContent = fill(T.auto, { n: n }); };
      tick();
      timer = win.setInterval(function () {
        n -= 1;
        if (n <= 0) { stopTimer(); win.location.assign($('pay-go').getAttribute('href')); } else tick();
      }, 1000);
    }
    function success(data) {
      var items = data && Array.isArray(data.items) ? data.items : [], trial = false;
      for (var k = 0; k < items.length; k++) if (items[k] && items[k].trial_period) trial = true;
      card(true, items.length ? (trial ? T.ok_trial : T.ok_paid) : T.ok_generic, T.ok_mail);
      countdown();
    }
    $('pay-stay').addEventListener('click', function () { stopTimer(); $('pay-card-count').textContent = ''; $('pay-stay').hidden = true; });
    $('pay-retry').addEventListener('click', function () {
      $('pay-card').hidden = true; $('pay-main').hidden = false; done = false;
      try { P.Checkout.open({ transactionId: txn }); say('opening'); } catch (e) { win.location.reload(); }
    });
    try {
      if (env === 'sandbox') P.Environment.set('sandbox');
      var settings = { displayMode: 'overlay' };
      if (lang === 'en' || lang === 'ru') settings.locale = lang;
      P.Initialize({
        token: token,
        checkout: { settings: settings },
        eventCallback: function (ev) {
          var n = ev && ev.name;
          if (n === 'checkout.completed') {
            done = true; say('done'); backLink.hidden = false;
            // ~2 s for the person to see Paddle's own "done" screen, then our card
            win.setTimeout(function () {
              try { P.Checkout.close(); } catch (e) { /* the form may be closed already */ }
              success(ev.data);
            }, 2000);
          } else if (n === 'checkout.closed') {
            if (done) return;
            card(false, T.unfinished, T.unfinished_sub);
          } else if (n === 'checkout.error') { say('failed', true); backLink.hidden = false; }
        }
      });
      say('opening');
    } catch (e) {
      say('failed', true); backLink.hidden = false;
    }
  }

  var api = { parseTxn: parseTxn, start: start };
  if (typeof root.__gvPayTest === 'function') { root.__gvPayTest(api); return; }
  start(root.document, root);
})(this);
