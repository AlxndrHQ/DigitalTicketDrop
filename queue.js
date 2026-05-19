/* ================================================================
   js/queue.js — Queue SaaS
   Responsibilities:
     • Global CONFIG + shared state
     • Ticket generation (device cap, TOTP seed, analytics)
     • Anti-scalper engine (device registry, flagging, transfers)
     • Admin line-flow controls (pause, advance, flush dead)
     • Sprint 5: Line velocity engine (rolling average of last 5 completions)
     • Sprint 6: No-show decay loop (8-min grace window, EXPIRED_NO_SHOW state)
     • Supabase real-time listener stubs
   Dependencies: window.DEVICE_ID (geo.js), window.generateTOTPSecret,
                 window.verifyTOTP (crypto.js), window.syncUIElements (app.js)
================================================================ */

// ════════════════════════════════════════════════════════════════
// GLOBAL CONFIG & SHARED STATE
// ════════════════════════════════════════════════════════════════

const CONFIG = {
    ALLOWED_RADIUS_MILES:  1.0,
    EVENT_LAUNCH_TIME:     null,
    TRANSFER_LOCKOUT_MINS: 30,
    MAX_TICKETS_PER_DEVICE: 2,
    TOTP_STEP_SECS:        30,
    TOTP_DIGITS:           6,
    GATE_MAX_STRIKES:      3,
    DROP_LOCATION_NAME:    'Queue Drop Event',
    MAX_CAPACITY:          200
};
window.CONFIG = CONFIG;

// ── Ticket state ──────────────────────────────────────────────────
let myTicketNumber    = null;
let myTOTPSecret      = null;
let totpSetupVerified = false;
let mfaGatePassed     = false;
let gateStrikes       = 0;
window.myTicketNumber    = myTicketNumber;
window.myTOTPSecret      = myTOTPSecret;
window.totpSetupVerified = totpSetupVerified;
window.mfaGatePassed     = mfaGatePassed;
window.gateStrikes       = gateStrikes;

// ── Queue counters ────────────────────────────────────────────────
let globalCurrentServing   = 1;
let _preLaunchInterval     = null;
let _waitCountdownInterval = null;
let _waitCountdownSeconds  = 60;
window.globalCurrentServing   = globalCurrentServing;
window._preLaunchInterval     = _preLaunchInterval;
window._waitCountdownInterval = _waitCountdownInterval;
window._waitCountdownSeconds  = _waitCountdownSeconds;

// ── Anti-scalper registries ───────────────────────────────────────
let DEVICE_REGISTRY = {};  // { deviceId: [ticketNumber, ...] }
let FLAGGED_TICKETS = [];  // [{ ticket, deviceId, reason, refCode, timestamp }]
window.DEVICE_REGISTRY = DEVICE_REGISTRY;
window.FLAGGED_TICKETS = FLAGGED_TICKETS;

// ── Pager / audio state ───────────────────────────────────────────
let _pagerActive        = false;
let _alertMuted         = false;
let _audioCtx           = null;
let _pagerVibrateHandle = null;
window._pagerActive        = _pagerActive;
window._alertMuted         = _alertMuted;
window._audioCtx           = _audioCtx;
window._pagerVibrateHandle = _pagerVibrateHandle;

// ── Analytics ─────────────────────────────────────────────────────
let _analytics = {
    totalCheckedIn:          0,
    activeGeofenced:         0,
    avgProcessingSecs:       0,
    _processingTimes:        [],
    queuePaused:             false,
    deadTicketThresholdMins: 10
};
window._analytics = _analytics;

// ── Staff ─────────────────────────────────────────────────────────
let _staffPinInterval  = null;
let staffOverrideCount = 0;
let staffOkCount       = 0;
let staffOverrideLog   = [];
window._staffPinInterval  = _staffPinInterval;
window.staffOverrideCount = staffOverrideCount;
window.staffOkCount       = staffOkCount;
window.staffOverrideLog   = staffOverrideLog;


// ════════════════════════════════════════════════════════════════
// SPRINT 5 — LINE VELOCITY ENGINE
// Replaces the hardcoded "3 mins per ticket" constant with a
// rolling average of the last 5 actual completion timestamps.
// Mirrors Waitwhile's WaitIQ real-time velocity calculation.
// ════════════════════════════════════════════════════════════════

/**
 * processingTimes[]
 * Ring buffer of the last N delta-timestamps (in seconds) captured each
 * time an admin advances the line. Written by recordTicketCompletion().
 * Read by getLineVelocity() and exposed to app.js via window.
 */
const VELOCITY_WINDOW     = 5;    // rolling average over last 5 completions
const VELOCITY_DEFAULT_S  = 180;  // fallback: 3 minutes per ticket (original hardcode)

let processingTimes       = [];   // [seconds, ...] — max VELOCITY_WINDOW entries
let _lastAdvanceTimestamp = null; // ISO timestamp of most recent advance action
window.processingTimes    = processingTimes;

