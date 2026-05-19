/* ================================================================
   js/crypto.js — Queue SaaS
   Responsibilities:
     • TOTP key generation, computation, verification (RFC 6238)
     • otpauth:// URI construction for Google Authenticator
     • Rotating QR code engine with tenant HMAC-SHA256 signing
     • Canvas fingerprint for check-in payload hardening
     • Check-in payload builder + Edge Function stub
   Dependencies: window.CONFIG, window._tenant (set by auth.js)
================================================================ */

// ── TOTP Engine (RFC 6238) ────────────────────────────────────────

/**
 * generateTOTPSecret()
 * Random 16-char base32 string. In production: generate server-side,
 * store encrypted in Supabase, never re-expose after initial setup scan.
 */
function generateTOTPSecret() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let s = '';
    for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

/** base32Decode — converts base32 string → Uint8Array for HMAC-SHA1 */
function base32Decode(secret) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, value = 0;
    const out = [];
    for (const c of secret.toUpperCase().replace(/=+$/, '')) {
        value = (value << 5) | chars.indexOf(c);
        bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out);
}

/**
 * computeTOTP(secret, atTime?)
 * HMAC-SHA1 via SubtleCrypto → dynamic truncation → 6-digit code.
 * Returns Promise<string>. Compatible with Google Authenticator RFC 6238.
 */
