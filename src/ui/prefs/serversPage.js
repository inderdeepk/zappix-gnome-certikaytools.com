// prefs/serversPage.js — the server list and its add/edit/remove flow.
//
// This page is the only place servers are created, so it is also the natural
// place to make the storage model visible: every save writes the definition to
// GSettings and the credential to the keyring, and both are removed together.
// A server that still has a token after being deleted is the kind of leak that
// survives for years, so removal goes through the same path as creation.
//
// Preferences-process module (Adw/Gtk).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { ServerEditor } from './serverEditor.js';
import { swapGroup } from './widgets.js';
import { zabbixLogoIcon } from '../../shared/brand.js';
import { MAX_SERVERS, removeServer, upsertServer } from '../../shared/serverStore.js';
import { format, gettext as _ } from '../../shared/i18n.js';

export class ServersPage {
    /**
     * @param {object} options
     * @param {import('../../shared/settings.js').ZappixSettings} options.settings
     * @param {import('../../shared/secrets.js').SecretStore} options.secrets
     * @param {Gtk.Window} options.window preferences window, used as dialog parent
     */
    constructor({ settings, secrets, window }) {
        this._settings = settings;
        this._secrets = secrets;
        this._window = window;

        this.page = new Adw.PreferencesPage({
            title: _('Servers'),
            icon_name: 'network-server-symbolic',
        });

        // Built once and never swapped, so the brand stays above the list no
        // matter how often the stored servers change.
        this._brandGroup = this._buildBrandGroup();
        this.page.add(this._brandGroup);

        this._listGroup = null;
        this._addGroup = null;
        this._storageGroup = null;

        this.refresh();
    }

    /**
     * Brand header for the page a user lands on first.
     *
     * @returns {Adw.PreferencesGroup}
     */
    _buildBrandGroup() {
        const group = new Adw.PreferencesGroup();

        const row = new Adw.ActionRow({
            title: 'Zappix',
            subtitle: _('Live server monitoring for Zabbix'),
        });
        row.add_prefix(
            new Gtk.Image({
                gicon: zabbixLogoIcon(),
                pixel_size: 40,
                valign: Gtk.Align.CENTER,
            }),
        );
        group.add(row);

        return group;
    }

    // ── rendering ───────────────────────────────────────────────────────────

    /**
     * Rebuild the row list from the stored settings.
     *
     * The row count is small (capped at MAX_SERVERS) so a full rebuild on every
     * change is cheaper than reconciling, and guarantees the page can never show
     * a stale server.
     */
    refresh() {
        const listGroup = new Adw.PreferencesGroup({
            title: _('Monitored servers'),
            description: _('Zappix polls each enabled server and shows its hosts in the dropdown.'),
        });

        const { servers, recovered, error } = this._settings.serverDocument;

        if (error) {
            listGroup.add(this._warningRow(_('The stored server list could not be read.'), error));
        } else if (recovered) {
            listGroup.add(
                this._warningRow(
                    _('The stored server list was repaired.'),
                    _('Some entries were dropped or renamed because they were invalid.'),
                ),
            );
        }

        if (servers.length === 0) {
            listGroup.add(
                new Adw.ActionRow({
                    title: _('No servers configured'),
                    subtitle: _('Add your Zabbix server URL and an API token to begin.'),
                }),
            );
        }

        for (const server of servers) {
            listGroup.add(this._buildServerRow(server));
        }

        const storageGroup = this._buildStorageGroup();

        // Replace, in order: list, add button, storage note.
        swapGroup(this.page, this._listGroup, listGroup);
        this._listGroup = listGroup;

        const addGroup = new Adw.PreferencesGroup();
        const addButton = new Gtk.Button({
            label: _('Add server'),
            halign: Gtk.Align.CENTER,
            css_classes: ['suggested-action', 'pill'],
            sensitive: servers.length < MAX_SERVERS,
        });
        addButton.connect('clicked', () => this._openEditor(null));
        addGroup.add(addButton);

        swapGroup(this.page, this._addGroup, addGroup);
        this._addGroup = addGroup;

        swapGroup(this.page, this._storageGroup, storageGroup);
        this._storageGroup = storageGroup;
    }

