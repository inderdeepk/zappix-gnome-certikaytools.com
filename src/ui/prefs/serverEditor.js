// prefs/serverEditor.js — the add/edit server dialog.
//
// The dialog is where a wrong API token becomes a five-second fix instead of a
// support ticket, so it contains three things the preferences list does not:
//
//   • inline URL validation with the endpoint it will actually call;
//   • a live "Test connection" that probes the server and reports the Zabbix
//     version, host count, or the exact failure;
//   • a token field that is never pre-filled with the stored secret — an empty
//     field means "keep the existing token", which is how a user edits a label
//     without handling the credential again.
//
// Preferences-process module (Adw/Gtk).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';

import { normaliseBaseUrl } from '../../api/zabbixEndpoints.js';
import { ZabbixClient } from '../../api/zabbixClient.js';
import { AUTH_MODE, makeServerId, sanitiseServer } from '../../shared/serverStore.js';
import { SEVERITY } from '../../model/severity.js';
import { format, gettext as _ } from '../../shared/i18n.js';

export const ServerEditor = GObject.registerClass(
    {
        GTypeName: 'ZappixServerEditor',
    },
    class ServerEditor extends Adw.Window {
        /**
         * @param {object} options
         * @param {object|null} options.server existing definition, or null to add
         * @param {boolean} options.hasStoredSecret whether a token already exists
         * @param {boolean} [options.hasStoredAccessSecret] Access secret present
         * @param {string[]} options.existingIds
         * @param {(result: {server: object, secret: string, accessSecret: string}) => void} options.onSave
         * @param {Gtk.Window} [options.parent]
         */
        constructor({
            server,
            hasStoredSecret,
            hasStoredAccessSecret = false,
            existingIds,
            onSave,
            parent,
        }) {
            super({
                title: server ? _('Edit server') : _('Add server'),
                modal: true,
                transient_for: parent ?? null,
                default_width: 540,
                default_height: 620,
            });

            this._original = server ?? null;
            this._hasStoredSecret = Boolean(hasStoredSecret);
            this._hasStoredAccessSecret = Boolean(hasStoredAccessSecret);
            this._existingIds = existingIds ?? [];
            this._onSave = onSave;
            this._testClient = null;
            this._saving = false;

            this._build(server);
        }

        // ── construction ────────────────────────────────────────────────────

        /**
         * @param {object|null} server
         */
        _build(server) {
            const toolbar = new Adw.ToolbarView();
            this.set_content(toolbar);

            const header = new Adw.HeaderBar();
            toolbar.add_top_bar(header);

            const cancelButton = new Gtk.Button({ label: _('Cancel') });
            cancelButton.connect('clicked', () => this.close());
            header.pack_start(cancelButton);

            this._saveButton = new Gtk.Button({
                label: _('Save'),
                css_classes: ['suggested-action'],
            });
            this._saveButton.connect('clicked', () => this._save());
            header.pack_end(this._saveButton);

            const page = new Adw.PreferencesPage();
            toolbar.set_content(page);

            // Validation lives at the top, above the fold. It used to be a
            // subtitle on the bottom-most group, which sits off-screen in a
            // 620 px dialog — pressing Save then appeared to do nothing at all.
            this._alertGroup = new Adw.PreferencesGroup({ visible: false });
            this._alertRow = new Adw.ActionRow({ visible: false });
            this._alertRow.add_prefix(
                new Gtk.Image({
                    icon_name: 'dialog-warning-symbolic',
                    valign: Gtk.Align.CENTER,
                }),
            );
            this._alertGroup.add(this._alertRow);
            page.add(this._alertGroup);

            this._buildConnectionGroup(page, server);
            this._buildAuthGroup(page, server);
            this._buildAccessGroup(page, server);
            this._buildAdvancedGroup(page, server);

            this._statusRow = new Adw.ActionRow({
                title: _('Last test'),
                subtitle: _('Optional — saving does not require a successful test.'),
            });
            const statusGroup = new Adw.PreferencesGroup({ title: _('Connection test') });
            statusGroup.add(this._statusRow);

            this._testButton = new Gtk.Button({
                label: _('Test connection'),
                valign: Gtk.Align.CENTER,
            });
            this._testButton.connect('clicked', () => this._testConnection());
            this._statusRow.add_suffix(this._testButton);

            page.add(statusGroup);

            for (const row of [
                this._urlRow,
                this._secretRow,
                this._accessIdRow,
                this._accessSecretRow,
            ]) {
                row.connect('notify::text', () => this._refreshSaveState());
            }
            this._refreshSaveState();
        }

        /**
         * @param {Adw.PreferencesPage} page
         * @param {object|null} server
         */
        _buildConnectionGroup(page, server) {
            const group = new Adw.PreferencesGroup({
                title: _('Connection'),
                description: _(
                    'The URL of your Zabbix frontend. The API endpoint is derived automatically.',
                ),
            });
            page.add(group);

            this._labelRow = new Adw.EntryRow({
                title: _('Label'),
                text: server?.label ?? '',
            });
            this._labelRow.set_tooltip_text(_('Shown in the dropdown. Defaults to the hostname.'));
            group.add(this._labelRow);

            this._urlRow = new Adw.EntryRow({
                title: _('Zabbix URL'),
                text: server?.baseUrl ?? '',
            });
            this._urlRow.set_tooltip_text(
                _('For example https://monitor.example.com or https://example.com/zabbix'),
            );
            this._urlRow.connect('changed', () => this._refreshEndpointPreview());
            group.add(this._urlRow);

            this._endpointRow = new Adw.ActionRow({
                title: _('API endpoint'),
                subtitle: _('Enter a URL to see the endpoint.'),
            });
            group.add(this._endpointRow);
        }

        /**
         * @param {Adw.PreferencesPage} page
         * @param {object|null} server
         */
        _buildAuthGroup(page, server) {
            const group = new Adw.PreferencesGroup({
                title: _('Authentication'),
                description: _(
                    'An API token is recommended: it does not store your password and can be revoked independently.',
                ),
            });
            page.add(group);

            this._authRow = new Adw.ComboRow({
                title: _('Method'),
                model: Gtk.StringList.new([_('API token'), _('Username and password')]),
                selected: server?.authMode === AUTH_MODE.USER ? 1 : 0,
            });
            this._authRow.connect('notify::selected', () => this._syncAuthFields());
            group.add(this._authRow);

            this._usernameRow = new Adw.EntryRow({
                title: _('Username'),
                text: server?.username ?? '',
            });
            group.add(this._usernameRow);

            this._secretRow = new Adw.PasswordEntryRow({
                title: _('API token'),
            });
            if (this._hasStoredSecret) {
                this._secretRow.title = _('API token (leave empty to keep)');
                this._secretRow.set_tooltip_text(
                    _('A token is already stored in the keyring. Leave this empty to keep it.'),
                );
            }
            group.add(this._secretRow);

            this._syncAuthFields();
        }

        /**
         * Cloudflare Access service token.
         *
         * Only relevant when the Zabbix hostname is published through Access —
         * the DeliverEdge pattern, where `monitoring.<domain>` is protected by
         * an email allow-list. Left blank for a directly reachable server.
         *
         * @param {Adw.PreferencesPage} page
         * @param {object|null} server
         */
        _buildAccessGroup(page, server) {
            const group = new Adw.PreferencesGroup({
                title: _('Cloudflare Access'),
                description: _(
                    'Only needed when the Zabbix hostname sits behind Cloudflare Access. Create a service token under Zero Trust → Access → Service auth.',
                ),
            });
            page.add(group);

            this._accessIdRow = new Adw.EntryRow({
                title: _('Service token client id'),
                text: server?.accessClientId ?? '',
            });
            this._accessIdRow.set_tooltip_text(_('Ends with .access'));
            group.add(this._accessIdRow);

            this._accessSecretRow = new Adw.PasswordEntryRow({
                title: _('Service token client secret'),
            });
            if (this._hasStoredAccessSecret) {
                this._accessSecretRow.title = _('Client secret (leave empty to keep)');
                this._accessSecretRow.set_tooltip_text(
                    _('A client secret is already stored in the keyring.'),
                );
            }
            group.add(this._accessSecretRow);
        }

        /**
         * @param {Adw.PreferencesPage} page
         * @param {object|null} server
         */
        _buildAdvancedGroup(page, server) {
            const group = new Adw.PreferencesGroup({ title: _('Advanced') });
            page.add(group);

            this._filterRow = new Adw.EntryRow({
                title: _('Host name filter'),
                text: server?.hostFilter ?? '',
            });
            this._filterRow.set_tooltip_text(
                _('Optional. Only hosts whose name contains this text are shown.'),
            );
            group.add(this._filterRow);

            this._untrustedRow = new Adw.SwitchRow({
                title: _('Allow untrusted TLS certificate'),
                subtitle: _('Use only for a self-signed certificate you control.'),
                active: Boolean(server?.allowUntrustedTls),
            });
            group.add(this._untrustedRow);

            this._enabledRow = new Adw.SwitchRow({
                title: _('Enabled'),
                subtitle: _('Disabled servers are not polled and do not appear in the dropdown.'),
                active: server?.enabled ?? true,
            });
            group.add(this._enabledRow);
        }

        // ── behaviour ───────────────────────────────────────────────────────

        /**
         * Show or hide the username field for the selected auth mode.
         */
        _syncAuthFields() {
            const isUserMode = this._authRow.selected === 1;
            this._usernameRow.visible = isUserMode;
            this._secretRow.title = isUserMode ? _('Password') : _('API token');
        }

        /**
         * Update the endpoint preview as the URL is typed.
         */
        _refreshEndpointPreview() {
            try {
                const { apiUrl, frontendUrl } = normaliseBaseUrl(this._urlRow.text);
                this._endpointRow.subtitle = apiUrl;
                this._endpointRow.title = frontendUrl;
                this._urlRow.remove_css_class('error');
            } catch (error) {
                this._endpointRow.title = _('Invalid URL');
                this._endpointRow.subtitle = error.message ?? String(error);
                this._urlRow.add_css_class('error');
            }
        }

        /**
         * Probe the server with the values currently in the form.
         */
        async _testConnection() {
            const draft = this._buildDraft();
            if (!draft) return;

            // Tokens are pasted from a terminal or a web UI as often as they
            // are typed; a trailing newline would travel in the Authorization
            // header and be answered with a bare 401.
            const secret =
                this._secretRow.text.trim() || (this._hasStoredSecret ? '__stored__' : '');
            const accessSecret = this._accessSecretRow.text.trim();
            if (!secret) {
                this._setStatus(_('Enter a token or password first.'), SEVERITY.WARN);
                return;
            }

            if (secret === '__stored__') {
                this._setStatus(
                    _('Save first, then test — the stored token is not readable here.'),
                    SEVERITY.WARN,
                );
                return;
            }

            this._testButton.sensitive = false;
            this._setStatus(_('Testing…'), '');

            let client = null;
            try {
                client = new ZabbixClient({
                    server: draft,
                    secret,
                    accessSecret,
                    timeoutSeconds: 10,
                });
                this._testClient = client;
                const result = await client.testConnection();

                if (result.ok) {
                    this._setStatus(
                        format(_('Connected to Zabbix {version} — {count} host(s) visible.'), {
                            version: result.version || '?',
                            count: result.hosts,
                        }),
                        SEVERITY.OK,
                    );
                } else {
                    this._setStatus(result.error || _('Connection failed.'), SEVERITY.CRIT);
                }
            } catch (error) {
                this._setStatus(error?.message ?? String(error), SEVERITY.CRIT);
            } finally {
                client?.destroy();
                this._testClient = null;
                this._testButton.sensitive = true;
            }
        }

        /**
         * @param {string} text
         * @param {string} severity
         */
        _setStatus(text, severity) {
            this._statusRow.subtitle = text;
            for (const name of ['ok', 'warn', 'crit', 'unknown']) {
                this._statusRow.remove_css_class(`zappix-status-${name}`);
            }
            if (severity) this._statusRow.add_css_class(`zappix-status-${severity}`);
        }

        /**
         * Build a validated server definition from the form.
         *
         * @returns {object|null} null when the form is invalid
         */
        _buildDraft() {
            const label = this._labelRow.text.trim();
            const baseUrl = this._urlRow.text.trim();

            try {
                normaliseBaseUrl(baseUrl);
            } catch (error) {
                this._setAlert(error.message ?? String(error), SEVERITY.CRIT);
                return null;
            }

            const id = this._original?.id ?? makeServerId({ existing: this._existingIds });

            const colourIndex = Math.max(0, this._existingIds.indexOf(id));

            return sanitiseServer(
                {
                    id,
                    label,
                    baseUrl,
                    authMode: this._authRow.selected === 1 ? AUTH_MODE.USER : AUTH_MODE.TOKEN,
                    username: this._usernameRow.text,
                    hostFilter: this._filterRow.text,
                    allowUntrustedTls: this._untrustedRow.active,
                    accessClientId: this._accessIdRow.text,
                    enabled: this._enabledRow.active,
                    // Preserve identity-bearing fields the form does not edit.
                    secretRef: this._original?.secretRef,
                    accessSecretRef: this._original?.accessSecretRef,
                    colour: this._original?.colour,
                },
                { index: colourIndex, existing: this._existingIds },
            );
        }

        /**
         * The first reason this form cannot be saved, or '' when it can.
         *
         * Ordering matches the visual order of the dialog so the message always
         * refers to something above it.
         *
         * @returns {string}
         */
        _validationProblem() {
            const typedUrl = this._urlRow.text.trim();
            if (!typedUrl) return _('Enter the Zabbix URL.');

            try {
                normaliseBaseUrl(typedUrl);
            } catch (error) {
                return error?.message ?? _('That Zabbix URL is not usable.');
            }

            if (!this._secretRow.text.trim() && !this._hasStoredSecret) {
                return this._authRow.selected === 1
                    ? _('Enter the password for this user.')
                    : _('Enter an API token.');
            }

            const hasId = Boolean(this._accessIdRow.text.trim() || this._currentAccessClientId());
            const hasSecret = Boolean(
                this._accessSecretRow.text.trim() || this._hasStoredAccessSecret,
            );
            if (hasId !== hasSecret) {
                return hasId
                    ? _('The Cloudflare Access client id also needs its secret, or clear both.')
                    : _('The Cloudflare Access secret also needs its client id, or clear both.');
            }

            return '';
        }

        /** @returns {string} client id currently in the form */
        _currentAccessClientId() {
            return this._accessIdRow.text.trim();
        }

        /**
         * Reflect validity on the Save button and explain it on screen.
         *
         * A disabled button plus a visible reason is the only combination that
         * cannot be mistaken for "the Save button does nothing".
         *
         * @param {string} [severity] one of SEVERITY, for hard failures
         * @returns {string} the current problem, '' when valid
         */
        _refreshSaveState(severity = '') {
            const problem = this._validationProblem();
            this._saveButton.sensitive = !this._saving && problem === '';
            // A brand-new dialog has nothing to complain about yet; the hint
            // appears once there is something to correct.
            this._setAlert(this._hasInput() ? problem : '', severity);
            return problem;
        }

        /** @returns {boolean} has the user filled in anything at all */
        _hasInput() {
            return Boolean(
                this._urlRow.text.trim() ||
                this._secretRow.text.trim() ||
                this._accessIdRow.text.trim() ||
                this._labelRow.text.trim() ||
                this._filterRow.text.trim(),
            );
        }

        /**
         * Show or clear the banner at the top of the dialog.
         *
         * @param {string} message
         * @param {string} [severity]
         */
        _setAlert(message, severity = '') {
            const critical = severity === SEVERITY.CRIT;
            const visible = Boolean(message);

            this._alertGroup.visible = visible;
            this._alertRow.visible = visible;
            this._alertRow.title = critical ? _('Could not save') : _('Cannot save yet');
            this._alertRow.subtitle = message;

            this._alertRow.remove_css_class('zappix-alert-crit');
            this._alertRow.remove_css_class('zappix-alert-warn');
            if (visible) {
                this._alertRow.add_css_class(critical ? 'zappix-alert-crit' : 'zappix-alert-warn');
            }
        }

        /**
         * Validate, persist, and close only once the write actually happened.
         *
         * The dialog used to close before the asynchronous store ran, so a
         * keyring failure or a rejected settings write discarded everything the
         * user had typed without a word of explanation.
         */
        async _save() {
            const problem = this._refreshSaveState();
            if (problem) return;

            const draft = this._buildDraft();
            if (!draft) return;

            const secret = this._secretRow.text.trim();
            const accessSecret = this._accessSecretRow.text.trim();

            this._saving = true;
            this._saveButton.sensitive = false;
            this._saveButton.label = _('Saving…');
            this._setAlert('');

            try {
                const outcome = await this._onSave({ server: draft, secret, accessSecret });
                if (outcome && outcome.ok === false) {
                    this._setAlert(
                        outcome.error || _('The server could not be saved.'),
                        SEVERITY.CRIT,
                    );
                    return;
                }
                this.close();
            } catch (error) {
                this._setAlert(error?.message ?? String(error), SEVERITY.CRIT);
            } finally {
                this._saving = false;
                this._saveButton.label = _('Save');
                this._saveButton.sensitive = this._validationProblem() === '';
            }
        }

        /**
         * Abort an in-flight test and close.
         */
        close() {
            this._testClient?.destroy();
            this._testClient = null;
            super.close();
        }
    },
);
