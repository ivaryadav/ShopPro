/**
 * app/modules/auth.js
 *
 * Phase 2 (Identity & Tenant Core) frontend extraction, per
 * docs/adr/0004-incremental-frontend-modularization.md and the Phase 2
 * mission's explicit "Allowed: Login, Logout, PIN, Session, User Profile,
 * Tenant Selection, Authentication Helpers" scope.
 *
 * Extracted VERBATIM from app/ShopERP_Pro_v8.html — no logic changed, no
 * UI/styling/UX touched. This is loaded via a plain <script src> tag
 * (no build step exists for this project, see
 * docs/adr/0004-incremental-frontend-modularization.md) BEFORE the
 * remaining inline <script> blocks, so every function/const here is
 * available in the same global scope exactly as it always was — the app's
 * behavior is unchanged, only the source location of this code moved.
 *
 * What was extracted, and why exactly these two pieces:
 * - generateBrowserMachineId() — the device-fingerprint helper used by
 *   both the offline-desktop license-binding flow (out of scope for
 *   Phase 2) AND the hosted-mode login's `deviceId` parameter (in scope —
 *   this is the client side of Phase 2's Trusted Device behavior). It is
 *   genuinely self-contained (depends only on fnv32()/enc(), which remain
 *   defined in the main script — shared with the desktop license engine,
 *   not moved, since touching them risks the desktop product too).
 * - The `_api` object — token storage (sessionStorage/localStorage),
 *   automatic refresh-on-401 handling, and the fetch wrapper every hosted-
 *   mode API call goes through. This is exactly "Session" +
 *   "Authentication Helpers" from the mission's allowed list, and it was
 *   already written as one cohesive, DOM-independent unit — the safest
 *   possible thing to relocate with zero behavior risk.
 *
 * What was deliberately NOT extracted, and why: pssLogin(), pssLicenseLogin(),
 * doLogout(), and adminLogout() all call directly into Licensing-domain
 * (_syncLicenseFromServer, pssShowLicenseSuspendedScreen) and
 * Operations-domain (fetching /api/data business data) functions inline,
 * as part of their own control flow. Moving them would either (a) carry
 * that cross-domain entanglement into a module named "auth", which is
 * misleading, or (b) require restructuring them to separate concerns —
 * explicitly forbidden by this phase's "Do NOT redesign UI... Only
 * modularize" instruction. They remain in the main script, unchanged,
 * documented here as an intentional, deferred boundary — a future phase
 * that also modularizes Licensing/Operations can revisit extracting these
 * cleanly once their own dependencies are modular too.
 */

// ── generateBrowserMachineId — verbatim from app/ShopERP_Pro_v8.html ───────
function generateBrowserMachineId() {
  try {
    const f = [
      typeof navigator !== 'undefined' ? navigator.userAgent   : 'UA',
      typeof navigator !== 'undefined' ? navigator.language    : 'EN',
      typeof screen    !== 'undefined' ? screen.width + 'x' + screen.height : '1920x1080',
      typeof screen    !== 'undefined' ? String(screen.colorDepth) : '24',
      String(new Date().getTimezoneOffset()),
      typeof navigator !== 'undefined' ? String(navigator.hardwareConcurrency || 4) : '4',
      typeof navigator !== 'undefined' ? (navigator.platform || 'PLAT') : 'PLAT',
    ].join('|');
    return [fnv32(f+'_A'), fnv32(f+'_B'), fnv32(f+'_C'), fnv32(f+'_D')]
      .map(h => enc(h, 4)).join('-');
  } catch { return 'BROW-SER0-MACH-ID00'; }
}

