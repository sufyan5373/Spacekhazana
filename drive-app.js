/* ─── SpaceKhazana — Google-restricted session watchdog ───────────────────
 * Include this near the end of <body> on any page where the user is
 * already logged in (drive UI, e.g. index.html):
 *
 *   <script src="/drive-app.js"></script>
 *
 * Reads the existing 'spacekhazana_token' from localStorage — no changes
 * needed to your existing login code. On load, and then every 60 seconds,
 * it hits /api/session/status; if the account is flagged restricted
 * (linked to a different Gmail than the one active in this browser), it
 * shows a non-dismissable red overlay and locks out the interaction it
 * covers. Upload/delete/share calls are ALSO blocked server-side by
 * enforceFeatureAccess regardless of whether this script runs — this is
 * a UX layer, not the enforcement point.
 * ──────────────────────────────────────────────────────────────────────── */
(function () {
    const LS_TOKEN = 'spacekhazana_token';
    const API_HOST = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        ? 'http://localhost:3006'
        : window.location.protocol + '//' + window.location.hostname;

    const RECHECK_INTERVAL_MS = 60 * 1000;
    let modalEl = null;
    let intervalHandle = null;

    function getToken() {
        return localStorage.getItem(LS_TOKEN);
    }

    async function fetchSessionStatus() {
        const token = getToken();
        if (!token) return null;
        try {
            const res = await fetch(`${API_HOST}/api/session/status`, {
                headers: { 'x-auth-token': token }
            });
            if (!res.ok) return null;
            return await res.json();
        } catch (err) {
            console.warn('[drive-app] session status check failed:', err);
            return null;
        }
    }

    function buildModal(status) {
        const overlay = document.createElement('div');
        overlay.id = 'skGoogleRestrictedOverlay';
        overlay.setAttribute('role', 'alertdialog');
        overlay.setAttribute('aria-live', 'assertive');
        overlay.style.cssText = `
            position: fixed;
            inset: 0;
            z-index: 2147483647;
            background: rgba(120, 10, 10, 0.55);
            backdrop-filter: blur(3px);
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            animation: skFadeIn 0.15s ease;
        `;

        const box = document.createElement('div');
        box.style.cssText = `
            width: 100%;
            max-width: 440px;
            background: #2a0d0d;
            border: 1px solid #c62828;
            border-radius: 14px;
            padding: 28px 26px;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            box-shadow: 0 20px 60px rgba(0,0,0,0.5);
            text-align: center;
        `;

        const activeEmail = status && status.activeGoogleEmail ? status.activeGoogleEmail : 'a different Gmail account';
        const accountEmail = status && status.driveAccountGoogleEmail ? status.driveAccountGoogleEmail : 'this account\u2019s linked Gmail';

        box.innerHTML = `
            <div style="width:52px;height:52px;margin:0 auto 14px;border-radius:50%;background:rgba(255,255,255,0.12);
                        display:flex;align-items:center;justify-content:center;font-size:26px;">&#9888;&#65039;</div>
            <h2 style="margin:0 0 8px;font-size:18px;font-weight:700;">Unauthorized Secondary Gmail Session</h2>
            <p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:#ffd6d6;">
                You're browsing as <strong>${escapeHtml(activeEmail)}</strong>, but this SpaceKhazana
                account is linked to <strong>${escapeHtml(accountEmail)}</strong>.
                Uploading, deleting, and sharing are locked until you sign into
                the matching Google account.
            </p>
            <button id="skGoogleRestrictedAck" style="
                width:100%; padding:12px 18px; background:#c62828; color:#fff;
                border:none; border-radius:8px; font-size:14px; font-weight:600;
                cursor:pointer;">I understand</button>
        `;

        overlay.appendChild(box);

        // Non-dismissable via backdrop click or Escape — only the
        // acknowledge button hides it, and it will reappear on the next
        // 60-second recheck anyway as long as the session stays restricted.
        overlay.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('keydown', blockEscapeWhileOpen, true);

        box.querySelector('#skGoogleRestrictedAck').addEventListener('click', hideModal);

        return overlay;
    }

    function blockEscapeWhileOpen(e) {
        if (e.key === 'Escape' && modalEl) e.stopPropagation();
    }

    function escapeHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    function showModal(status) {
        if (modalEl) return; // already visible, don't stack duplicates
        modalEl = buildModal(status);
        document.body.appendChild(modalEl);
        if (!document.getElementById('skGoogleRestrictedStyles')) {
            const style = document.createElement('style');
            style.id = 'skGoogleRestrictedStyles';
            style.textContent = `@keyframes skFadeIn { from { opacity: 0 } to { opacity: 1 } }`;
            document.head.appendChild(style);
        }
    }

    function hideModal() {
        if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
        modalEl = null;
    }

    async function checkAndReact() {
        const status = await fetchSessionStatus();
        if (!status) return; // logged out / network error — nothing to show
        if (status.isRestricted) {
            showModal(status);
        }
        // Intentionally NOT auto-hiding here if isRestricted flips back to
        // false while the modal is open — the user already acknowledged
        // it this cycle; the next 60s recheck will simply not re-show it.
    }

    function start() {
        if (!getToken()) return; // not logged in on this page
        checkAndReact();
        intervalHandle = setInterval(checkAndReact, RECHECK_INTERVAL_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

    // Exposed for debugging / manual re-trigger from devtools.
    window.__skGoogleSessionWatchdog = { checkAndReact, hideModal };
})();
