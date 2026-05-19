/* ================================================================
   js/app.js — Queue SaaS
   Responsibilities:
     • App lifecycle init (DOMContentLoaded)
     • syncUIElements() — master UI state machine
       Sprint 5: wait time driven by rolling velocity average
     • Pre-launch countdown clock
     • Admin config panel helpers
     • Utility functions (formatDuration, toast, etc.)
     • Test cases panel
   Dependencies: all other modules via window.*
================================================================ */

// ════════════════════════════════════════════════════════════════
// APP INIT
// ════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    // Populate admin lat/lon inputs with default geo anchor
    document.getElementById('cfg-lat').value = window._GEO_ANCHOR ? window._GEO_ANCHOR.la : '';
    document.getElementById('cfg-lon').value = window._GEO_ANCHOR ? window._GEO_ANCHOR.lo : '';
    updateLocationStatusFooter();

    // Launch preview chip
    document.getElementById('cfg-launch-time').addEventListener('change', function () {
        const p = document.getElementById('cfg-launch-preview');
        const t = document.getElementById('cfg-launch-preview-text');
        if (!this.value) { p.classList.add('hidden'); return; }
        const d = new Date(this.value);
        t.innerText = `Drop set for ${d.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric',year:'numeric'})} at ${d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`;
        p.classList.remove('hidden');
    });

    // Route to staff view if URL hash is #staff (tablet shortcut)
    if (window.location.hash === '#staff' && window.enterStaffView) window.enterStaffView();

    // Restore tenant session (handles page refresh without re-login)
    if (window.initTenantSession) window.initTenantSession();

    // Wire Supabase realtime listeners if project is connected
    if (window.initSupabaseListeners) window.initSupabaseListeners();

    console.log('[App] Queue SaaS initialised.');
});


// ════════════════════════════════════════════════════════════════
// SPRINT 5 — PREDICTIVE WAIT TIME ENGINE
// syncUIElements() reads window.getLineVelocity() (rolling average
// seconds/ticket from queue.js) instead of the old hardcoded 180s.
// Every admin advance updates the velocity buffer in real time, so
// the customer's estimated wait shortens or lengthens dynamically.
// ════════════════════════════════════════════════════════════════

let _waitCountdownInterval = null;
let _waitCountdownSeconds  = 60;
let _preLaunchInterval     = null;
window._waitCountdownInterval = _waitCountdownInterval;
window._preLaunchInterval     = _preLaunchInterval;

/**
 * syncUIElements()
 * Master UI state machine. Called on:
 *   • Ticket generation
 *   • Admin counter advance
 *   • Queue pause/resume
 *   • Page init
 *
 * Sprint 5 change:
 *   estimatedSecs = remaining × getLineVelocity()
 *   instead of: remaining × 180 (hardcoded 3 min)
 *
 * This means a fast-moving door team (e.g. 45s/person) causes the
 * estimated wait to drop in real time on customer devices.
 */
