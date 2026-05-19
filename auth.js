/* ================================================================
   js/auth.js — Queue SaaS
   Responsibilities:
     • Multi-tenant login (email/password → tenant context hydration)
     • Session persistence (sessionStorage + localStorage)
     • Tenant theme CSS hydration
     • TOTP admin gate (MFA before opening admin panel)
     • Admin panel view-state management (open/close, no classList sniffing)
     • Gate TOTP verification for customers
     • TOTP setup modal for customers
     • Pager / audio alert engine
   Dependencies: window.CONFIG, window.computeTOTP, window.verifyTOTP,
                 window.buildTOTPUri, window._GEO_ANCHOR (geo.js),
                 window._showToast, window.syncUIElements (queue.js / app.js)
================================================================ */

// ════════════════════════════════════════════════════════════════
// MULTI-TENANT ENGINE
// ════════════════════════════════════════════════════════════════
/*
 * ── SUPABASE SCHEMA (reference) ─────────────────────────────────
 *
 * TABLE: tenants
 *   id              uuid PRIMARY KEY DEFAULT gen_random_uuid()
 *   brand_name      text NOT NULL
 *   logo_char       text DEFAULT 'Q'
 *   logo_url        text
 *   theme_color     text DEFAULT '#1a73e8'
 *   qr_signing_salt text NOT NULL             -- HMAC key for QR partitioning
 *   anchor_lat      float8 NOT NULL
 *   anchor_lon      float8 NOT NULL
 *   radius_miles    float4 DEFAULT 1.0
 *   max_capacity    int    DEFAULT 200
 *   created_at      timestamptz DEFAULT now()
 *
 * TABLE: tickets
 *   id              uuid PRIMARY KEY DEFAULT gen_random_uuid()
 *   tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
 *   ticket_number   int NOT NULL
 *   device_id       text NOT NULL
 *   totp_secret     text NOT NULL             -- encrypted at rest
 *   status          text DEFAULT 'WAITING'   -- WAITING | NOW_SERVING | EXPIRED_NO_SHOW | COMPLETE
 *   called_at       timestamptz               -- stamped when NOW_SERVING
 *   mfa_passed      bool DEFAULT false
 *   issued_at       timestamptz DEFAULT now()
 *   UNIQUE (tenant_id, ticket_number)
 *
 * ROW-LEVEL SECURITY:
 *   JWT claim `tenant_id` gates every query.
 *   using (tenant_id = auth.jwt() ->> 'tenant_id')
 *   An organizer can ONLY read/write their own rows — database-enforced.
 */

let _tenant = null;
window._tenant = _tenant;

const DEMO_TENANTS = {
    stript: {
        id: 'ten_stript_001', brand_name: 'Stript', logo_char: 'S',
        logo_url: null, theme_color: '#111827', qr_salt: 'stript_s3cr3t_s4lt_x9',
        anchor_lat: 40.7580, anchor_lon: -73.9855, radius_miles: 0.25,
        max_capacity: 150, email: 'drops@stript.com'
    },
    matcha: {
        id: 'ten_matcha_002', brand_name: 'Matcha Shop', logo_char: 'M',
        logo_url: null, theme_color: '#166534', qr_salt: 'matcha_gr33n_s4lt_y7',
        anchor_lat: 37.7749, anchor_lon: -122.4194, radius_miles: 0.5,
        max_capacity: 80, email: 'events@matchashop.com'
    }
};

const SESSION_KEY_TENANT  = 'qd_tenant_ctx';
const SESSION_KEY_PERSIST = 'qd_tenant_persist';

function initTenantSession() {
    const raw = sessionStorage.getItem(SESSION_KEY_TENANT)
             || localStorage.getItem(SESSION_KEY_TENANT);
    if (!raw) return;
    try {
        const saved = JSON.parse(raw);
        if (!saved.id || !saved.brand_name || !saved.qr_salt) { _clearTenantSession(); return; }
        _applyTenantContext(saved, true);
        console.log(`[Tenant] Session restored: ${saved.brand_name}`);
    } catch { _clearTenantSession(); }
}
window.initTenantSession = initTenantSession;