/**
 * recordTicketCompletion()
 * Called every time adjustAdminCounter() advances the queue by any amount.
 * Captures the delta in seconds since the last advance and pushes it to the
 * processingTimes ring buffer.
 *
 * Sprint 6 integration: also stamps called_at on the newly active ticket.
 */
function recordTicketCompletion() {
    const now = Date.now();
    if (_lastAdvanceTimestamp !== null) {
        const deltaSecs = Math.round((now - _lastAdvanceTimestamp) / 1000);
        // Sanity clamp: ignore deltas over 20 minutes (idle admin, lunch break, etc.)
        if (deltaSecs > 0 && deltaSecs < 1200) {
            processingTimes.push(deltaSecs);
            if (processingTimes.length > VELOCITY_WINDOW) processingTimes.shift();
            window.processingTimes = processingTimes;
            console.debug(`[Velocity] Δ ${deltaSecs}s recorded. Buffer: [${processingTimes.join(', ')}]`);
        }
    }
    _lastAdvanceTimestamp = now;

    // Sprint 6: stamp called_at for the new NOW_SERVING ticket
    _stampCalledAt(globalCurrentServing);
}

/**
 * getLineVelocity()
 * Returns the rolling average seconds-per-ticket across the last
 * VELOCITY_WINDOW completions. Falls back to VELOCITY_DEFAULT_S when
 * fewer than 2 data points exist (not enough signal yet).
 *
 * Used by app.js → syncUIElements() to compute dynamic wait estimates.
 */
function getLineVelocity() {
    if (processingTimes.length < 2) return VELOCITY_DEFAULT_S;
    const sum = processingTimes.reduce((a, b) => a + b, 0);
    return Math.round(sum / processingTimes.length);
}
window.getLineVelocity = getLineVelocity;

/**
 * getVelocityLabel()
 * Returns a human-readable speed tier for the velocity chip UI element.
 * Thresholds: fast < 90s, medium < 180s, slow ≥ 180s.
 */
function getVelocityLabel() {
    const v = getLineVelocity();
    if (v < 90)  return { tier: 'fast',   label: `⚡ ${Math.round(v/60*10)/10} min/person` };
    if (v < 180) return { tier: 'medium', label: `⏱ ${Math.round(v/60*10)/10} min/person` };
    return              { tier: 'slow',   label: `🐢 ${Math.round(v/60*10)/10} min/person` };
}
window.getVelocityLabel = getVelocityLabel;


// ════════════════════════════════════════════════════════════════
// SPRINT 6 — NO-SHOW DECAY LOOP
// Mirrors enterprise no-show management (e.g. Yelp Waitlist).
// An 8-minute grace window fires after a ticket becomes NOW_SERVING.
// If no gate MFA check-in occurs within the window, the ticket
// transitions to EXPIRED_NO_SHOW and the queue auto-advances.
// ════════════════════════════════════════════════════════════════

const NO_SHOW_GRACE_SECS = 480; // 8 minutes

/**
 * activeNoShowTimers
 * Map of ticketNumber → { timerId, calledAt }.
 * Kept separate from main state to avoid polluting the render loop.
 */
const activeNoShowTimers = new Map();

/**
 * _stampCalledAt(ticketNumber)
 * Records the high-precision ISO timestamp at which a ticket enters
 * the NOW_SERVING state. Starts the grace window timer.
 *
 * In production: write called_at to Supabase tickets table.
 * The Edge Function can also run this timer server-side for robustness.
 */
function _stampCalledAt(ticketNumber) {
    // Clear any existing timer for this ticket (re-serves after re-queue)
    _clearNoShowTimer(ticketNumber);

    const calledAt = new Date().toISOString();
    console.debug(`[NoShow] Ticket #${ticketNumber} → NOW_SERVING at ${calledAt}`);

    // Start the 8-minute grace window
    const timerId = setTimeout(() => {
        _triggerNoShow(ticketNumber, calledAt);
    }, NO_SHOW_GRACE_SECS * 1000);

    activeNoShowTimers.set(ticketNumber, { timerId, calledAt });

    // Production Supabase write:
    // await supabase.from('tickets')
    //   .update({ status: 'NOW_SERVING', called_at: calledAt })
    //   .eq('ticket_number', ticketNumber)
    //   .eq('tenant_id', _tenant.id)
}

/**
 * _clearNoShowTimer(ticketNumber)
 * Cancels a pending grace window timer. Called on successful gate check-in
 * (MFA pass) or on explicit re-queue action.
 */
function _clearNoShowTimer(ticketNumber) {
    if (activeNoShowTimers.has(ticketNumber)) {
        clearTimeout(activeNoShowTimers.get(ticketNumber).timerId);
        activeNoShowTimers.delete(ticketNumber);
        console.debug(`[NoShow] Timer cleared for #${ticketNumber}`);
    }
}
window._clearNoShowTimer = _clearNoShowTimer;