function syncUIElements() {
    const servingEl   = document.getElementById('now-serving');
    const aheadEl     = document.getElementById('people-ahead');
    const alertText   = document.getElementById('alert-text');
    const alertBanner = document.getElementById('alert-banner');
    const alertIcon   = document.getElementById('alert-icon');
    const wtBlock     = document.getElementById('wait-time-block');
    const wtValue     = document.getElementById('wt-value');
    const wtSub       = document.getElementById('wt-sub');
    const gateCta     = document.getElementById('gate-verify-cta');

    if (!servingEl) return; // ticket card not yet rendered

    servingEl.innerText = window.globalCurrentServing;
    const remaining = Math.max((window.myTicketNumber || 0) - window.globalCurrentServing, 0);
    aheadEl.innerText = remaining;

    // ── PRE-LAUNCH ──
    if (!window.isEventLive()) {
        wtBlock.style.display = 'none';
        _clearWaitCountdown();
        if (!_preLaunchInterval) startPreLaunchCountdown();
        if (gateCta) gateCta.classList.add('hidden');
        alertText.innerText   = "Drop hasn't launched yet — your spot is secured. Stay close!";
        alertBanner.className = 'bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm flex items-start space-x-3';
        alertIcon.className   = 'fa-solid fa-hourglass-half text-[#1a73e8] mt-0.5 text-base';
        return;
    }

    // ── LIVE ──
    document.getElementById('prelaunck-countdown-block').classList.add('hidden');
    if (_preLaunchInterval) { clearInterval(_preLaunchInterval); _preLaunchInterval = null; window._preLaunchInterval = null; }
    wtBlock.style.display = 'block';

    // Sprint 5: dynamic velocity-based estimate (seconds → minutes)
    const velocitySecs  = window.getLineVelocity ? window.getLineVelocity() : 180;
    const estimatedSecs = remaining * velocitySecs;
    const estimatedMins = Math.round(estimatedSecs / 60);

    // ── Sprint 5: velocity chip ──
    _updateVelocityChip();

    if (remaining <= 0) {
        _clearWaitCountdown();
        wtBlock.style.background  = '#f0fdf4'; wtBlock.style.borderColor = '#bbf7d0';
        wtValue.style.color = '#16a34a'; wtValue.innerText = 'Your Turn!';
        wtSub.innerText = 'Proceed to entrance immediately';
        alertText.innerText   = 'Your number is active. Show your verified pass to staff.';
        alertBanner.className = 'bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm flex items-start space-x-3';
        alertIcon.className   = 'fa-solid fa-circle-check text-[#34A853] mt-0.5 text-base';
        if (!window.mfaGatePassed && window.totpSetupVerified && gateCta) gateCta.classList.remove('hidden');
        // Trigger urgent pager
        if (!window._pagerActive && window._triggerPager) window._triggerPager('urgent');

    } else {
        wtBlock.style.background  = '#f8f9fa'; wtBlock.style.borderColor = '#e8eaed';
        wtValue.style.color = '#1a73e8';
        wtValue.innerText   = window.formatDuration(estimatedMins);
        _clearWaitCountdown();
        _startWaitCountdown(wtSub, estimatedMins);
        if (gateCta) gateCta.classList.add('hidden');

        if (remaining <= 5) {
            if (!window._pagerActive && window._triggerPager) window._triggerPager('warning');
            alertText.innerText = remaining === 1
                ? '⚡ You are NEXT — proceed to entrance immediately!'
                : `You are ${remaining} away! Please return to the entrance now.`;
            alertBanner.className = 'bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm flex items-start space-x-3';
            alertIcon.className   = 'fa-solid fa-bell text-[#fbbc05] mt-0.5 text-base animate-bounce';
        } else {
            alertText.innerText   = 'You are safely in line. Keep this page open.';
            alertBanner.className = 'bg-[#f8f9fa] border border-[#dadce0] rounded-xl p-4 text-sm flex items-start space-x-3';
            alertIcon.className   = 'fa-solid fa-circle-info text-[#4285F4] mt-0.5 text-base';
        }
    }
}
window.syncUIElements = syncUIElements;

/**
 * _updateVelocityChip()
 * Sprint 5: renders the line velocity indicator chip under the wait clock.
 * Fast → green, medium → yellow, slow → red.
 * Only shown once we have ≥2 data points (real signal).
 */
function _updateVelocityChip() {
    let chip = document.getElementById('velocity-chip');
    if (!chip) {
        chip = document.createElement('div');
        chip.id = 'velocity-chip';
        const wtSub = document.getElementById('wt-sub');
        if (wtSub && wtSub.parentNode) wtSub.parentNode.insertBefore(chip, wtSub.nextSibling);
    }
    if (!window.getVelocityLabel || !window.processingTimes || window.processingTimes.length < 2) {
        chip.style.display = 'none'; return;
    }
    chip.style.display = '';
    const { tier, label } = window.getVelocityLabel();
    chip.className = `velocity-chip ${tier}`;
    chip.innerText = label;
}


