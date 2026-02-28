/**
 * Claude Token Monitor – Preferences
 *
 * Provides a clean Adw-based settings page where users can paste their
 * claude.ai session cookie and tweak polling intervals.
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudeTokensPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(640, 520);
        window.set_search_enabled(false);

        // ── Page ─────────────────────────────────────────────────────────────
        const page = new Adw.PreferencesPage({
            title: _('Claude Token Monitor'),
            icon_name: 'utilities-system-monitor-symbolic',
        });
        window.add(page);

        // ── Authentication group ─────────────────────────────────────────────
        const authGroup = new Adw.PreferencesGroup({
            title: _('Authentication'),
            description: _(
                'How to get your session cookie:\n' +
                '1. Open claude.ai in your browser and log in.\n' +
                '2. Open DevTools (F12) → Application → Storage → Cookies → https://claude.ai\n' +
                '3. Copy the value of the cookie named "sessionKey".\n' +
                '4. Paste it below — it starts with sk-ant-sid01-…'
            ),
        });
        page.add(authGroup);

        // Session cookie row
        const cookieRow = new Adw.PasswordEntryRow({
            title: _('Session cookie (sessionKey)'),
        });
        settings.bind('session-cookie', cookieRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        authGroup.add(cookieRow);

        // Status / test button
        const testRow = new Adw.ActionRow({
            title: _('Test connection'),
            subtitle: _('Verifies that the cookie is accepted by claude.ai.'),
        });
        const testBtn = new Gtk.Button({
            label: _('Test'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        this._testStatusLabel = new Gtk.Label({
            label: '',
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });
        testRow.add_suffix(this._testStatusLabel);
        testRow.add_suffix(testBtn);
        authGroup.add(testRow);

        testBtn.connect('clicked', () => {
            this._testConnection(settings, testBtn);
        });

        // ── Polling group ────────────────────────────────────────────────────
        const pollGroup = new Adw.PreferencesGroup({
            title: _('Polling'),
        });
        page.add(pollGroup);

        const idleRow = new Adw.SpinRow({
            title: _('Idle interval (seconds)'),
            subtitle: _('How often to refresh when token usage is not changing.'),
            adjustment: new Gtk.Adjustment({
                lower: 10, upper: 300, step_increment: 5,
            }),
        });
        settings.bind('poll-interval-idle', idleRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        pollGroup.add(idleRow);

        const activeRow = new Adw.SpinRow({
            title: _('Active interval (seconds)'),
            subtitle: _('How often to refresh when tokens are being consumed.'),
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 60, step_increment: 1,
            }),
        });
        settings.bind('poll-interval-active', activeRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        pollGroup.add(activeRow);

        // ── Display group ────────────────────────────────────────────────────
        const displayGroup = new Adw.PreferencesGroup({
            title: _('Display'),
        });
        page.add(displayGroup);

        const numbersRow = new Adw.SwitchRow({
            title: _('Show token counts'),
            subtitle: _('Display "used / total" numbers next to the progress bars.'),
        });
        settings.bind('show-numbers', numbersRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(numbersRow);

        // ── Info group ───────────────────────────────────────────────────────
        const infoGroup = new Adw.PreferencesGroup({
            title: _('About'),
        });
        page.add(infoGroup);

        const versionRow = new Adw.ActionRow({
            title: _('Version'),
            subtitle: String(this.metadata.version ?? 1),
        });
        infoGroup.add(versionRow);

        const urlRow = new Adw.ActionRow({
            title: _('Source code'),
            subtitle: this.metadata.url ?? '',
            activatable: true,
        });
        urlRow.add_suffix(new Gtk.Image({
            icon_name: 'external-link-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        if (this.metadata.url) {
            urlRow.connect('activated', () => {
                Gtk.show_uri(null, this.metadata.url, GLib.get_current_time());
            });
        }
        infoGroup.add(urlRow);
    }

    // ── Test connection ───────────────────────────────────────────────────────

    _testConnection(settings, btn) {
        const key = (settings.get_string('session-cookie') ?? '').trim();
        if (!key) {
            this._setTestStatus('⚠ No cookie entered.', false);
            return;
        }

        btn.sensitive = false;
        this._setTestStatus(_('Testing…'), null);

        const session = new Soup.Session();
        const cookie  = key.startsWith('sessionKey=') ? key : `sessionKey=${key}`;
        const msg = Soup.Message.new('GET', 'https://claude.ai/api/auth/current_account');
        msg.request_headers.append('Cookie', cookie);
        msg.request_headers.append('User-Agent',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
        msg.request_headers.append('Accept', 'application/json');

        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
            (_sess, result) => {
                btn.sensitive = true;
                try {
                    _sess.send_and_read_finish(result);
                    const status = msg.get_status();
                    if (status === 200) {
                        this._setTestStatus(_('✓ Connection successful!'), true);
                    } else if (status === 401 || status === 403) {
                        this._setTestStatus(_('✗ Authentication failed – wrong cookie?'), false);
                    } else {
                        this._setTestStatus(`✗ HTTP ${status}`, false);
                    }
                } catch (e) {
                    this._setTestStatus(`✗ ${e.message}`, false);
                }
            });
    }

    _setTestStatus(text, ok) {
        if (!this._testStatusLabel) return;
        this._testStatusLabel.label = text;
        this._testStatusLabel.remove_css_class('success');
        this._testStatusLabel.remove_css_class('error');
        if (ok === true)  this._testStatusLabel.add_css_class('success');
        if (ok === false) this._testStatusLabel.add_css_class('error');
    }
}