/**
 * _triggerNoShow(ticketNumber, calledAt)
 * Fires when the grace window expires without a gate check-in.
 *
 * Actions:
 *   1. Flag ticket as EXPIRED_NO_SHOW in local state + Supabase
 *   2. Show yellow warning banner on customer UI with "Re-queue" CTA
 *   3. Auto-advance the master queue forward by 1
 *   4. Update analytics
 */
function _triggerNoShow(ticketNumber, calledAt) {
    console.warn(`[NoShow] Ticket #${ticketNumber} expired — no gate check-in within ${NO_SHOW_GRACE_SECS}s of ${calledAt}`);
    activeNoShowTimers.delete(ticketNumber);

    // ── Update local flag state ──
    flagTicket(ticketNumber, window.DEVICE_ID || 'unknown',
        `EXPIRED_NO_SHOW — called at ${calledAt}, no gate check-in within ${NO_SHOW_GRACE_SECS / 60} mins`);

    // ── Show no-show banner on customer-facing ticket card ──
    if (ticketNumber === window.myTicketNumber) {
        _showNoShowBanner(calledAt);
    }

    // Production Supabase write:
    // await supabase.from('tickets')
    //   .update({ status: 'EXPIRED_NO_SHOW', expired_at: new Date().toISOString() })
    //   .eq('ticket_number', ticketNumber)
    //   .eq('tenant_id', _tenant.id)

    // ── Auto-advance queue ──
    // Run on a microtask so the UI paint from the banner completes first
    Promise.resolve().then(() => {
        globalCurrentServing = Math.max(1, globalCurrentServing + 1);
        window.globalCurrentServing = globalCurrentServing;
        const el = document.getElementById('admin-serving-number');
        if (el) el.innerText = globalCurrentServing;
        _updateAnalyticsDisplay();
        recordTicketCompletion();            // stamp the auto-advance in velocity buffer
        if (window.syncUIElements) window.syncUIElements();
    });
}

/**
 * _showNoShowBanner(calledAt)
 * Renders a yellow warning banner on the customer's ticket card.
 * Offers a single "Re-queue at Bottom" action.
 */
function _showNoShowBanner(calledAt) {
    const banner = document.getElementById('noshow-banner');
    if (!banner) return;
    banner.innerHTML = `
        <div class="noshow-title">⚠️ Your spot has expired</div>
        <p class="noshow-body">
            Your number was called at ${new Date(calledAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}
            but no gate check-in was detected within ${NO_SHOW_GRACE_SECS / 60} minutes.
            Your position has been released to keep the line moving.
        </p>
        <button class="noshow-requeue-btn safari-clickable" onclick="reQueueAtBottom()">
            🔄 Re-queue at Bottom
        </button>
    `;
    banner.classList.add('visible');

    // Dim the rest of the ticket card
    const card = document.getElementById('ticket-card');
    if (card) card.style.opacity = '0.7';
}

/**
 * reQueueAtBottom()
 * One-time "Re-queue" action offered to an expired-no-show customer.
 * Assigns them a new ticket number at the back of the current queue.
 */
function reQueueAtBottom() {
    const banner = document.getElementById('noshow-banner');
    if (banner) banner.classList.remove('visible');
    const card = document.getElementById('ticket-card');
    if (card) card.style.opacity = '';

    // Re-issue at back of queue
    const oldTicket = window.myTicketNumber;
    window.myTicketNumber = globalCurrentServing + Object.values(DEVICE_REGISTRY).flat().length;
    myTicketNumber = window.myTicketNumber;

    // Update registry
    if (DEVICE_REGISTRY[window.DEVICE_ID]) {
        DEVICE_REGISTRY[window.DEVICE_ID] = DEVICE_REGISTRY[window.DEVICE_ID]
            .filter(t => t !== oldTicket);
        DEVICE_REGISTRY[window.DEVICE_ID].push(window.myTicketNumber);
    }

    window._pagerActive = false;
    document.getElementById('pager-banner').classList.remove('visible');
    document.getElementById('user-number').innerText = `#${window.myTicketNumber}`;

    if (window.syncUIElements)    window.syncUIElements();
    if (window.syncTransferLockState) window.syncTransferLockState();
    if (window.initQRRotation)    window.initQRRotation();
    if (window._showToast) window._showToast(`Re-queued as #${window.myTicketNumber} — good luck!`, 'amber');
}
window.reQueueAtBottom = reQueueAtBottom;


// ════════════════════════════════════════════════════════════════
// TICKET GENERATION
// ════════════════════════════════════════════════════════════════