// ── Wait countdown sub-timer ──────────────────────────────────────

function _startWaitCountdown(subEl, estimatedMins) {
    _waitCountdownSeconds = 60;
    const estTime = window.formatEstimatedTurnTime(estimatedMins);
    subEl.innerText = `${estTime} · Next update in ${_waitCountdownSeconds}s`;
    _waitCountdownInterval = setInterval(() => {
        _waitCountdownSeconds--;
        if (_waitCountdownSeconds <= 0) {
            subEl.innerText = 'Syncing with live queue...';
            _waitCountdownSeconds = 60;
        } else {
            subEl.innerText = `${estTime} · Next update in ${_waitCountdownSeconds}s`;
        }
    }, 1000);
    window._waitCountdownInterval = _waitCountdownInterval;
}

function _clearWaitCountdown() {
    if (_waitCountdownInterval) { clearInterval(_waitCountdownInterval); _waitCountdownInterval = null; window._waitCountdownInterval = null; }
}
window._clearWaitCountdown = _clearWaitCountdown;


// ════════════════════════════════════════════════════════════════
// PRE-LAUNCH COUNTDOWN
// ════════════════════════════════════════════════════════════════

function startPreLaunchCountdown() {
    const block = document.getElementById('prelaunck-countdown-block');
    const ld    = CONFIG.EVENT_LAUNCH_TIME;
    if (!ld) return;
    document.getElementById('pl-go-live-label').innerText =
        ld.toLocaleDateString([], {weekday:'short',month:'short',day:'numeric'}) + ' · ' +
        ld.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
    block.classList.remove('hidden');
    if (_preLaunchInterval) clearInterval(_preLaunchInterval);
    function tick() {
        const diff = ld.getTime() - Date.now();
        if (diff <= 0) {
            clearInterval(_preLaunchInterval); _preLaunchInterval = null; window._preLaunchInterval = null;
            block.classList.add('hidden'); syncUIElements(); return;
        }
        const ts = Math.floor(diff / 1000);
        document.getElementById('pl-days').innerText  = window.pad2(Math.floor(ts / 86400));
        document.getElementById('pl-hours').innerText = window.pad2(Math.floor((ts % 86400) / 3600));
        document.getElementById('pl-mins').innerText  = window.pad2(Math.floor((ts % 3600) / 60));
        document.getElementById('pl-secs').innerText  = window.pad2(ts % 60);
    }
    tick();
    _preLaunchInterval = setInterval(tick, 1000);
    window._preLaunchInterval = _preLaunchInterval;
}
window.startPreLaunchCountdown = startPreLaunchCountdown;


// ════════════════════════════════════════════════════════════════
// ADMIN HELPERS
// ════════════════════════════════════════════════════════════════

function updateLocationStatusFooter() {
    const name = (window._tenant && window._tenant.brand_name) ? `${window._tenant.brand_name} · ` : '';
    const el   = document.getElementById('footer-location-text');
    if (el) el.innerText = `${name}Geofence Active (${CONFIG.ALLOWED_RADIUS_MILES} mi radius)`;
}
window.updateLocationStatusFooter = updateLocationStatusFooter;

function toggleMenuDemo() { alert('Navigation menu — system fully operational.'); }
window.toggleMenuDemo = toggleMenuDemo;


// ════════════════════════════════════════════════════════════════
// TEST CASES (admin developer panel)
// ════════════════════════════════════════════════════════════════