function _applyTenantContext(tenant, skipSave = false) {
    _tenant = tenant;
    window._tenant = tenant;

    // Hydrate CONFIG
    CONFIG.ALLOWED_RADIUS_MILES = tenant.radius_miles;
    CONFIG.MAX_CAPACITY         = tenant.max_capacity;
    CONFIG.DROP_LOCATION_NAME   = tenant.brand_name;

    // Update geo anchor (overrides default encoded blob)
    if (window._GEO_ANCHOR) {
        window._GEO_ANCHOR.la = tenant.anchor_lat;
        window._GEO_ANCHOR.lo = tenant.anchor_lon;
    }

    _applyTenantTheme(tenant.theme_color);

    // Menu session strip
    const menuStrip = document.getElementById('menu-session-strip');
    const menuName  = document.getElementById('menu-tenant-name');
    if (menuStrip) menuStrip.classList.remove('hidden');
    if (menuName)  menuName.innerText = tenant.brand_name;

    // Admin panel strip
    const strip    = document.getElementById('admin-tenant-strip');
    const tLogo    = document.getElementById('admin-tenant-logo');
    const tName    = document.getElementById('admin-tenant-name');
    const tId      = document.getElementById('admin-tenant-id');
    const tSalt    = document.getElementById('admin-salt-preview');
    const dropName = document.getElementById('admin-drop-name-display');
    const dropSub  = document.getElementById('admin-drop-subtitle');
    if (strip)    strip.classList.remove('hidden');
    if (tLogo)  { tLogo.innerText = tenant.logo_char; tLogo.style.background = tenant.theme_color; }
    if (tName)    tName.innerText = tenant.brand_name;
    if (tId)      tId.innerText   = `tenant_id: ${tenant.id}`;
    if (tSalt)    tSalt.innerText = tenant.qr_salt.slice(0, 4) + '••••••••';
    if (dropName) dropName.innerText = `${tenant.brand_name} Dashboard`;
    if (dropSub)  dropSub.innerText  = `Live Drop Controller · ${tenant.brand_name}`;

    if (window.updateLocationStatusFooter) window.updateLocationStatusFooter();

    if (!skipSave) {
        sessionStorage.setItem(SESSION_KEY_TENANT, JSON.stringify(tenant));
        const remember = document.getElementById('tl-remember');
        if (remember && remember.checked)
            localStorage.setItem(SESSION_KEY_TENANT, JSON.stringify(tenant));
    }
}

function _applyTenantTheme(hex) {
    const root = document.documentElement;
    root.style.setProperty('--tenant-primary',    hex);
    root.style.setProperty('--tenant-primary-dk', _darkenHex(hex, 20));
    root.style.setProperty('--tenant-bg',         _hexToRGBA(hex, 0.08));
    root.style.setProperty('--tenant-border',     _hexToRGBA(hex, 0.25));
    root.style.setProperty('--tenant-text',       _darkenHex(hex, 40));
}