function generateTicket(payload) {
    // Device cap check
    const existing = DEVICE_REGISTRY[window.DEVICE_ID] || [];
    if (existing.length >= CONFIG.MAX_TICKETS_PER_DEVICE) {
        flagTicket(existing[0], window.DEVICE_ID,
            `Check-in blocked: device already holds ${existing.length} ticket(s) (cap: ${CONFIG.MAX_TICKETS_PER_DEVICE})`);
        const st = document.getElementById('geo-status');
        st.className = 'text-center text-xs text-rose-600 font-mono bg-rose-50 p-3 rounded-lg border border-rose-100 mt-2';
        st.innerHTML = `<i class="fa-solid fa-ban"></i> <strong>Limit reached.</strong><br>`
                     + `Max of ${CONFIG.MAX_TICKETS_PER_DEVICE} tickets per device. This attempt has been flagged.`;
        return;
    }

    myTicketNumber = Math.floor(Math.random() * 12) + 45;
    window.myTicketNumber = myTicketNumber;
    if (!DEVICE_REGISTRY[window.DEVICE_ID]) DEVICE_REGISTRY[window.DEVICE_ID] = [];
    DEVICE_REGISTRY[window.DEVICE_ID].push(myTicketNumber);

    myTOTPSecret      = window.generateTOTPSecret();
    window.myTOTPSecret = myTOTPSecret;
    totpSetupVerified = false; window.totpSetupVerified = false;
    mfaGatePassed     = false; window.mfaGatePassed     = false;
    gateStrikes       = 0;     window.gateStrikes       = 0;

    // Render ticket card
    document.getElementById('join-card').classList.add('hidden');
    document.getElementById('ticket-card').classList.remove('hidden');
    document.getElementById('user-number').innerText = `#${myTicketNumber}`;
    const now = new Date();
    document.getElementById('timestamp-display').innerText =
        `Secured at ${now.toLocaleDateString([], {month:'short',day:'numeric'})} · ${now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
    document.getElementById('mfa-verified-badge').classList.remove('visible');

    // Analytics
    _analytics.totalCheckedIn++;
    _analytics.activeGeofenced++;
    window._analytics = _analytics;
    _updateAnalyticsDisplay();

    if (window.syncUIElements)        window.syncUIElements();
    if (window.syncTransferLockState) window.syncTransferLockState();
    if (window.initQRRotation)        window.initQRRotation();

    setTimeout(() => { if (window.openTOTPSetupModal) window.openTOTPSetupModal(); }, 800);
}
window.generateTicket = generateTicket;


// ════════════════════════════════════════════════════════════════
// ANTI-SCALPER ENGINE
// ════════════════════════════════════════════════════════════════

function isTransferLocked() {
    if (!CONFIG.EVENT_LAUNCH_TIME) return { locked: true, reason: 'Drop is live — transfers are disabled.' };
    const ms   = CONFIG.EVENT_LAUNCH_TIME.getTime() - Date.now();
    if (ms <= 0) return { locked: true, reason: 'Drop is live — transfers are disabled.' };
    const mins = ms / 60000;
    if (mins <= CONFIG.TRANSFER_LOCKOUT_MINS)
        return { locked: true, reason: `Transfers locked — drop starts in ${Math.ceil(mins)} mins.` };
    return { locked: false, reason: '' };
}
window.isTransferLocked = isTransferLocked;

function syncTransferLockState() {
    if (!window.myTicketNumber) return;
    const { locked, reason } = isTransferLocked();
    const banner  = document.getElementById('transfer-cooldown-banner');
    const bannerT = document.getElementById('transfer-cooldown-text');
    const xferBtn = document.querySelector('[onclick="openTransferModal()"]');
    const swapBtn = document.querySelector('[onclick="openSwapModal()"]');
    if (locked) {
        banner.classList.add('visible'); bannerT.innerText = reason;
        [xferBtn, swapBtn].forEach(b => { if (!b) return; b.style.opacity='0.4'; b.style.pointerEvents='none'; b.setAttribute('aria-disabled','true'); });
    } else {
        banner.classList.remove('visible');
        [xferBtn, swapBtn].forEach(b => { if (!b) return; b.style.opacity=''; b.style.pointerEvents=''; b.removeAttribute('aria-disabled'); });
    }
}
window.syncTransferLockState = syncTransferLockState;

function flagTicket(ticketNumber, deviceId, reason) {
    const refCode = `FLAG-${ticketNumber}-${(deviceId || 'UNK').slice(-4).toUpperCase()}`;
    const entry   = { ticket: ticketNumber, deviceId, reason, refCode, timestamp: _nowStr() };
    if (!FLAGGED_TICKETS.some(f => f.ticket === ticketNumber && f.reason === reason)) {
        FLAGGED_TICKETS.push(entry);
        console.warn(`[Flag] #${ticketNumber}: ${reason} (${refCode})`);
    }
    if (ticketNumber === window.myTicketNumber || window.myTicketNumber === null)
        _showSuspiciousActivityNotice(reason, refCode);
    renderFlaggedPanel();
    _updateStaffStats();
}
window.flagTicket = flagTicket;