// ── _api — verbatim from app/ShopERP_Pro_v8.html ───────────────────────────
const _api = {
  token() { return sessionStorage.getItem('shoperpro_token') || ''; },
  setToken(t) { sessionStorage.setItem('shoperpro_token', t); },
  clearToken() { sessionStorage.removeItem('shoperpro_token'); },
  // Refresh token, Wave 1 — deliberately in localStorage, not sessionStorage:
  // the access token above is short-lived (15 min) and tab-scoped by design;
  // the refresh token is what makes a login last up to 30 days across tab
  // closes and browser restarts, which sessionStorage cannot do. This is the
  // one storage-location expansion in this wave — see
  // docs/architecture-review/SessionArchitecture.md for the tradeoff.
  refreshToken() { return localStorage.getItem('shoperpro_refresh') || ''; },
  setRefreshToken(t) { if(t) localStorage.setItem('shoperpro_refresh', t); },
  clearRefreshToken() { localStorage.removeItem('shoperpro_refresh'); },
  headers() { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token() }; },
  // Dedupes concurrent refresh attempts if several requests 401 around the
  // same moment (realistic now that access tokens expire every 15 minutes).
  async _tryRefresh() {
    if(this._refreshPromise) return this._refreshPromise;
    const rt = this.refreshToken();
    if(!rt){ return false; }
    this._refreshPromise = (async () => {
      try{
        const r = await fetch(SHOPERPRO_API_URL + '/api/auth/refresh', {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({refreshToken: rt})
        });
        if(!r.ok) return false;
        const d = await r.json();
        if(!d.token) return false;
        _api.setToken(d.token);
        _api.setRefreshToken(d.refreshToken);
        return true;
      }catch(e){ return false; }
    })();
    const result = await this._refreshPromise;
    this._refreshPromise = null;
    return result;
  },
  _sessionExpired() {
    _api.clearToken(); _api.clearRefreshToken(); showWebLoginScreen(); throw new Error('Session expired');
  },
  async _fetch(path, opts) {
    let r = await fetch(SHOPERPRO_API_URL + path, opts(this.headers()));
    if (r.status === 401) {
      if (await this._tryRefresh()) {
        r = await fetch(SHOPERPRO_API_URL + path, opts(this.headers()));
      }
      if (r.status === 401) this._sessionExpired();
    }
    if (r.status === 403) {
      const b=await r.json().catch(()=>{});
      if(b&&b.status)showSuspendedScreen(b.status,b.reason||'');
      // New SaaS licensing gates (requireLicenseRead/Write) respond with
      // licenseStatus instead of status — defense in depth: any blocked
      // write anywhere in the app (not just the ones pssRefreshLicenseStatus
      // already checks at boot) still surfaces the right lock screen/toast.
      else if(b&&b.licenseStatus){
        if(b.licenseStatus==='SUSPENDED'||b.licenseStatus==='ARCHIVED') pssShowLicenseSuspendedScreen(b.licenseStatus);
        else if(b.licenseStatus==='PENDING_APPROVAL') pssShowPendingApprovalScreen();
        else if(b.licenseStatus==='READ_ONLY'&&typeof toast==='function') toast(b.error||'Your subscription has expired. Renew to continue editing.','error');
      }
      throw new Error(b?.error||'Forbidden');
    }
    if (r.status === 409) { const b=await r.json().catch(()=>({})); const err=new Error(b.error||'Conflict'); err.status=409; err.conflict=b; throw err; }
    return r.json();
  },
  async get(path) {
    return this._fetch(path, (h) => ({ headers: h }));
  },
  async put(path, body) {
    return this._fetch(path, (h) => ({ method: 'PUT', headers: h, body: JSON.stringify(body) }));
  },
  // Deliberately NOT routed through _fetch()'s 401/403/409 interception:
  // every existing caller of post() (login, register, renew-license, verify-
  // license) treats a 401/409 as a normal business-logic response ("wrong
  // PIN", "key already registered", ...) and reads res.error itself — those
  // are not session-expiry signals the way a 401 from an authenticated GET/PUT
  // always is. Changing this contract broke login error messages during this
  // wave's own testing; kept as the original simple pass-through on purpose.
  async post(path, body) {
    const r = await fetch(SHOPERPRO_API_URL + path, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    return r.json();
  },
};