function _darkenHex(hex, pct) {
    const n = parseInt(hex.replace('#',''), 16);
    const f = c => Math.max(0, Math.floor(((n >> c) & 0xff) * (1 - pct / 100)));
    return `rgb(${f(16)},${f(8)},${f(0)})`;
}
function _hexToRGBA(hex, alpha) {
    const n = parseInt(hex.replace('#',''), 16);
    return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${alpha})`;
}

function _clearTenantSession() {
    sessionStorage.removeItem(SESSION_KEY_TENANT);
    localStorage.removeItem(SESSION_KEY_TENANT);
    _tenant = null; window._tenant = null;
    document.documentElement.style.cssText = '';
    const menuStrip = document.getElementById('menu-session-strip');
    if (menuStrip) menuStrip.classList.add('hidden');
    const adminStrip = document.getElementById('admin-tenant-strip');
    if (adminStrip) adminStrip.classList.add('hidden');
}

// ── Tenant Login Modal ────────────────────────────────────────────

function openTenantLoginModal() {
    document.getElementById('tl-email').value    = '';
    document.getElementById('tl-password').value = '';
    document.getElementById('tl-error').classList.add('hidden');
    const btn = document.getElementById('tl-submit-btn');
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-right-to-bracket mr-2"></i>Sign In to Dashboard';
    document.getElementById('tenant-login-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('tl-email').focus(), 100);
}
function closeTenantLoginModal() {
    document.getElementById('tenant-login-modal').classList.add('hidden');
}

function onTenantEmailInput(input) {
    const domain = (input.value.split('@')[1] || '').toLowerCase();
    const ring   = document.getElementById('tl-logo-ring');
    if (domain.includes('stript')) {
        ring.style.background = '#f0f0f0'; ring.style.color = '#111827'; ring.innerText = 'S';
    } else if (domain.includes('matcha')) {
        ring.style.background = '#dcfce7'; ring.style.color = '#166534'; ring.innerText = 'M';
    } else {
        ring.style.background = 'var(--tenant-bg)'; ring.style.color = 'var(--tenant-primary)'; ring.innerText = 'Q';
    }
}

function toggleTLPasswordVis() {
    const inp  = document.getElementById('tl-password');
    const icon = document.getElementById('tl-eye-icon');
    inp.type   = inp.type === 'password' ? 'text'     : 'password';
    icon.className = inp.type === 'text'  ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
}

/**
 * submitTenantLogin()
 * Production: replace demo matching with Supabase Auth signInWithPassword.
 *
 * const { data, error } = await supabase.auth.signInWithPassword({ email, password })
 * if (error) { showTLError(error.message); return; }
 * const { data: row } = await supabase.from('tenants').select('*')
 *   .eq('id', data.user.user_metadata.tenant_id).single()
 * _applyTenantContext({ ...row, email: data.user.email })
 */
async function submitTenantLogin() {
    const email    = document.getElementById('tl-email').value.trim().toLowerCase();
    const password = document.getElementById('tl-password').value;
    const btn      = document.getElementById('tl-submit-btn');
    if (!email)    { showTLError('Please enter your work email.'); return; }
    if (!password) { showTLError('Please enter your password or access token.'); return; }

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Verifying…';
    await new Promise(r => setTimeout(r, 600));

    const match = Object.values(DEMO_TENANTS).find(t => t.email === email);
    if (match) {
        document.getElementById('tl-error').classList.add('hidden');
        closeTenantLoginModal();
        _applyTenantContext({ ...match });
        _adminAuthed = false;
        _openAdminAuthModal();
    } else {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-right-to-bracket mr-2"></i>Sign In to Dashboard';
        showTLError('No account found for that email. Check with your event organiser.');
    }
}

function showTLError(msg) {
    const el = document.getElementById('tl-error');
    document.getElementById('tl-error-text').innerText = msg;
    el.classList.remove('hidden');
}

async function loginAsDemoTenant(key) {
    const t = DEMO_TENANTS[key];
    if (!t) return;
    document.getElementById('tl-email').value     = t.email;
    document.getElementById('tl-password').value  = 'demo_password';
    document.getElementById('tl-remember').checked = false;
    await submitTenantLogin();
}

function tenantSignOut() {
    _clearTenantSession();
    _adminAuthed   = false;
    _adminViewOpen = false;
    window._adminViewOpen = false;
    _setAdminView(false);
    window._showToast('Signed out of organizer session.', 'amber');
}

window.openTenantLoginModal = openTenantLoginModal;
window.closeTenantLoginModal = closeTenantLoginModal;
window.onTenantEmailInput   = onTenantEmailInput;
window.toggleTLPasswordVis  = toggleTLPasswordVis;
window.submitTenantLogin    = submitTenantLogin;
window.loginAsDemoTenant    = loginAsDemoTenant;
window.tenantSignOut        = tenantSignOut;


// ════════════════════════════════════════════════════════════════
// ADMIN AUTH GATE
// ════════════════════════════════════════════════════════════════

// Using explicit boolean flags — never sniff classList to determine view state.
// Sniffing classList caused the "can't reopen admin portal" bug in prior builds.
let _adminViewOpen   = false;
let _adminAuthed     = false;
let _adminAuthFailed = 0;
window._adminViewOpen = false;

const ADMIN_SECRET = 'MFRGGZDFMZTWQ2LK'; // Demo only — replace in production

function toggleAdminMode() {
    if (_adminViewOpen) {
        _saveAdminSettings();
        _setAdminView(false);
        return;
    }
    if (!_tenant) { openTenantLoginModal(); return; }
    _adminAuthed ? _openAdminPanel() : _openAdminAuthModal();
}

function _setAdminView(open) {
    _adminViewOpen = open;
    window._adminViewOpen = open;
    const cust = document.getElementById('customer-view');
    const adm  = document.getElementById('admin-view');
    const nav  = document.getElementById('nav-title');
    if (open) {
        cust.classList.add('hidden'); adm.classList.remove('hidden');
        if (nav) nav.innerText = (_tenant ? _tenant.brand_name + ' ' : '') + 'Admin Panel';
    } else {
        adm.classList.add('hidden'); cust.classList.remove('hidden');
        if (nav) nav.innerText = 'Store Queue System';
    }
}

function _openAdminPanel() {
    const nameEl = document.getElementById('cfg-location-name');
    const capEl  = document.getElementById('cfg-max-capacity');
    const deadEl = document.getElementById('cfg-dead-threshold');
    if (nameEl) nameEl.value = CONFIG.DROP_LOCATION_NAME || '';
    if (capEl)  capEl.value  = CONFIG.MAX_CAPACITY || 200;
    if (deadEl) deadEl.value = window._analytics ? window._analytics.deadTicketThresholdMins : 10;
    if (window._updateAnalyticsDisplay) window._updateAnalyticsDisplay();
    if (CONFIG.EVENT_LAUNCH_TIME) {
        const pad = n => String(n).padStart(2,'0'), d = CONFIG.EVENT_LAUNCH_TIME;
        document.getElementById('cfg-launch-time').value =
            `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        document.getElementById('cfg-launch-preview-text').innerText =
            `Drop set for ${d.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric',year:'numeric'})} at ${d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`;
        document.getElementById('cfg-launch-preview').classList.remove('hidden');
    }
    const ls = document.getElementById('cfg-lockout-mins');
    if (ls) ls.value = CONFIG.TRANSFER_LOCKOUT_MINS;
    if (window.renderFlaggedPanel) window.renderFlaggedPanel();
    _setAdminView(true);
}

