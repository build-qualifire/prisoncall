/* Shared auth utilities for Prisoncall customer portal pages.
   Included as <script src="/portal/portal-auth.js"> before page-level scripts. */

'use strict';

var PortalAuth = (function () {

  /* ─── Session check (calls /api/check-session) ─── */
  function checkSession(onAuth, onUnauth) {
    fetch('/api/check-session')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.authenticated) {
          if (onAuth) onAuth(data);
        } else {
          if (onUnauth) onUnauth();
          else window.location.replace('/portal/login.html');
        }
      })
      .catch(function () {
        if (onUnauth) onUnauth();
        else window.location.replace('/portal/login.html');
      });
  }

  /* ─── Sign out ─── */
  function logout() {
    fetch('/api/portal-supabase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logout' }),
    }).finally(function () {
      window.location.replace('/portal/login.html');
    });
  }

  /* ─── Mask mobile: 04** *** XXX (last 3 digits visible) ─── */
  function maskMobile(raw) {
    var digits = String(raw || '').replace(/\D/g, '');
    if (digits.length < 3) return raw || '';
    return '04** *** ' + digits.slice(-3);
  }

  /* ─── Format date to DD/MM/YYYY ─── */
  function formatDate(dateStr) {
    if (!dateStr) return '-';
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    var day   = String(d.getDate()).padStart(2, '0');
    var month = String(d.getMonth() + 1).padStart(2, '0');
    return day + '/' + month + '/' + d.getFullYear();
  }

  /* ─── Format DID: 10-digit string -> (0X) XXXX XXXX ─── */
  function formatDid(did) {
    if (!did) return '-';
    var d = String(did).replace(/\D/g, '');
    if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + ' ' + d.slice(6);
    return did;
  }

  /* ─── Escape HTML to prevent XSS in generated markup ─── */
  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return { checkSession: checkSession, logout: logout, maskMobile: maskMobile, formatDate: formatDate, formatDid: formatDid, esc: esc };
})();
