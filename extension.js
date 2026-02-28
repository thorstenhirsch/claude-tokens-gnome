/**
 * Claude Token Monitor – GNOME Shell Extension
 * Displays Claude AI session (5-hour) and weekly token usage in the top panel.
 *
 * Authentication: paste the value of the "sessionKey" cookie from claude.ai
 * (open DevTools → Application → Cookies → https://claude.ai).
 *
 * API endpoints used (claude.ai internal REST API):
 *   GET https://claude.ai/api/auth/current_account
 *   GET https://claude.ai/api/organizations/{orgId}/rate_limit_status
 */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Soup from 'gi://Soup';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const CLAUDE_BASE     = 'https://claude.ai/api';
const ACCOUNT_ENDPOINT = `${CLAUDE_BASE}/auth/current_account`;

const BAR_WIDTH   = 110; // px – total bar track width
const BAR_HEIGHT  = 6;   // px

// ─── Progress bar widget ──────────────────────────────────────────────────────

/**
 * A horizontal progress bar that changes colour at 80 % (orange) and 100 % (red).
 * Built from plain St.Bin widgets so it inherits the panel font metrics and
 * respects scaling factor.
 */
const TokenBar = GObject.registerClass(
class TokenBar extends St.BoxLayout {
    _init(label) {
        super._init({
            style_class: 'ct-row',
            vertical: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Label (e.g. "5h" / "7d")
        this._label = new St.Label({
            text: label,
            style_class: 'ct-bar-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        // Track (background)
        this._track = new St.Bin({
            style_class: 'ct-track',
            width: BAR_WIDTH,
            height: BAR_HEIGHT,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._track);

        // Fill
        this._fill = new St.Bin({
            style_class: 'ct-fill ct-fill-normal',
            height: BAR_HEIGHT,
        });
        this._track.set_child(this._fill);

        // Numbers label (e.g. "48k / 200k")
        this._numbers = new St.Label({
            text: '',
            style_class: 'ct-numbers',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._numbers);

        this._pct = 0;
    }

    /**
     * @param {number} used   – tokens used
     * @param {number} limit  – token limit (> 0)
     * @param {boolean} showNumbers
     */
    update(used, limit, showNumbers) {
        if (limit <= 0) return;

        this._pct = Math.min(used / limit, 1.5); // cap visual at 150 %
        const fillPx = Math.round(Math.min(this._pct, 1.0) * BAR_WIDTH);

        this._fill.width = fillPx;

        // Colour class
        this._fill.remove_style_class_name('ct-fill-normal');
        this._fill.remove_style_class_name('ct-fill-warning');
        this._fill.remove_style_class_name('ct-fill-critical');

        if (this._pct >= 1.0) {
            this._fill.add_style_class_name('ct-fill-critical');
        } else if (this._pct >= 0.8) {
            this._fill.add_style_class_name('ct-fill-warning');
        } else {
            this._fill.add_style_class_name('ct-fill-normal');
        }

        if (showNumbers) {
            this._numbers.text = ` ${_fmt(used)} / ${_fmt(limit)}`;
        } else {
            this._numbers.text = '';
        }
    }

    get percent() { return this._pct; }
});

// ─── Panel indicator ──────────────────────────────────────────────────────────

const ClaudeTokenIndicator = GObject.registerClass(
class ClaudeTokenIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Claude Token Monitor'));

        this._ext     = extension;
        this._settings = extension.getSettings();
        this._session  = new Soup.Session();
        this._orgId    = null;

        // ── Panel widget ────────────────────────────────────────────────────
        const outerBox = new St.BoxLayout({
            style_class: 'ct-panel-box',
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(outerBox);

        // Icon
        this._icon = new St.Icon({
            icon_name: 'emblem-synchronizing-symbolic',
            style_class: 'ct-icon system-status-icon',
        });
        outerBox.add_child(this._icon);

        // Bars
        const barsBox = new St.BoxLayout({
            style_class: 'ct-bars-box',
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        outerBox.add_child(barsBox);

        this._sessionBar = new TokenBar(_('5h '));
        this._weeklyBar  = new TokenBar(_(' 7d '));
        barsBox.add_child(this._sessionBar);
        barsBox.add_child(this._weeklyBar);

        // ── Dropdown menu ───────────────────────────────────────────────────
        this._buildMenu();

        // ── State ───────────────────────────────────────────────────────────
        this._lastSessionUsed = this._settings.get_int('last-session-used');
        this._lastWeeklyUsed  = this._settings.get_int('last-weekly-used');
        this._timerId = null;
        this._currentInterval = this._settings.get_int('poll-interval-idle');
        this._sessionResetTime = null;
        this._weeklyResetTime = null;

        // Enable reactive for hover events
        this.reactive = true;

        // Watch for credential changes
        this._settingsChangedId = this._settings.connect('changed::session-cookie', () => {
            this._orgId = null;
            this._scheduleNextPoll(0);
        });

        // Initial fetch
        this._scheduleNextPoll(1);
    }

    // ── Menu ──────────────────────────────────────────────────────────────────

    _buildMenu() {
        // Status header
        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._statusItem.label.style_class = 'ct-menu-status';
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Session detail
        this._sessionDetail = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._sessionDetail);

        // Weekly detail
        this._weeklyDetail = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._weeklyDetail);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Reset times
        this._sessionResetItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._weeklyResetItem  = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._updatedItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._sessionResetItem);
        this.menu.addMenuItem(this._weeklyResetItem);
        this.menu.addMenuItem(this._updatedItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Refresh now
        const refreshItem = new PopupMenu.PopupMenuItem(_('Refresh now'));
        refreshItem.connect('activate', () => {
            this._scheduleNextPoll(0);
        });
        this.menu.addMenuItem(refreshItem);

        // Open preferences
        const prefsItem = new PopupMenu.PopupMenuItem(_('Settings…'));
        prefsItem.connect('activate', () => {
            this._ext.openPreferences();
        });
        this.menu.addMenuItem(prefsItem);
    }

    // ── Polling ───────────────────────────────────────────────────────────────

    _scheduleNextPoll(delaySec) {
        this._cancelTimer();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delaySec, () => {
            this._timerId = null;
            this._fetchData();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    // ── HTTP helpers ──────────────────────────────────────────────────────────

    _cookieHeader() {
        const key = (this._settings.get_string('session-cookie') || '').trim();
        if (!key) return null;
        // Accept either the raw value or a full "sessionKey=…" string
        return key.startsWith('sessionKey=') ? key : `sessionKey=${key}`;
    }

    _get(url, callback) {
        const cookie = this._cookieHeader();
        if (!cookie) {
            callback(null, 'No session cookie configured. Open Settings to add one.');
            return;
        }

        const msg = Soup.Message.new('GET', url);
        msg.request_headers.append('Cookie', cookie);
        msg.request_headers.append('User-Agent',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        msg.request_headers.append('Accept', 'application/json');
        msg.request_headers.append('Referer', 'https://claude.ai/');

        this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, null,
            (sess, result) => {
                try {
                    const bytes = sess.send_and_read_finish(result);
                    const status = msg.get_status();
                    const body   = new TextDecoder().decode(bytes.get_data());

                    if (status === 401 || status === 403) {
                        callback(null, _('Authentication failed – check your session cookie.'));
                        return;
                    }
                    if (status < 200 || status >= 300) {
                        callback(null, `HTTP ${status}`);
                        return;
                    }

                    let json;
                    try { json = JSON.parse(body); }
                    catch (_) { callback(null, `Invalid JSON from server`); return; }
                    callback(json, null);
                } catch (e) {
                    callback(null, `Network error: ${e.message}`);
                }
            }
        );
    }

    // ── Data fetching ─────────────────────────────────────────────────────────

    _fetchData() {
        if (!this._orgId) {
            this._fetchAccount();
        } else {
            this._fetchUsage();
        }
    }

    _fetchAccount() {
        this._setStatus(_('Connecting…'));
        this._get(ACCOUNT_ENDPOINT, (data, err) => {
            if (err) { this._setStatus(err); this._scheduleNextPoll(60); return; }

            // Response shape: { account: { memberships: [{organization: {uuid}}] } }
            // or  { memberships: [...] }  depending on API version
            try {
                const memberships =
                    data?.memberships ??
                    data?.account?.memberships ??
                    [];
                const org = memberships?.[0]?.organization ?? memberships?.[0]?.workspace;
                this._orgId = org?.uuid ?? org?.id ?? data?.id ?? null;

                if (!this._orgId) {
                    // Try alternate key locations
                    this._orgId =
                        data?.organization_uuid ??
                        data?.default_organization?.uuid ??
                        null;
                }

                if (!this._orgId) {
                    this._setStatus(_('Could not resolve organization ID.'));
                    this._scheduleNextPoll(60);
                    return;
                }
                this._fetchUsage();
            } catch (e) {
                this._setStatus(`Parse error: ${e.message}`);
                this._scheduleNextPoll(60);
            }
        });
    }

    _fetchUsage() {
        const url = `${CLAUDE_BASE}/organizations/${this._orgId}/rate_limit_status`;
        this._get(url, (data, err) => {
            if (err) {
                this._setStatus(err);
                this._scheduleNextPoll(60);
                return;
            }

            try {
                this._applyUsageData(data);
            } catch (e) {
                this._setStatus(`Parse error: ${e.message}`);
                this._scheduleNextPoll(60);
            }
        });
    }

    /**
     * Parses the rate limit payload.  Claude.ai may return different shapes;
     * we try several known patterns and fall back gracefully.
     *
     * Known shapes (may change over time):
     * {
     *   "rate_limit_status": {
     *     "message_limit": { "type": "window5Hour"|"weekly", "remaining": N, "total": N }
     *   }
     * }
     * or flat array / object with window_type keys.
     */
    _applyUsageData(data) {
        const showNumbers = this._settings.get_boolean('show-numbers');

        let sessionUsed = 0, sessionLimit = 1;
        let weeklyUsed  = 0, weeklyLimit  = 1;
        let sessionReset = null, weeklyReset = null;

        // ── Try to extract values from various schemas ─────────────────────

        // Schema A: { rate_limit_status: { message_limit: {...} } }
        const rl = data?.rate_limit_status;
        if (rl) {
            const entries = Array.isArray(rl) ? rl : Object.values(rl);
            for (const entry of entries) {
                const type = entry?.type ?? '';
                const rem  = _safeInt(entry?.remaining ?? entry?.tokens_remaining);
                const tot  = _safeInt(entry?.total     ?? entry?.tokens_total ?? entry?.limit);
                const used = tot - rem;
                const reset = entry?.resetsAt ?? entry?.reset_at ?? entry?.resets_at ?? null;

                if (/5.hour|5hour|window/i.test(type)) {
                    sessionUsed  = used;  sessionLimit = tot; sessionReset = reset;
                } else if (/week/i.test(type)) {
                    weeklyUsed   = used;  weeklyLimit  = tot; weeklyReset  = reset;
                }
            }
        }

        // Schema B: direct arrays of quota objects
        const quotas = data?.quotas ?? data?.limits ?? data?.usage_limits ?? [];
        for (const q of (Array.isArray(quotas) ? quotas : [])) {
            const type = q?.window ?? q?.type ?? q?.period ?? '';
            const used = _safeInt(q?.used ?? q?.tokens_used);
            const limit = _safeInt(q?.limit ?? q?.tokens_limit ?? q?.total);
            const reset = q?.reset_at ?? q?.resetsAt ?? null;
            if (/5.hour|5hour|session|window/i.test(type)) {
                sessionUsed = used; sessionLimit = limit; sessionReset = reset;
            } else if (/week/i.test(type)) {
                weeklyUsed = used; weeklyLimit = limit; weeklyReset = reset;
            }
        }

        // Schema C: flat keys  token_5hour_used / token_5hour_limit etc.
        if (sessionLimit <= 1) {
            for (const [k, v] of Object.entries(data ?? {})) {
                if (/5.?hour/i.test(k)) {
                    if (/used/i.test(k))  sessionUsed  = _safeInt(v);
                    if (/limit|total/i.test(k)) sessionLimit = _safeInt(v);
                }
                if (/week/i.test(k)) {
                    if (/used/i.test(k))  weeklyUsed   = _safeInt(v);
                    if (/limit|total/i.test(k)) weeklyLimit  = _safeInt(v);
                }
            }
        }

        // ── Adaptive polling ───────────────────────────────────────────────
        const last = {
            s: this._lastSessionUsed,
            w: this._lastWeeklyUsed,
        };
        const tokensMoved =
            sessionUsed > last.s || weeklyUsed > last.w;

        const idleInterval   = this._settings.get_int('poll-interval-idle');
        const activeInterval = this._settings.get_int('poll-interval-active');
        const nextInterval   = tokensMoved ? activeInterval : idleInterval;

        this._lastSessionUsed = sessionUsed;
        this._lastWeeklyUsed  = weeklyUsed;
        this._settings.set_int('last-session-used', sessionUsed);
        this._settings.set_int('last-weekly-used',  weeklyUsed);

        // ── Update UI ──────────────────────────────────────────────────────
        this._sessionBar.update(sessionUsed, sessionLimit, showNumbers);
        this._weeklyBar.update(weeklyUsed,   weeklyLimit,  showNumbers);

        // Update icon to reflect worst state
        const maxPct = Math.max(
            sessionLimit > 0 ? sessionUsed / sessionLimit : 0,
            weeklyLimit  > 0 ? weeklyUsed  / weeklyLimit  : 0
        );
        if (maxPct >= 1.0) {
            this._icon.icon_name = 'dialog-error-symbolic';
            this._icon.remove_style_class_name('ct-icon-warning');
            this._icon.add_style_class_name('ct-icon-critical');
        } else if (maxPct >= 0.8) {
            this._icon.icon_name = 'dialog-warning-symbolic';
            this._icon.remove_style_class_name('ct-icon-critical');
            this._icon.add_style_class_name('ct-icon-warning');
        } else {
            this._icon.icon_name = 'utilities-system-monitor-symbolic';
            this._icon.remove_style_class_name('ct-icon-warning');
            this._icon.remove_style_class_name('ct-icon-critical');
        }

        // Menu details
        const sPct = sessionLimit > 0 ? Math.round(sessionUsed / sessionLimit * 100) : 0;
        const wPct = weeklyLimit  > 0 ? Math.round(weeklyUsed  / weeklyLimit  * 100) : 0;

        this._statusItem.label.text = _('Claude token usage');
        this._sessionDetail.label.text =
            `5-hour window: ${_fmt(sessionUsed)} / ${_fmt(sessionLimit)} tokens (${sPct}%)`;
        this._weeklyDetail.label.text =
            `Weekly quota:  ${_fmt(weeklyUsed)} / ${_fmt(weeklyLimit)} tokens (${wPct}%)`;
        
        // Store reset times for tooltip
        this._sessionResetTime = sessionReset;
        this._weeklyResetTime = weeklyReset;
        
        // Update reset time displays in menu
        this._sessionResetItem.label.text =
            sessionReset
                ? `5h resets:  ${_fmtDate(sessionReset)}`
                : '5h resets:  Unknown';
        this._weeklyResetItem.label.text =
            weeklyReset
                ? `7d resets:  ${_fmtDate(weeklyReset)}`
                : '7d resets:  Unknown';
        this._updatedItem.label.text =
            `Last updated: ${_fmtDate(new Date().toISOString())}`;
        
        // Update tooltip
        this._updateTooltip();

        this._scheduleNextPoll(nextInterval);
    }

    _setStatus(msg) {
        this._statusItem.label.text = msg;
        this._sessionDetail.label.text = '';
        this._weeklyDetail.label.text  = '';
    }

    // ── Tooltip ───────────────────────────────────────────────────────────────

    _updateTooltip() {
        const lines = [];
        
        if (this._sessionResetTime) {
            lines.push(`5h window resets: ${_fmtDate(this._sessionResetTime)}`);
        } else {
            lines.push('5h window resets: Unknown');
        }
        
        if (this._weeklyResetTime) {
            lines.push(`Weekly quota resets: ${_fmtDate(this._weeklyResetTime)}`);
        } else {
            lines.push('Weekly quota resets: Unknown');
        }
        
        const tooltipText = lines.join('\n');
        
        // Create or update tooltip
        if (!this._tooltip) {
            this._tooltip = new St.Label({
                style_class: 'ct-tooltip',
                text: tooltipText,
                visible: false,
            });
            Main.layoutManager.addChrome(this._tooltip);
        } else {
            this._tooltip.text = tooltipText;
        }
    }
    
    vfunc_event(event) {
        const eventType = event.type();
        
        if (eventType === Clutter.EventType.ENTER) {
            this._showTooltip();
        } else if (eventType === Clutter.EventType.LEAVE) {
            this._hideTooltip();
        }
        
        return super.vfunc_event(event);
    }
    
    _showTooltip() {
        if (!this._tooltip) return;
        
        // Position tooltip near the panel indicator
        const [x, y] = this.get_transformed_position();
        const [width, height] = this.get_transformed_size();
        
        this._tooltip.set_position(
            Math.floor(x),
            Math.floor(y + height + 5)
        );
        this._tooltip.show();
    }
    
    _hideTooltip() {
        if (this._tooltip) {
            this._tooltip.hide();
        }
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────

    destroy() {
        this._hideTooltip();
        if (this._tooltip) {
            Main.layoutManager.removeChrome(this._tooltip);
            this._tooltip.destroy();
            this._tooltip = null;
        }
        this._cancelTimer();
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        super.destroy();
    }
});

// ─── Utility helpers ──────────────────────────────────────────────────────────

function _safeInt(v) {
    const n = parseInt(v, 10);
    return isFinite(n) ? n : 0;
}

/** Format large numbers:  1234567 → "1.2M",  48000 → "48k" */
function _fmt(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)     return Math.round(n / 1_000) + 'k';
    return String(n);
}

/** Render an ISO-8601 string as a human-readable local time */
function _fmtDate(iso) {
    try {
        const d = new Date(iso);
        return d.toLocaleString(undefined, {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
    } catch (_) {
        return iso;
    }
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default class ClaudeTokensExtension extends Extension {
    enable() {
        this._indicator = new ClaudeTokenIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