function _saveAdminSettings() {
    CONFIG.ALLOWED_RADIUS_MILES  = parseFloat(document.getElementById('cfg-radius').value);
    const lv = document.getElementById('cfg-launch-time').value;
    CONFIG.EVENT_LAUNCH_TIME     = lv ? new Date(lv) : null;
    CONFIG.TRANSFER_LOCKOUT_MINS = parseInt(document.getElementById('cfg-lockout-mins').value, 10);
    if (window.updateLocationStatusFooter) window.updateLocationStatusFooter();
    if (window.myTicketNumber) {
        if (window._clearWaitCountdown) window._clearWaitCountdown();
        if (window._preLaunchInterval) { clearInterval(window._preLaunchInterval); window._preLaunchInterval = null; }
        if (window.syncUIElements)        window.syncUIElements();
        if (window.syncTransferLockState) window.syncTransferLockState();
    }
}

function _openAdminAuthModal() {
    _renderAdminSetupQR();
    const input = document.getElementById('admin-auth-input');
    input.value    = '';
    input.className = 'totp-pin-input';
    input.disabled  = (_adminAuthFailed >= 5);
    document.getElementById('admin-auth-error').classList.add('hidden');
    document.getElementById('admin-auth-lockout').classList.add('hidden');
    switchAdminTab(_adminAuthed ? 'verify' : 'setup');
    document.getElementById('admin-auth-modal').classList.remove('hidden');
}
function _closeAdminAuthModal() { document.getElementById('admin-auth-modal').classList.add('hidden'); }

function switchAdminTab(tab) {
    const setupPane  = document.getElementById('admin-tab-setup');
    const verifyPane = document.getElementById('admin-tab-verify');
    const setupBtn   = document.getElementById('admin-tab-setup-btn');
    const verifyBtn  = document.getElementById('admin-tab-verify-btn');
    const activeClass   = 'safari-clickable flex-1 text-xs font-semibold py-2 rounded-lg transition bg-white text-slate-800 shadow-sm';
    const inactiveClass = 'safari-clickable flex-1 text-xs font-semibold py-2 rounded-lg transition text-gray-400';
    if (tab === 'setup') {
        setupPane.classList.remove('hidden');  verifyPane.classList.add('hidden');
        setupBtn.className  = activeClass;     verifyBtn.className = inactiveClass;
    } else {
        verifyPane.classList.remove('hidden'); setupPane.classList.add('hidden');
        verifyBtn.className = activeClass;     setupBtn.className  = inactiveClass;
        setTimeout(() => document.getElementById('admin-auth-input').focus(), 100);
    }
}