    /**
     * @param {object} server
     * @returns {Adw.ActionRow}
     */
    _buildServerRow(server) {
        const parts = [
            server.baseUrl,
            server.authMode === 'user' ? _('username and password') : _('API token'),
        ];
        if (server.accessClientId) parts.push(_('Cloudflare Access'));
        if (!server.enabled) parts.push(_('disabled'));
        const subtitle = parts.join(' · ');

        const row = new Adw.ActionRow({
            title: server.label,
            subtitle,
        });

        const swatch = new Gtk.DrawingArea({
            width_request: 12,
            height_request: 12,
            valign: Gtk.Align.CENTER,
        });
        swatch.set_draw_func((_area, cr) => {
            const colour = parseHexColour(server.colour);
            cr.setSourceRGBA(colour.r, colour.g, colour.b, 1);
            cr.arc(6, 6, 5, 0, Math.PI * 2);
            cr.fill();
        });
        row.add_prefix(swatch);

        const editButton = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Edit'),
        });
        editButton.connect('clicked', () => this._openEditor(server));
        row.add_suffix(editButton);

        const deleteButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Remove'),
        });
        deleteButton.connect('clicked', () => this._confirmDelete(server));
        row.add_suffix(deleteButton);

        return row;
    }

    /**
     * Explain where credentials live, and warn when the keyring is unavailable.
     *
     * A user who assumes their token is encrypted should be told when it is not.
     *
     * @returns {Adw.PreferencesGroup}
     */
    _buildStorageGroup() {
        const group = new Adw.PreferencesGroup({ title: _('Credential storage') });

        const backend = this._secrets.backend;
        const row = new Adw.ActionRow({
            title: _('Backend'),
            subtitle:
                backend === 'file'
                    ? _(
                        'A private file (mode 0600) is used because the login keyring is unavailable.',
                    )
                    : _('Tokens are stored in the login keyring via libsecret.'),
        });
        group.add(row);

        // The backend is detected lazily on the first lookup, so probe once and
        // correct the row if the keyring turns out to be missing.
        this._secrets
            .lookup('zappix:__probe__')
            .then(() => {
                if (this._secrets.backend !== 'file') return;
                row.subtitle = _(
                    'A private file (mode 0600) is used because the login keyring is unavailable.',
                );
            })
            .catch(() => { });

        return group;
    }

    /**
     * @param {string} title
     * @param {string} subtitle
     * @returns {Adw.ActionRow}
     */
    _warningRow(title, subtitle) {
        const row = new Adw.ActionRow({ title, subtitle });
        row.add_prefix(
            new Gtk.Image({
                icon_name: 'dialog-warning-symbolic',
                valign: Gtk.Align.CENTER,
            }),
        );
        row.add_css_class('zappix-warning-row');
        return row;
    }

    // ── actions ─────────────────────────────────────────────────────────────

    /**
     * @param {object|null} server
     */
    _openEditor(server) {
        const existingIds = this._settings.servers.map((entry) => entry.id);

        const editor = new ServerEditor({
            server,
            existingIds,
            hasStoredSecret: Boolean(server),
            hasStoredAccessSecret: Boolean(server?.accessClientId),
            parent: this._window,
            // Deliberately returned, not fire-and-forget: the editor awaits it
            // and only closes once the definition and the credential are both
            // written, so a failure keeps the user's input on screen.
            onSave: (result) => this._save(result),
        });

        editor.present();
    }

    /**
     * @param {{server: object, secret: string, accessSecret: string}} result
     * @returns {Promise<{ok: boolean, error: string}>}
     */
    async _save({ server, secret, accessSecret = '' }) {
        let credentialsChanged = false;

        if (secret) {
            const outcome = await this._secrets.store(server.secretRef, secret);
            if (!outcome.ok) {
                return {
                    ok: false,
                    error: `${_('Could not store the API token.')} ${outcome.error ?? ''}`.trim(),
                };
            }
            credentialsChanged = true;
        }

        // The Access secret follows the client id: set together, cleared
        // together. A leftover secret for a server that no longer uses Access
        // would be an orphaned credential.
        if (accessSecret) {
            const outcome = await this._secrets.store(server.accessSecretRef, accessSecret);
            if (!outcome.ok) {
                return {
                    ok: false,
                    error:
                        `${_('Could not store the Access client secret.')} ` +
                        `${outcome.error ?? ''}`.trim(),
                };
            }
            credentialsChanged = true;
        } else if (!server.accessClientId) {
            await this._secrets.remove(server.accessSecretRef);
        }

        this._settings.servers = upsertServer(this._settings.servers, server);

        // A token-only edit leaves the servers JSON untouched; this is what
        // makes the running extension reread the credential immediately
        // instead of keeping the empty lookup it got at startup.
        if (credentialsChanged) this._settings.bumpCredentialsRevision();

        // The first server added becomes the active one; otherwise the dropdown
        // would open on an empty card.
        if (!this._settings.activeServerId) {
            this._settings.activeServerId = server.id;
        }

        this.refresh();

        // `ZappixSettings` swallows a failed GSettings write (it logs and
        // returns), which used to look identical to a successful save. Read it
        // back and say so instead of pretending.
        if (!this._settings.servers.some((entry) => entry.id === server.id)) {
            return {
                ok: false,
                error: _('The server list could not be written to the extension settings.'),
            };
        }

        return { ok: true, error: '' };
    }

    /**
     * @param {object} server
     */
    _confirmDelete(server) {
        const dialog = new Gtk.AlertDialog({
            message: format(_('Remove “{name}”?'), { name: server.label }),
            detail: _('Its stored API token will also be deleted. Monitoring stops immediately.'),
            buttons: [_('Cancel'), _('Remove')],
            cancel_button: 0,
            default_button: 0,
            modal: true,
        });

        dialog.choose(this._window, null, (source, result) => {
            let choice = 0;
            try {
                choice = source.choose_finish(result);
            } catch {
                return; // dismissed
            }
            if (choice !== 1) return;

            this._delete(server).catch((error) => {
                logError(error, 'Zappix: could not remove server');
                this._showError(_('Could not remove the server.'), error?.message ?? '');
            });
        });
    }

    /**
     * @param {object} server
     * @returns {Promise<void>}
     */
    async _delete(server) {
        await this._secrets.remove(server.secretRef);
        await this._secrets.remove(server.accessSecretRef);
        const remaining = removeServer(this._settings.servers, server.id);
        this._settings.servers = remaining;
        this._settings.bumpCredentialsRevision();

        if (this._settings.activeServerId === server.id) {
            this._settings.activeServerId = remaining[0]?.id ?? '';
        }

        this.refresh();
    }

    /**
     * @param {string} message
     * @param {string} detail
     */
    _showError(message, detail) {
        const dialog = new Gtk.AlertDialog({
            message,
            detail,
            buttons: [_('Close')],
            modal: true,
        });
        dialog.choose(this._window, null, () => { });
    }
}

/**
 * Parse `#rrggbb` into 0..1 components for Cairo.
 *
 * @param {string} hex
 * @returns {{r: number, g: number, b: number}}
 */
function parseHexColour(hex) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(hex ?? ''));
    if (!match) return { r: 0.48, g: 0.64, b: 0.97 };

    const value = Number.parseInt(match[1], 16);
    return {
        r: ((value >> 16) & 0xff) / 255,
        g: ((value >> 8) & 0xff) / 255,
        b: (value & 0xff) / 255,
    };
}