function _showSuspiciousActivityNotice(reason, refCode) {
    const notice = document.getElementById('suspicious-activity-notice');
    const bodyEl = document.getElementById('san-body-text');
    const refEl  = document.getElementById('san-ref-code');
    if (!notice) return;
    if (reason.includes('already holds'))
        bodyEl.innerText = "Our system detected this device is already associated with one or more tickets. If you're holding a spot for a friend, just show this notice to staff at the entrance.";
    else if (reason.includes('TOTP') || reason.includes('strike'))
        bodyEl.innerText = "There were multiple failed identity verification attempts on this ticket. Your spot is still held — please speak to a staff member at the gate.";
    else if (reason.includes('NO_SHOW'))
        bodyEl.innerText = "Your ticket was flagged as a no-show after the grace window expired. Use the Re-queue button to rejoin the line.";
    else
        bodyEl.innerText = "Our system flagged unusual activity on this device. A staff member can clear this for you immediately at the entrance.";
    refEl.innerHTML = `<i class="fa-solid fa-barcode mr-1"></i>Reference: <strong>${refCode}</strong>`;
    notice.classList.add('visible');
}

function showFlagHelpInfo() {
    const ref = document.getElementById('san-ref-code').innerText.replace('Reference:', '').trim();
    alert(`Account Review — What this means:\n\nOur queue system uses automatic checks to keep things fair. Your device triggered one of these checks, which is sometimes a false positive.\n\nWhat to do:\n→ Keep this screen open and proceed to the entrance.\n→ Show your ticket and this notice to any staff member.\n→ They can look up your reference code and clear it in seconds.\n\nYour spot is still held — this notice does NOT cancel your place in line.\n\n${ref}`);
}
window.showFlagHelpInfo = showFlagHelpInfo;

function renderFlaggedPanel() {
    const list  = document.getElementById('flagged-tickets-list');
    const empty = document.getElementById('flagged-empty-state');
    const badge = document.getElementById('flag-count-badge');
    if (!list) return;
    badge.innerText = FLAGGED_TICKETS.length;
    if (!FLAGGED_TICKETS.length) {
        list.innerHTML = ''; list.appendChild(empty); empty.style.display = 'block'; return;
    }
    empty.style.display = 'none';
    list.innerHTML = FLAGGED_TICKETS.map((f, i) => `
        <div class="flagged-ticket-row">
            <div class="flag-info">
                <div class="flag-num"><i class="fa-solid fa-triangle-exclamation text-amber-500 mr-1 text-xs"></i>Ticket #${f.ticket}</div>
                <div class="flag-reason">${f.reason}</div>
                <div class="flag-reason" style="color:#9ca3af;margin-top:2px;font-family:monospace;">${f.refCode} · ${f.timestamp}</div>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;">
                <button class="flag-action-btn flag-action-approve" onclick="clearFlag(${i})"><i class="fa-solid fa-check mr-1"></i>Approve</button>
                <button class="flag-action-btn flag-action-dismiss" onclick="dismissFlag(${i})"><i class="fa-solid fa-xmark mr-1"></i>Revoke</button>
            </div>
        </div>`).join('');
}
window.renderFlaggedPanel = renderFlaggedPanel;

function clearFlag(i) {
    const f = FLAGGED_TICKETS[i]; FLAGGED_TICKETS.splice(i, 1);
    if (!FLAGGED_TICKETS.some(fl => fl.ticket === window.myTicketNumber))
        document.getElementById('suspicious-activity-notice').classList.remove('visible');
    staffOverrideLog.push({ time: _nowStr(), msg: `✓ Ticket #${f.ticket} cleared by staff`, type: 'ok' });
    _renderStaffLog(); renderFlaggedPanel(); _updateStaffStats();
}
function dismissFlag(i) {
    const f = FLAGGED_TICKETS[i]; FLAGGED_TICKETS.splice(i, 1);
    if (DEVICE_REGISTRY[f.deviceId])
        DEVICE_REGISTRY[f.deviceId] = DEVICE_REGISTRY[f.deviceId].filter(t => t !== f.ticket);
    staffOverrideLog.push({ time: _nowStr(), msg: `✗ Ticket #${f.ticket} revoked by staff`, type: 'warn' });
    _renderStaffLog(); renderFlaggedPanel(); _updateStaffStats();
}
window.clearFlag   = clearFlag;
window.dismissFlag = dismissFlag;


// ════════════════════════════════════════════════════════════════
// TRANSFER & SWAP
// ════════════════════════════════════════════════════════════════

function openTransferModal()  { document.getElementById('transfer-modal').classList.remove('hidden'); document.getElementById('transfer-recipient-input').value=''; document.getElementById('transfer-status-msg').classList.add('hidden'); }
function closeTransferModal() { document.getElementById('transfer-modal').classList.add('hidden'); }
function openSwapModal()      { document.getElementById('swap-modal').classList.remove('hidden'); document.getElementById('swap-target-input').value=''; document.getElementById('swap-status-msg').classList.add('hidden'); }
function closeSwapModal()     { document.getElementById('swap-modal').classList.add('hidden'); }

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('transfer-modal').addEventListener('click', e => { if (e.target === document.getElementById('transfer-modal')) closeTransferModal(); });
    document.getElementById('swap-modal').addEventListener('click',     e => { if (e.target === document.getElementById('swap-modal'))     closeSwapModal(); });
});