function _renderAdminSetupQR() {
    const container = document.getElementById('admin-setup-qr');
    if (!container) return;
    container.innerHTML = '';
    const uri = `otpauth://totp/${encodeURIComponent('QueueDrop Admin')}?secret=${ADMIN_SECRET}&issuer=${encodeURIComponent('QueueDrop')}&algorithm=SHA1&digits=6&period=30`;
    new QRCode(container, {
        text: uri, width: 160, height: 160,
        colorDark: '#0f172a', colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
    });
    const dispEl = document.getElementById('admin-secret-display');
    if (dispEl) dispEl.innerText = ADMIN_SECRET.match(/.{1,4}/g).join(' ');
}

function onAdminPinInput(input) { if (input.value.length === 6) submitAdminAuth(); }

async function submitAdminAuth() {
    if (_adminAuthFailed >= 5) return;
    const input  = document.getElementById('admin-auth-input').value.trim();
    const pinEl  = document.getElementById('admin-auth-input');
    const errEl  = document.getElementById('admin-auth-error');
    const lockEl = document.getElementById('admin-auth-lockout');

    const valid = await window.verifyTOTP(ADMIN_SECRET, input);
    if (valid) {
        _adminAuthed = true; _adminAuthFailed = 0;
        pinEl.className = 'totp-pin-input success';
        errEl.classList.add('hidden');
        setTimeout(() => { _closeAdminAuthModal(); _openAdminPanel(); }, 400);
    } else {
        _adminAuthFailed++;
        pinEl.value = ''; pinEl.className = 'totp-pin-input error';
        setTimeout(() => { pinEl.className = 'totp-pin-input'; }, 900);
        if (_adminAuthFailed >= 5) {
            pinEl.disabled = true; errEl.classList.add('hidden'); lockEl.classList.remove('hidden');
        } else {
            const rem = 5 - _adminAuthFailed;
            errEl.innerText = `Incorrect code. ${rem} attempt${rem!==1?'s':''} remaining.`;
            errEl.classList.remove('hidden');
        }
    }
}

window.toggleAdminMode     = toggleAdminMode;
window._setAdminView       = _setAdminView;
window._openAdminPanel     = _openAdminPanel;
window._closeAdminAuthModal = _closeAdminAuthModal;
window.switchAdminTab      = switchAdminTab;
window.onAdminPinInput     = onAdminPinInput;
window.submitAdminAuth     = submitAdminAuth;


// ════════════════════════════════════════════════════════════════
// CUSTOMER TOTP GATE (setup + verify)
// ════════════════════════════════════════════════════════════════

function closeTOTPSetupModal() { document.getElementById('totp-setup-modal').classList.add('hidden'); }

function openTOTPSetupModal() {
    const container = document.getElementById('totp-setup-qr-container');
    container.innerHTML = '';
    new QRCode(container, {
        text:  window.buildTOTPUri(window.myTOTPSecret, window.myTicketNumber),
        width: 160, height: 160,
        colorDark: '#1a73e8', colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
    });
    document.getElementById('totp-secret-display').innerText =
        window.myTOTPSecret.match(/.{1,4}/g).join(' ');
    document.getElementById('totp-confirm-input').value = '';
    document.getElementById('totp-confirm-error').classList.add('hidden');
    document.getElementById('totp-setup-modal').classList.remove('hidden');
}

async function confirmTOTPSetup() {
    const input = document.getElementById('totp-confirm-input').value.trim();
    const errEl = document.getElementById('totp-confirm-error');
    if (!await window.verifyTOTP(window.myTOTPSecret, input)) {
        errEl.classList.remove('hidden');
        document.getElementById('totp-confirm-input').classList.add('error'); return;
    }
    window.totpSetupVerified = true;
    errEl.classList.add('hidden');
    document.getElementById('totp-setup-modal').classList.add('hidden');
    window._showToast('Authenticator set up ✓ — your ticket is now MFA-protected.', 'green');
}

