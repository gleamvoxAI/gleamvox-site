// SPDX-License-Identifier: GPL-3.0-only
// web-pay-7: the payment page gleamvox.com/pay/ = the "default payment link" of Paddle. The server creates a transaction and
// sends the person here as /pay/?_ptxn=txn_…; Paddle.js (loaded only from https://cdn.paddle.com/paddle/v2/paddle.js)
// opens the checkout for that transaction by itself after Paddle.Initialize (developer.paddle.com, checked 24.11.2026:
// "Default payment link", "Include Paddle.js", "Paddle.Environment.set"). The client-side token is public by design
// (Paddle: "test_…" sandbox, "live_…" live); there are no secrets on this page. Texts go on the page only with textContent.
(function (root) {
  'use strict';
  var TXN = /^txn_[a-z0-9]{26}$/;

  // exactly one _ptxn with the Paddle id format, else null (then Paddle.js is not started at all)
  function parseTxn(search) {
    var all;
    try { all = new root.URLSearchParams(String(search || '')).getAll('_ptxn'); } catch (e) { return null; }
    return all.length === 1 && TXN.test(all[0]) ? all[0] : null;
  }

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
    var done = false;
    try {
      if (env === 'sandbox') P.Environment.set('sandbox');
      var settings = { displayMode: 'overlay' };
      if (lang === 'en' || lang === 'ru') settings.locale = lang;
      P.Initialize({
        token: token,
        checkout: { settings: settings },
        eventCallback: function (ev) {
          var n = ev && ev.name;
          if (n === 'checkout.completed') { done = true; say('done'); backLink.hidden = false; }
          else if (n === 'checkout.closed') { if (!done) say('closed_form'); backLink.hidden = false; }
          else if (n === 'checkout.error') { say('failed', true); backLink.hidden = false; }
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