async function initiateTransfer() {
    const recipient = document.getElementById('transfer-recipient-input').value.trim();
    const statusMsg = document.getElementById('transfer-status-msg');
    const { locked, reason } = isTransferLocked();
    if (locked)     { statusMsg.innerText = reason;                                  statusMsg.classList.remove('hidden'); return; }
    if (!recipient) { statusMsg.innerText = 'Please enter a recipient ID or email.'; statusMsg.classList.remove('hidden'); return; }

    window.myTOTPSecret      = window.generateTOTPSecret();
    myTOTPSecret             = window.myTOTPSecret;
    window.totpSetupVerified = false;
    window.mfaGatePassed     = false;
    document.getElementById('mfa-verified-badge').classList.remove('visible');
    console.log(`[Transfer] Old TOTP seed invalidated. New seed for recipient. Ticket #${window.myTicketNumber} → ${recipient}`);
    await new Promise(r => setTimeout(r, 500));
    alert(`Transfer request sent.\nTicket #${window.myTicketNumber} → ${recipient}\n\nFresh authenticator setup link sent to recipient.\nYour previous TOTP seed has been permanently invalidated.`);
    closeTransferModal();
}

async function proposeSwap() {
    const target    = parseInt(document.getElementById('swap-target-input').value, 10);
    const statusMsg = document.getElementById('swap-status-msg');
    const { locked, reason } = isTransferLocked();
    if (locked)                          { statusMsg.innerText = reason;                            statusMsg.classList.remove('hidden'); return; }
    if (!target || target < 1)           { statusMsg.innerText = 'Enter a valid ticket number.';    statusMsg.classList.remove('hidden'); return; }
    if (target === window.myTicketNumber){ statusMsg.innerText = "Can't swap with your own ticket."; statusMsg.classList.remove('hidden'); return; }
    await new Promise(r => setTimeout(r, 500));
    alert(`Swap proposal sent.\n#${window.myTicketNumber} ↔ #${target}\n\nBoth spots in escrow. Each party gets a fresh TOTP seed after acceptance.`);
    closeSwapModal();
}

window.openTransferModal  = openTransferModal;
window.closeTransferModal = closeTransferModal;
window.openSwapModal      = openSwapModal;
window.closeSwapModal     = closeSwapModal;
window.initiateTransfer   = initiateTransfer;
window.proposeSwap        = proposeSwap;


// ════════════════════════════════════════════════════════════════
// ADMIN LINE-FLOW CONTROLS
// ════════════════════════════════════════════════════════════════

/**
 * adjustAdminCounter(amount)
 * Advances or rewinds the Now Serving counter.
 * Feeds the velocity engine and stamps called_at for the new ticket.
 */
function adjustAdminCounter(amount) {
    if (_analytics.queuePaused) { _showToast('Queue is paused — resume before advancing.', 'amber'); return; }
    globalCurrentServing = Math.max(1, globalCurrentServing + amount);
    window.globalCurrentServing = globalCurrentServing;
    document.getElementById('admin-serving-number').innerText = globalCurrentServing;
    recordTicketCompletion();   // Sprint 5 + Sprint 6
    _updateAnalyticsDisplay();
    if (window.syncUIElements) window.syncUIElements();
}
window.adjustAdminCounter = adjustAdminCounter;

function toggleQueuePause() {
    _analytics.queuePaused = !_analytics.queuePaused;
    const btn   = document.getElementById('pause-queue-btn');
    const icon  = document.getElementById('pause-icon');
    const label = document.getElementById('pause-label');
    const badge = document.getElementById('queue-paused-badge');
    if (_analytics.queuePaused) {
        btn.style.background = '#16a34a'; icon.className = 'fa-solid fa-play'; label.innerText = 'Resume Queue';
        badge.classList.remove('hidden');
        _showToast('Queue paused — no line progression until resumed.', 'amber');
    } else {
        btn.style.background = ''; icon.className = 'fa-solid fa-pause'; label.innerText = 'Pause Queue';
        badge.classList.add('hidden');
        _showToast('Queue resumed.', 'green');
    }
    if (window.syncUIElements) window.syncUIElements();
}
window.toggleQueuePause = toggleQueuePause;