function openGateVerifyModal() {
    if (window.mfaGatePassed) return;
    const pinEl = document.getElementById('gate-totp-input');
    pinEl.value = ''; pinEl.className = 'totp-pin-input'; pinEl.disabled = false;
    document.getElementById('gate-totp-error').classList.add('hidden');
    document.getElementById('gate-totp-lockout').classList.add('hidden');
    _updateStrikeUI();
    document.getElementById('gate-verify-modal').classList.remove('hidden');
}
function closeGateVerifyModal() { document.getElementById('gate-verify-modal').classList.add('hidden'); }
function onGatePinInput(input)  { if (input.value.length === 6) submitGateTOTP(); }

async function submitGateTOTP() {
    if (window.gateStrikes >= CONFIG.GATE_MAX_STRIKES) return;
    const input  = document.getElementById('gate-totp-input').value.trim();
    const pinEl  = document.getElementById('gate-totp-input');
    const errEl  = document.getElementById('gate-totp-error');
    const lockEl = document.getElementById('gate-totp-lockout');

    if (!window.totpSetupVerified || !window.myTOTPSecret) {
        errEl.innerText = 'Authenticator not set up yet. Scan the setup QR first.';
        errEl.classList.remove('hidden'); return;
    }

    const valid = await window.verifyTOTP(window.myTOTPSecret, input);
    if (valid) {
        window.mfaGatePassed = true;
        pinEl.className = 'totp-pin-input success';
        errEl.classList.add('hidden');
        window.staffOkCount = (window.staffOkCount || 0) + 1;
        if (window._updateStaffStats) window._updateStaffStats();
        // Cancel no-show grace window — legitimate check-in
        if (window._clearNoShowTimer) window._clearNoShowTimer(window.myTicketNumber);
        window.recordProcessingTime(Math.floor(Math.random() * 40) + 15);
        setTimeout(() => {
            closeGateVerifyModal();
            document.getElementById('mfa-verified-badge').classList.add('visible');
            document.getElementById('gate-verify-cta').classList.add('hidden');
            window._showToast('Identity verified ✓  You may now enter.', 'green');
        }, 600);
    } else {
        window.gateStrikes = (window.gateStrikes || 0) + 1;
        _updateStrikeUI();
        pinEl.value = ''; pinEl.className = 'totp-pin-input error';
        setTimeout(() => { pinEl.className = 'totp-pin-input'; }, 1000);
        if (window.gateStrikes >= CONFIG.GATE_MAX_STRIKES) {
            errEl.classList.add('hidden'); lockEl.classList.remove('hidden'); pinEl.disabled = true;
            const refCode = `FLAG-${window.myTicketNumber}-${(window.DEVICE_ID||'UNK').slice(-4).toUpperCase()}`;
            window.flagTicket(window.myTicketNumber, window.DEVICE_ID, `Gate TOTP failed ${CONFIG.GATE_MAX_STRIKES}x`);
            window.staffOverrideLog = window.staffOverrideLog || [];
            window.staffOverrideLog.push({ time: window._nowStr(), msg: `⚠ Ticket #${window.myTicketNumber} — 3-strike lockout`, type: 'warn' });
            window.staffOverrideCount = (window.staffOverrideCount || 0) + 1;
            if (window._updateStaffStats) window._updateStaffStats();
            if (window._renderStaffLog)   window._renderStaffLog();
        } else {
            const rem = CONFIG.GATE_MAX_STRIKES - window.gateStrikes;
            errEl.innerText = `Incorrect code. ${rem} attempt${rem!==1?'s':''} remaining.`;
            errEl.classList.remove('hidden');
        }
    }
}

function _updateStrikeUI() {
    for (let i = 1; i <= CONFIG.GATE_MAX_STRIKES; i++) {
        const d = document.getElementById(`strike-${i}`);
        if (d) d.className = 'strike-dot' + (i <= (window.gateStrikes || 0) ? ' used' : '');
    }
    const lbl = document.getElementById('gate-strike-label');
    const rem = CONFIG.GATE_MAX_STRIKES - (window.gateStrikes || 0);
    if (lbl) lbl.innerText = `${rem} attempt${rem!==1?'s':''} remaining`;
}