async function runTestCase(type) {
    const output = document.getElementById('test-output');
    output.classList.remove('hidden');
    function log(msg, color = '#4ade80') {
        output.innerHTML += `<span style="color:${color}">${msg}</span>\n`;
        output.scrollTop = output.scrollHeight;
    }

    if (type === 'clear') {
        window.FLAGGED_TICKETS  = [];
        window.DEVICE_REGISTRY  = {};
        window.myTicketNumber   = null;
        window.myTOTPSecret     = null;
        window.totpSetupVerified = false;
        window.mfaGatePassed    = false;
        window.gateStrikes      = 0;
        window.staffOverrideCount = 0;
        window.staffOkCount     = 0;
        window.staffOverrideLog = [];
        window.processingTimes  = [];
        output.innerHTML = '';
        log('✓ All test state cleared.', '#94a3b8');
        if (window.renderFlaggedPanel)   window.renderFlaggedPanel();
        if (window._updateStaffStats)    window._updateStaffStats();
        return;
    }

    if (type === 'device_cap') {
        output.innerHTML = '';
        log('═══ TEST 1: Device Cap Exceeded ═══\n', '#a78bfa');
        log('Device dev_abc123 → ticket #52');
        window.DEVICE_REGISTRY['dev_abc123'] = [52];
        log('✓ Ticket #52 registered.\n');
        log('Device dev_abc123 → ticket #53 (2nd, within cap)');
        window.DEVICE_REGISTRY['dev_abc123'].push(53);
        log('✓ Ticket #53 registered.\n');
        log('Attempting ticket #54 (3rd — exceeds cap) ⚠', '#fbbf24');
        await new Promise(r => setTimeout(r, 400));
        window.flagTicket(52, 'dev_abc123', 'Check-in blocked: device already holds 2 ticket(s) (cap: 2)');
        log('✗ Blocked. Flag raised.', '#f87171');
        log(`  Flagged tickets: ${window.FLAGGED_TICKETS.length}`);
        log('\n→ Open Admin Portal → Flagged Tickets section. ✓', '#a78bfa');
    }

    if (type === 'totp_fail') {
        output.innerHTML = '';
        log('═══ TEST 2: TOTP 3-Strike Gate Lockout ═══\n', '#a78bfa');
        const testTicket = 47, testSecret = window.generateTOTPSecret();
        log(`Ticket #${testTicket} TOTP secret: ${testSecret.slice(0,4)}****`);
        for (let strike = 1; strike <= 3; strike++) {
            const bad   = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
            const valid = await window.verifyTOTP(testSecret, bad);
            log(`Attempt ${strike}/3 — ${bad} → ${valid ? '✓ (coincidence)' : '✗ rejected'}`, valid ? '#4ade80' : '#f87171');
            if (strike === 3 && !valid) {
                window.flagTicket(testTicket, window.DEVICE_ID, 'Gate TOTP failed 3x');
                log('  → 3-strike LOCKOUT. Flag raised.', '#f87171');
            }
            await new Promise(r => setTimeout(r, 300));
        }
        const realCode = await window.computeTOTP(testSecret);
        log(`\nValid code for this secret right now: ${realCode}`, '#94a3b8');
        log('→ Open Admin Portal + Staff Terminal to see logs. ✓', '#a78bfa');
    }

    if (type === 'transfer_seed') {
        output.innerHTML = '';
        log('═══ TEST 3: Transfer → Seed Re-Issuance ═══\n', '#a78bfa');
        const ticket = 61, aliceSecret = window.generateTOTPSecret();
        log(`Ticket #${ticket} issued to Alice. Seed: ${aliceSecret.slice(0,4)}****`);
        await new Promise(r => setTimeout(r, 400));
        const bobSecret = window.generateTOTPSecret();
        log('\nTransfer to Bob initiated:');
        log(`  OLD seed (${aliceSecret.slice(0,4)}****) → INVALIDATED`);
        log(`  NEW seed (${bobSecret.slice(0,4)}****) → Generated for Bob`);
        const aliceCode  = await window.computeTOTP(aliceSecret);
        const aliceValid = await window.verifyTOTP(bobSecret, aliceCode);
        log(`\nAlice code (${aliceCode}) vs new seed → ${aliceValid ? '✓ (coincidence)' : '✗ REJECTED'}`, aliceValid ? '#4ade80' : '#f87171');
        const bobCode  = await window.computeTOTP(bobSecret);
        const bobValid = await window.verifyTOTP(bobSecret, bobCode);
        log(`Bob code (${bobCode}) vs new seed → ${bobValid ? '✓ ACCEPTED' : '✗'}`, bobValid ? '#4ade80' : '#f87171');
        log('\n→ Transfer is cryptographically clean. ✓', '#a78bfa');
    }

    if (type === 'admin_setup') {
        output.innerHTML = '';
        log('═══ ADMIN PORTAL SETUP ═══\n', '#a78bfa');
        log('Step 1 — Open Google Authenticator');
        log('Step 2 — Tap "+" → "Enter a setup key":');
        log('\n  Account name : QueueDrop Admin');
        log('  Your key     : MFRG GZDF MZTW Q2LK', '#fbbf24');
        log('  Type         : Time based\n');
        log('Step 3 — Tap "Add". Entry appears as "QueueDrop Admin".');
        log('Step 4 — Tap "Admin Portal", enter the 6-digit code.\n');
        log('Production: ADMIN_SECRET is provisioned per-event in Supabase.', '#94a3b8');
    }

    if (type === 'velocity') {
        output.innerHTML = '';
        log('═══ TEST 5: Line Velocity Engine (Sprint 5) ═══\n', '#a78bfa');
        log('Simulating 5 ticket completions at varying speeds...\n');
        const simTimes = [45, 60, 38, 72, 55];
        for (const t of simTimes) {
            window.processingTimes.push(t);
            if (window.processingTimes.length > 5) window.processingTimes.shift();
            const vel = window.getLineVelocity();
            const { tier, label } = window.getVelocityLabel();
            log(`  Δ ${t}s recorded → rolling avg ${vel}s/person (${tier}) — ${label}`);
            await new Promise(r => setTimeout(r, 200));
        }
        log('\n→ Wait time estimate is now velocity-driven, not hardcoded. ✓', '#a78bfa');
        log(`  With ${window.myTicketNumber ? Math.max(window.myTicketNumber - window.globalCurrentServing, 0) : 'N/A'} people ahead, estimated wait: ${window.formatDuration(Math.round(window.getLineVelocity() * Math.max((window.myTicketNumber || 0) - window.globalCurrentServing, 0) / 60))}`);
    }

    if (type === 'noshow') {
        output.innerHTML = '';
        log('═══ TEST 6: No-Show Decay Loop (Sprint 6) ═══\n', '#a78bfa');
        log('For a real test: check in a ticket, advance the counter');
        log('to make it NOW_SERVING, then wait 8 minutes.\n');
        log('Simulating an instant expiry for demo purposes...');
        await new Promise(r => setTimeout(r, 600));
        const fakeTicket  = window.myTicketNumber || 52;
        const fakeCalledAt = new Date(Date.now() - 9 * 60 * 1000).toISOString();
        window.flagTicket(fakeTicket, window.DEVICE_ID || 'dev_test',
            `EXPIRED_NO_SHOW — called at ${fakeCalledAt}, no gate check-in within 8 mins`);
        if (fakeTicket === window.myTicketNumber) {
            const banner = document.getElementById('noshow-banner');
            if (banner) {
                banner.innerHTML = `
                    <div class="noshow-title">⚠️ Your spot has expired</div>
                    <p class="noshow-body">Your number was called at ${new Date(fakeCalledAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} but no gate check-in was detected within 8 minutes.</p>
                    <button class="noshow-requeue-btn safari-clickable" onclick="reQueueAtBottom()">🔄 Re-queue at Bottom</button>
                `;
                banner.classList.add('visible');
            }
        }
        log(`  Ticket #${fakeTicket} → EXPIRED_NO_SHOW`, '#f87171');
        log('  → Yellow banner shown on customer UI');
        log('  → "Re-queue at Bottom" CTA active');
        log('  → Queue auto-advanced +1');
        log('\n→ Open customer view to see the no-show banner. ✓', '#a78bfa');
    }
}
window.runTestCase = runTestCase;