function flushDeadTickets() {
    const threshold    = _analytics.deadTicketThresholdMins;
    const cutoffTicket = globalCurrentServing - Math.floor(threshold / 3);
    let flushed = 0;
    for (const deviceId in DEVICE_REGISTRY) {
        const before = DEVICE_REGISTRY[deviceId].length;
        DEVICE_REGISTRY[deviceId] = DEVICE_REGISTRY[deviceId].filter(t => t >= cutoffTicket);
        flushed += before - DEVICE_REGISTRY[deviceId].length;
        if (!DEVICE_REGISTRY[deviceId].length) delete DEVICE_REGISTRY[deviceId];
    }
    _updateAnalyticsDisplay();
    _showToast(flushed > 0
        ? `Flushed ${flushed} dead ticket${flushed!==1?'s':''} (called >${threshold} mins ago).`
        : 'No dead tickets found — queue is clean.', flushed > 0 ? 'amber' : 'green');
}
window.flushDeadTickets = flushDeadTickets;

function applyBrandSettings() {
    const name     = document.getElementById('cfg-location-name').value.trim();
    const cap      = parseInt(document.getElementById('cfg-max-capacity').value, 10);
    const deadMins = parseInt(document.getElementById('cfg-dead-threshold').value, 10);
    if (name) {
        CONFIG.DROP_LOCATION_NAME = name;
        const dn = document.getElementById('admin-drop-name-display');
        const ds = document.getElementById('admin-drop-subtitle');
        if (dn) dn.innerText = name;
        if (ds) ds.innerText = 'Live Drop Controller · ' + name;
        if (window.updateLocationStatusFooter) window.updateLocationStatusFooter();
    }
    if (!isNaN(cap) && cap > 0) CONFIG.MAX_CAPACITY = cap;
    if (!isNaN(deadMins) && deadMins > 0) {
        _analytics.deadTicketThresholdMins = deadMins;
        const lbl = document.getElementById('dead-threshold-label');
        if (lbl) lbl.innerText = deadMins;
    }
    _showToast('Brand settings applied.', 'green');
}
window.applyBrandSettings = applyBrandSettings;

function _updateAnalyticsDisplay() {
    const allTickets = Object.values(DEVICE_REGISTRY).flat();
    _analytics.totalCheckedIn  = allTickets.length;
    _analytics.activeGeofenced = allTickets.filter(t => t >= globalCurrentServing).length;
    const ciEl = document.getElementById('stat-checked-in');
    const gfEl = document.getElementById('stat-geofenced');
    const atEl = document.getElementById('stat-avg-time');
    if (ciEl) ciEl.innerText = _analytics.totalCheckedIn;
    if (gfEl) gfEl.innerText = _analytics.activeGeofenced;
    if (atEl) atEl.innerText = _analytics._processingTimes.length
        ? Math.round(_analytics._processingTimes.reduce((a,b)=>a+b,0) / _analytics._processingTimes.length)
        : '--';
}
window._updateAnalyticsDisplay = _updateAnalyticsDisplay;

function recordProcessingTime(seconds) {
    _analytics._processingTimes.push(seconds);
    if (_analytics._processingTimes.length > 20) _analytics._processingTimes.shift();
    _updateAnalyticsDisplay();
}
window.recordProcessingTime = recordProcessingTime;


// ════════════════════════════════════════════════════════════════
// STAFF VIEW
// ════════════════════════════════════════════════════════════════

const STAFF_SECRET       = 'JBSWY3DPEHPK3PXP'; // Demo only — replace in production
const STAFF_CIRCUMFERENCE = 2 * Math.PI * 34;
let _preStaffViewWasAdmin = false;

function enterStaffView() {
    _preStaffViewWasAdmin = window._adminViewOpen || false;
    document.querySelector('header').style.display = 'none';
    document.querySelector('main').style.display   = 'none';
    document.querySelector('footer').style.display = 'none';
    document.getElementById('staff-view').classList.add('active');
    window.location.hash = '#staff';
    _startStaffPinClock();
}

function exitStaffView() {
    document.querySelector('header').style.display = '';
    document.querySelector('main').style.display   = '';
    document.querySelector('footer').style.display = '';
    document.getElementById('staff-view').classList.remove('active');
    window.location.hash = '';
    if (window._staffPinInterval) { clearInterval(window._staffPinInterval); window._staffPinInterval = null; }
    if (window._setAdminView) window._setAdminView(_preStaffViewWasAdmin);
}

async function _startStaffPinClock() {
    async function tick() {
        const now  = Date.now();
        const code = await window.computeTOTP(STAFF_SECRET, now);
        const el   = document.getElementById('staff-pin-display');
        if (el) el.innerText = code.slice(0, 4);
        const elapsed   = Math.floor(now / 1000) % CONFIG.TOTP_STEP_SECS;
        const remaining = CONFIG.TOTP_STEP_SECS - elapsed;
        const arc = document.getElementById('staff-ring-arc');
        const lbl = document.getElementById('staff-ring-label');
        if (arc) { arc.style.strokeDasharray=`${STAFF_CIRCUMFERENCE} ${STAFF_CIRCUMFERENCE}`; arc.style.strokeDashoffset=STAFF_CIRCUMFERENCE*(1-remaining/CONFIG.TOTP_STEP_SECS); }
        if (lbl) lbl.innerText = remaining;
    }
    tick();
    window._staffPinInterval = setInterval(tick, 1000);
}