function requestStaffOverride() {
    const refCode = `FLAG-${window.myTicketNumber}-${(window.DEVICE_ID||'UNK').slice(-4).toUpperCase()}`;
    closeGateVerifyModal();
    window.staffOverrideLog = window.staffOverrideLog || [];
    window.staffOverrideLog.push({ time: window._nowStr(), msg: `Override requested — Ticket #${window.myTicketNumber} (${refCode})`, type: 'warn' });
    window.staffOverrideCount = (window.staffOverrideCount || 0) + 1;
    if (window._updateStaffStats) window._updateStaffStats();
    if (window._renderStaffLog)   window._renderStaffLog();
    window.flagTicket(window.myTicketNumber, window.DEVICE_ID, `Staff override requested at gate (${refCode})`);
    window._showToast(`Show reference ${refCode} to a staff member at the gate.`, 'amber');
}

window.closeTOTPSetupModal  = closeTOTPSetupModal;
window.openTOTPSetupModal   = openTOTPSetupModal;
window.confirmTOTPSetup     = confirmTOTPSetup;
window.openGateVerifyModal  = openGateVerifyModal;
window.closeGateVerifyModal = closeGateVerifyModal;
window.onGatePinInput       = onGatePinInput;
window.submitGateTOTP       = submitGateTOTP;
window.requestStaffOverride = requestStaffOverride;


// ════════════════════════════════════════════════════════════════
// PAGER / HAPTIC / AUDIO ALERT ENGINE
// ════════════════════════════════════════════════════════════════

function _triggerPager(level) {
    window._pagerActive = true;
    document.getElementById('pager-banner').classList.add('visible');
    document.getElementById('alert-mute-btn').classList.add('visible');

    if (navigator.vibrate) {
        navigator.vibrate(level === 'urgent' ? [500, 200, 500, 200, 500] : [300, 150, 300]);
        if (window._pagerVibrateHandle) clearInterval(window._pagerVibrateHandle);
        const interval = level === 'urgent' ? 5000 : 8000;
        window._pagerVibrateHandle = setInterval(() => {
            if (!window._alertMuted && navigator.vibrate)
                navigator.vibrate(level === 'urgent' ? [500, 200, 500, 200, 500] : [300, 150, 300]);
        }, interval);
    }
    _playAlertChime(level);
}

function _playAlertChime(level) {
    if (window._alertMuted) return;
    try {
        if (!window._audioCtx) window._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (window._audioCtx.state === 'suspended') window._audioCtx.resume();
        const notes = level === 'urgent' ? [880, 660, 440] : [523, 659];
        notes.forEach((freq, i) => {
            const osc = window._audioCtx.createOscillator();
            const gain = window._audioCtx.createGain();
            osc.connect(gain); gain.connect(window._audioCtx.destination);
            osc.type = level === 'urgent' ? 'square' : 'sine';
            osc.frequency.value = freq;
            const start = window._audioCtx.currentTime + i * 0.22;
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(0.35, start + 0.04);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.38);
            osc.start(start); osc.stop(start + 0.4);
        });
    } catch (e) { console.warn('[Pager] Audio unavailable:', e.message); }
}

function toggleAlertMute() {
    window._alertMuted = !window._alertMuted;
    const btn  = document.getElementById('alert-mute-btn');
    const icon = document.getElementById('alert-mute-icon');
    btn.classList.toggle('muted', window._alertMuted);
    icon.className = window._alertMuted ? 'fa-solid fa-bell-slash' : 'fa-solid fa-bell';
    if (!window._alertMuted) {
        if (!window._audioCtx) window._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (window._audioCtx.state === 'suspended') window._audioCtx.resume();
        _playAlertChime('warning');
    } else {
        if (window._pagerVibrateHandle) { clearInterval(window._pagerVibrateHandle); window._pagerVibrateHandle = null; }
        if (navigator.vibrate) navigator.vibrate(0);
    }
}

window._triggerPager   = _triggerPager;
window.toggleAlertMute = toggleAlertMute;