async function computeTOTP(secret, atTime = Date.now()) {
    const counter  = Math.floor(atTime / 1000 / CONFIG.TOTP_STEP_SECS);
    const keyBytes = base32Decode(secret);
    const ctrBytes = new Uint8Array(8);
    let c = counter;
    for (let i = 7; i >= 0; i--) { ctrBytes[i] = c & 0xff; c >>>= 8; }

    const cryptoKey = await crypto.subtle.importKey(
        'raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const sig    = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, ctrBytes));
    const offset = sig[19] & 0x0f;
    const code   = ((sig[offset] & 0x7f) << 24 | sig[offset+1] << 16 | sig[offset+2] << 8 | sig[offset+3]) % 1000000;
    return String(code).padStart(CONFIG.TOTP_DIGITS, '0');
}

/**
 * verifyTOTP(secret, userInput)
 * Accepts current window ± 1 step (30s tolerance for clock drift).
 */
async function verifyTOTP(secret, userInput) {
    const step = CONFIG.TOTP_STEP_SECS * 1000;
    for (const offset of [0, -step, step]) {
        if (userInput.trim() === await computeTOTP(secret, Date.now() + offset)) return true;
    }
    return false;
}

/**
 * buildTOTPUri(secret, ticketNumber)
 * Returns otpauth:// URI scannable by Google Authenticator, Authy, Apple Passwords.
 */
function buildTOTPUri(secret, ticketNumber) {
    const label  = encodeURIComponent(`QueueDrop:#${ticketNumber}`);
    const issuer = encodeURIComponent('QueueDrop');
    return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}


// ── Rotating QR Code Engine ───────────────────────────────────────

let _qrInstance         = null;
let _qrRotationInterval = null;
let _qrRingInterval     = null;
let _qrRingSeconds      = 15;

const QR_ROTATION_SECS  = 15;
const QR_CIRCUMFERENCE  = 2 * Math.PI * 15.9;

function initQRRotation() {
    _teardownQRRotation();
    _renderQRFrame();
    _qrRotationInterval = setInterval(() => { _renderQRFrame(); _resetRingCountdown(); }, QR_ROTATION_SECS * 1000);
    _resetRingCountdown();
}

/**
 * _renderQRFrame()
 * Builds a tenant-partitioned QR payload:
 *   `${tenantId}:${ticketNumber}:${unixTs}:${hmac12}`
 *
 * The HMAC-SHA256 is keyed with the tenant's qr_signing_salt.
 * A Stript QR will FAIL validation against the Matcha salt server-side.
 * QR dot colour shifts to match the active tenant's primary theme colour.
 */
async function _renderQRFrame() {
    const c        = document.getElementById('qr-code-render');
    c.innerHTML    = '';
    const ts       = Math.floor(Date.now() / 1000);
    const tenantId = window._tenant ? window._tenant.id   : 'default';
    const salt     = window._tenant ? window._tenant.qr_salt : 'default_salt';
    const hmac     = await _computeQRHmac(tenantId, window.myTicketNumber, ts, salt);
    const payload  = `${tenantId}:${window.myTicketNumber}:${ts}:${hmac}`;

    _qrInstance = new QRCode(c, {
        text:         payload,
        width:        128, height: 128,
        colorDark:    window._tenant ? window._tenant.theme_color : '#202124',
        colorLight:   '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
    });
}

/**
 * _computeQRHmac(tenantId, ticketNum, ts, salt)
 * HMAC-SHA256 over `${tenantId}:${ticketNum}:${ts}` keyed with salt.
 * Returns first 12 hex chars — compact enough for QR density budget.
 *
 * Scanner verification (Supabase Edge Function):
 *   1. Parse tenantId, ticketNumber, ts, hmac from QR string
 *   2. Reject if |now - ts| > 20 seconds
 *   3. Fetch qr_signing_salt FROM tenants WHERE id = tenantId
 *   4. Recompute HMAC — cross-tenant mismatch fails here
 *   5. Verify ticket belongs to tenant + check MFA status
 */
async function _computeQRHmac(tenantId, ticketNum, ts, salt) {
    const msg = `${tenantId}:${ticketNum}:${ts}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', enc.encode(salt),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
    return Array.from(sig).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

function _resetRingCountdown() {
    if (_qrRingInterval) clearInterval(_qrRingInterval);
    _qrRingSeconds = QR_ROTATION_SECS;
    _updateRingUI(_qrRingSeconds);
    _qrRingInterval = setInterval(() => {
        _qrRingSeconds--;
        _updateRingUI(_qrRingSeconds);
        if (_qrRingSeconds <= 0) clearInterval(_qrRingInterval);
    }, 1000);
}

function _updateRingUI(s) {
    const arc = document.getElementById('qr-ring-arc');
    const lbl = document.getElementById('qr-ring-label');
    if (!arc || !lbl) return;
    arc.style.strokeDasharray  = `${QR_CIRCUMFERENCE} ${QR_CIRCUMFERENCE}`;
    arc.style.strokeDashoffset = QR_CIRCUMFERENCE * (1 - s / QR_ROTATION_SECS);
    lbl.innerText = s;
}

function _teardownQRRotation() {
    if (_qrRotationInterval) { clearInterval(_qrRotationInterval); _qrRotationInterval = null; }
    if (_qrRingInterval)     { clearInterval(_qrRingInterval);     _qrRingInterval     = null; }
}


// ── Check-in Payload Builder ──────────────────────────────────────

/**
 * _buildCheckinPayload(lat, lon)
 * Bundles: coordinates + timestamp + canvas fingerprint + device ID
 * into a single base64-encoded object for transmission to the Edge Function.
 *
 * Canvas fingerprint: renders invisible text and reads back pixel data.
 * GPU/driver rendering differences produce a unique hash per device/browser —
 * much harder to spoof than navigator properties alone.
 */
async function _buildCheckinPayload(lat, lon) {
    const canvas = document.createElement('canvas');
    canvas.width = 200; canvas.height = 40;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f0f0f0'; ctx.fillRect(0, 0, 200, 40);
    ctx.fillStyle = '#1a73e8'; ctx.font = '14px Arial';
    ctx.fillText('QueueDrop\u00ae\u2603\u00a9', 10, 26);
    const imgData = canvas.toDataURL();
    let canvasHash = 5381;
    for (let i = 0; i < imgData.length; i++)
        canvasHash = ((canvasHash << 5) + canvasHash) ^ imgData.charCodeAt(i);
    canvasHash = Math.abs(canvasHash).toString(36);

    const raw = {
        lat, lon,
        ts:    Date.now(),
        devId: window.DEVICE_ID,
        cfp:   canvasHash,
        ua:    btoa(navigator.userAgent.slice(0, 64))
    };

    return {
        encoded: btoa(JSON.stringify(raw)),
        preview: `lat=~${lat.toFixed(2)} cfp=${canvasHash}`
    };
}

/**
 * _verifyCheckinPayload(payload)
 * Production Supabase Edge Function stub.
 * The Edge Function decodes the payload server-side, runs haversine against
 * the TRUE anchor stored in env vars, and returns { allowed, ticketNumber }.
 * The geofence coordinates NEVER appear in client JS or network responses.
 *
 * Deno Edge Function skeleton:
 * ────────────────────────────────────────────────────────────────
 * import { serve } from "https://deno.land/std/http/server.ts"
 * const ANCHOR_LAT = Deno.env.get("ANCHOR_LAT")
 * const ANCHOR_LON = Deno.env.get("ANCHOR_LON")
 * const RADIUS_MI  = parseFloat(Deno.env.get("RADIUS_MI") ?? "1.0")
 *
 * serve(async (req) => {
 *   const { encoded } = await req.json()
 *   const { lat, lon, ts, devId, cfp } = JSON.parse(atob(encoded))
 *   if (Math.abs(Date.now() - ts) > 30000) return resp({ allowed:false, reason:"stale" })
 *   const dist = haversine(lat, lon, ANCHOR_LAT, ANCHOR_LON)
 *   if (dist > RADIUS_MI) return resp({ allowed:false, reason:"out_of_bounds" })
 *   return resp({ allowed:true, ticketNumber: await issueTicket(devId) })
 * })
 */
async function _verifyCheckinPayload(payload) {
    // PRODUCTION: uncomment and set your Supabase project ref
    // const res = await fetch('https://<ref>.supabase.co/functions/v1/checkin', {
    //     method: 'POST',
    //     headers: { 'Content-Type': 'application/json',
    //                'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
    //     body: JSON.stringify({ encoded: payload.encoded })
    // });
    // return await res.json();
    console.log('[Dev] Edge Function skipped — using client-side haversine fallback');
    return null;
}

// Expose to global scope for cross-module access
window.generateTOTPSecret   = generateTOTPSecret;
window.base32Decode         = base32Decode;
window.computeTOTP          = computeTOTP;
window.verifyTOTP           = verifyTOTP;
window.buildTOTPUri         = buildTOTPUri;
window.initQRRotation       = initQRRotation;
window._renderQRFrame       = _renderQRFrame;
window._computeQRHmac       = _computeQRHmac;
window._teardownQRRotation  = _teardownQRRotation;
window._buildCheckinPayload = _buildCheckinPayload;
window._verifyCheckinPayload = _verifyCheckinPayload;