function _updateStaffStats() {
    const oc = document.getElementById('staff-override-count');
    const ok = document.getElementById('staff-ok-count');
    const fc = document.getElementById('staff-flag-count');
    if (oc) oc.innerText = staffOverrideCount;
    if (ok) ok.innerText = staffOkCount;
    if (fc) fc.innerText = FLAGGED_TICKETS.length;
}

function _renderStaffLog() {
    const log = document.getElementById('staff-override-log');
    if (!log) return;
    if (!staffOverrideLog.length) {
        log.innerHTML = '<div class="override-log-row" style="color:#475569;text-align:center;">No override events yet.</div>'; return;
    }
    log.innerHTML = staffOverrideLog.slice().reverse().map(e =>
        `<div class="override-log-row"><span style="color:#475569;">${e.time}</span> — <span class="${e.type==='warn'?'log-warn':'log-ok'}">${e.msg}</span></div>`
    ).join('');
}

window.enterStaffView    = enterStaffView;
window.exitStaffView     = exitStaffView;
window._updateStaffStats = _updateStaffStats;
window._renderStaffLog   = _renderStaffLog;


// ════════════════════════════════════════════════════════════════
// SUPABASE REALTIME LISTENER STUBS
// Wire these to your Supabase project to go fully live.
// ════════════════════════════════════════════════════════════════

/**
 * initSupabaseListeners()
 * Sets up realtime subscriptions for:
 *   • Queue counter changes (broadcast to all customer devices)
 *   • Ticket status changes (no-show, mfa-passed)
 *   • Flag updates (staff approval reflects on customer UI)
 *
 * Production setup:
 *   const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
 *
 *   supabase.channel('queue-events')
 *     .on('postgres_changes', {
 *       event: 'UPDATE', schema: 'public', table: 'queue_state',
 *       filter: `tenant_id=eq.${_tenant.id}`
 *     }, payload => {
 *       window.globalCurrentServing = payload.new.current_serving
 *       window.syncUIElements()
 *     })
 *     .subscribe()
 *
 *   supabase.channel('ticket-events')
 *     .on('postgres_changes', {
 *       event: 'UPDATE', schema: 'public', table: 'tickets',
 *       filter: `ticket_number=eq.${myTicketNumber}`
 *     }, payload => {
 *       if (payload.new.status === 'EXPIRED_NO_SHOW') _showNoShowBanner(payload.new.called_at)
 *       if (payload.new.mfa_passed)                  window.mfaGatePassed = true
 *     })
 *     .subscribe()
 */
function initSupabaseListeners() {
    console.log('[Supabase] Realtime listeners: connect your project to go live.');
}
window.initSupabaseListeners = initSupabaseListeners;


// ════════════════════════════════════════════════════════════════
// UTILITIES (shared across modules)
// ════════════════════════════════════════════════════════════════

function isEventLive() {
    return !CONFIG.EVENT_LAUNCH_TIME || Date.now() >= CONFIG.EVENT_LAUNCH_TIME.getTime();
}
function formatDuration(m) {
    if (m < 60) return `~${m} min${m !== 1 ? 's' : ''}`;
    const h = Math.floor(m / 60), r = m % 60;
    return `~${h} hr${h !== 1 ? 's' : ''}${r > 0 ? ` ${r} min${r !== 1 ? 's' : ''}` : ''}`;
}
function formatEstimatedTurnTime(m) {
    const b = isEventLive() ? Date.now() : CONFIG.EVENT_LAUNCH_TIME.getTime();
    return `Est. ready at ${new Date(b + m * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
function pad2(n) { return String(n).padStart(2, '0'); }
function _nowStr() { return new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }); }

function _showToast(message, color = 'green') {
    const existing = document.getElementById('_toast');
    if (existing) existing.remove();
    const colors = {
        green: 'color:#166534;background:#dcfce7;border:1px solid #bbf7d0',
        amber: 'color:#92400e;background:#fffbeb;border:1px solid #fcd34d',
        red:   'color:#991b1b;background:#fee2e2;border:1px solid #fecaca'
    };
    const t = document.createElement('div');
    t.id = '_toast';
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);${colors[color]};padding:10px 18px;border-radius:12px;font-size:12px;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.12);max-width:320px;text-align:center;`;
    t.innerText = message;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity='0'; t.style.transition='opacity .4s'; setTimeout(() => t.remove(), 400); }, 3500);
}

window.isEventLive             = isEventLive;
window.formatDuration          = formatDuration;
window.formatEstimatedTurnTime = formatEstimatedTurnTime;
window.pad2                    = pad2;
window._nowStr                 = _nowStr;
window._showToast              = _showToast;
