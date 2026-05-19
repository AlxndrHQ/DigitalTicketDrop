/* ================================================================
   js/geo.js — Queue SaaS
   Responsibilities:
     • Obfuscated geo anchor (_GEO_ANCHOR)
     • Device fingerprint (djb2 hash of browser signals)
     • Haversine distance formula
     • GPS permission request + success/error handlers
     • Check-in flow orchestration (calls into queue.js + crypto.js)
   Dependencies: window.CONFIG, window._tenant, window._buildCheckinPayload,
                 window.generateTicket (queue.js)
================================================================ */

// ── Geo Anchor (obfuscated) ───────────────────────────────────────
// Raw coordinates are never exposed as plain floats in CONFIG.
// The base64 blob is a lightweight friction layer against casual
// DevTools coordinate overrides. In production, replace client-side
// haversine entirely with a Supabase Edge Function call (see crypto.js).
const _GEO_ANCHOR = (function () {
    const _b = 'eyJhIjozOC45MzYwLCJvIjotNzYuNzUwMH0='; // {"a":38.9360,"o":-76.7500}
    try { const p = JSON.parse(atob(_b)); return { la: p.a, lo: p.o }; }
    catch { return { la: 0, lo: 0 }; }
})();
window._GEO_ANCHOR = _GEO_ANCHOR;

// ── Device Fingerprint ────────────────────────────────────────────
// djb2 hash of stable browser signals. Used for device-cap enforcement.
// In production: replace with FingerprintJS Pro for stronger uniqueness.
const DEVICE_ID = (function () {
    const s = [
        navigator.userAgent, navigator.language,
        screen.width + 'x' + screen.height, screen.colorDepth,
        new Date().getTimezoneOffset(),
        navigator.hardwareConcurrency || 0, navigator.platform || ''
    ].join('|');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
    return 'dev_' + Math.abs(h).toString(36);
})();
window.DEVICE_ID = DEVICE_ID;


// ── Haversine Formula ─────────────────────────────────────────────

/**
 * calculateHaversine(lat1, lon1, lat2, lon2)
 * Returns distance in miles between two WGS-84 coordinate pairs.
 */
function calculateHaversine(lat1, lon1, lat2, lon2) {
    const R    = 3958.8;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2
               + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
               * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
window.calculateHaversine = calculateHaversine;


// ── GPS Permission & Handlers ─────────────────────────────────────

/**
 * getDigitalTicket()
 * Entry point triggered by the "Scan & Check In" button.
 * Requests high-accuracy GPS with iOS-safe timeout parameters.
 */
function getDigitalTicket() {
    const st = document.getElementById('geo-status');
    st.className = 'text-center text-xs text-[#5f6368] font-mono animate-pulse';
    st.innerText = 'Authenticating hardware GPS signal...';

    if (!navigator.geolocation) {
        st.innerText = 'Location services unavailable on this device.';
        return;
    }

    // iOS Safari requires enableHighAccuracy: true and a generous timeout
    // to wake the GPS chip rather than falling back to Wi-Fi triangulation.
    navigator.geolocation.getCurrentPosition(
        successGPS,
        errorGPS,
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
}

/**
 * successGPS(pos)
 * Validates the user's position against the tenant's geo anchor.
 * Builds an encrypted check-in payload for Edge Function dispatch,
 * then falls through to client-side haversine as a dev fallback.
 */
async function successGPS(pos) {
    const st = document.getElementById('geo-status');

    // Build payload for Edge Function (production path)
    const payload = await window._buildCheckinPayload(pos.coords.latitude, pos.coords.longitude);
    console.debug('[CheckIn] Payload preview:', payload.preview);

    // Read geo anchor — tenant context overrides the default anchor on login
    const anchorLat = window._GEO_ANCHOR.la;
    const anchorLon = window._GEO_ANCHOR.lo;
    const dist      = calculateHaversine(pos.coords.latitude, pos.coords.longitude, anchorLat, anchorLon);

    document.getElementById('distance-debug').innerText = `${dist.toFixed(3)} mi away`;

    if (dist <= CONFIG.ALLOWED_RADIUS_MILES) {
        window.generateTicket(payload);
    } else {
        st.className = 'text-center text-xs text-rose-600 font-mono bg-rose-50 p-3 rounded-lg border border-rose-100 mt-2';
        st.innerHTML = `<i class="fa-solid fa-ban"></i> <strong>Out of Bounds.</strong><br>`
                     + `You are ${dist.toFixed(2)} mi away. You must be inside the geofence to check in.`;
    }
}

/**
 * errorGPS(err)
 * Surfaces a human-readable GPS failure with platform-specific guidance.
 */
function errorGPS(err) {
    const st = document.getElementById('geo-status');
    st.className = 'text-center text-xs text-amber-600 font-mono bg-amber-50 p-3 rounded-lg border border-amber-100 mt-2';

    const messages = {
        1: 'Location permission denied. Please allow location access in your browser settings and try again.',
        2: 'GPS signal unavailable. Move to an open area or ensure Wi-Fi is enabled.',
        3: 'GPS timed out. Please try again — ensure location services are on.'
    };
    st.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> <strong>GPS Sync Issue.</strong><br>`
                 + (messages[err.code] || 'Unknown location error. Please try again.');
}

/**
 * captureCurrentLocationAsAnchor()
 * Admin utility — sets the geofence centre to the device's current position.
 */
function captureCurrentLocationAsAnchor() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(p => {
        document.getElementById('cfg-lat').value = p.coords.latitude.toFixed(4);
        document.getElementById('cfg-lon').value = p.coords.longitude.toFixed(4);
        // Update the live obfuscated anchor so in-session checks use the new coords
        window._GEO_ANCHOR.la = p.coords.latitude;
        window._GEO_ANCHOR.lo = p.coords.longitude;
    });
}

window.getDigitalTicket           = getDigitalTicket;
window.successGPS                 = successGPS;
window.errorGPS                   = errorGPS;
window.captureCurrentLocationAsAnchor = captureCurrentLocationAsAnchor;
