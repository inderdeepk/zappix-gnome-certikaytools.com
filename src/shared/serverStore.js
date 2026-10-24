// serverStore.js — the server list document: validation, ordering, migration.
//
// The list lives in one GSettings string as JSON. That choice is deliberate:
// adding a server must never require a schema migration or an extension
// restart, and a user who edits the key by hand should get a repaired document
// rather than a crashed shell.
//
// Everything here is pure. The GSettings binding lives in `settings.js`, and
// credentials are *never* part of this document — `tokenRef` names the entry
// in the keyring instead (see `secrets.js`).
//
// Compatibility contract for the JSON document:
//   { "version": 1, "servers": [ … ] }
// An array at the top level is also accepted (the pre-versioning shape), so a
// future change can bump `version` without stranding existing installs.

import { normaliseBaseUrl, parseHttpUrl } from '../api/zabbixEndpoints.js';

/** Authentication strategies a server can use. */
export const AUTH_MODE = Object.freeze({
    /** Zabbix API token, sent as `Authorization: Bearer`. Recommended. */
    TOKEN: 'token',
    /** Username + password exchanged for a session token. */
    USER: 'user',
});

/** Document version written by this build. */
export const STORE_VERSION = 1;

/** Hard cap on configured servers: more than this is a dropdown nobody reads. */
export const MAX_SERVERS = 12;

/** Per-server accent hues, assigned round-robin so cards stay distinguishable. */
export const SERVER_COLOURS = Object.freeze([
    '#7aa2f7',
    '#9ece6a',
    '#e0af68',
    '#bb9af7',
    '#7dcfff',
    '#f7768e',
]);

/** Length limit for the user-facing label. */
const MAX_LABEL_LENGTH = 60;

/**
 * Generate a stable, opaque server id.
 *
 * Ids are used as keyring entry names, so they must be filesystem- and
 * D-Bus-safe: lowercase alphanumerics only.
 *
 * @param {object} [options]
 * @param {string[]} [options.existing=[]] ids already in use
 * @param {() => number} [options.random=Math.random] injectable for tests
 * @returns {string}
 */
export function makeServerId({ existing = [], random = Math.random } = {}) {
    const used = new Set(existing);
    for (let attempt = 0; attempt < 64; attempt++) {
        const suffix = Math.floor(random() * 36 ** 4)
            .toString(36)
            .padStart(4, '0');
        const candidate = `srv${suffix}`;
        if (!used.has(candidate)) return candidate;
    }
    // Astronomically unlikely; still better than returning a duplicate id.
    return `srv${Date.now().toString(36)}`;
}

/**
 * Validate and repair one server definition.
 *
 * Returns null only when the entry cannot be salvaged (no usable URL). Every
 * other field has a defined default, because a partially-broken entry that
 * still points at a real server is more useful than dropping it silently.
 *
 * @param {object} raw
 * @param {object} [options]
 * @param {number} [options.index=0] position, used for the fallback colour
 * @param {string[]} [options.existing=[]] ids already taken
 * @param {() => number} [options.random] injectable for tests
 * @returns {object|null}
 */
export function sanitiseServer(raw, { index = 0, existing = [], random } = {}) {
    if (!raw || typeof raw !== 'object') return null;

    let normalised;
    try {
        normalised = normaliseBaseUrl(raw.baseUrl ?? raw.url ?? '');
    } catch {
        return null;
    }

    const id =
        typeof raw.id === 'string' && /^[a-z0-9]{3,40}$/i.test(raw.id)
            ? raw.id
            : makeServerId({ existing, random });

    const label =
        String(raw.label ?? '')
            .trim()
            .slice(0, MAX_LABEL_LENGTH) || hostLabel(normalised);

    return {
        id,
        label,
        // The user's original string is not kept: storing the derived form
        // means a later change to normalisation cannot produce two servers that
        // point at the same endpoint with different text.
        baseUrl: normalised.frontendUrl,
        apiPath: '/api_jsonrpc.php',
        authMode: raw.authMode === AUTH_MODE.USER ? AUTH_MODE.USER : AUTH_MODE.TOKEN,
        username: raw.authMode === AUTH_MODE.USER ? String(raw.username ?? '').trim() : '',
        hostFilter: String(raw.hostFilter ?? '')
            .trim()
            .slice(0, MAX_LABEL_LENGTH),
        colour: /^#[0-9a-f]{6}$/i.test(String(raw.colour ?? ''))
            ? String(raw.colour)
            : SERVER_COLOURS[index % SERVER_COLOURS.length],
        enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
        // Explicit opt-in beats a global TLS setting when a user adds exactly
        // one self-signed server next to healthy HTTPS ones.
        allowUntrustedTls: Boolean(raw.allowUntrustedTls),
        // Cloudflare Access service token. The id is not secret (it travels as a
        // header next to the secret), so it lives in this document; only the
        // client secret goes to the keyring. A hostname behind Access answers a
        // plain client with an HTML login page instead of JSON, which is why
        // this exists at all — see Documentation/Help/DeliverEdge.md.
        accessClientId: String(raw.accessClientId ?? '')
            .trim()
            .slice(0, 128),
        accessSecretRef:
            typeof raw.accessSecretRef === 'string' && raw.accessSecretRef
                ? raw.accessSecretRef
                : `zappix-access:${id}`,
        // Named keyring entry; the secret itself never appears in this document.
        secretRef:
            typeof raw.secretRef === 'string' && raw.secretRef ? raw.secretRef : `zappix:${id}`,
    };
}

/**
 * `https://monitor.example.com/zabbix` → `monitor.example.com`.
 *
 * Reuses the engine's own parser rather than the (unavailable in GJS) WHATWG
 * `URL`, so the label always matches what the connection test accepted.
 *
 * @param {{frontendUrl: string, origin: string}} normalised
 * @returns {string}
 */
function hostLabel(normalised) {
    try {
        const { hostname } = parseHttpUrl(normalised.frontendUrl);
        return String(hostname).slice(0, MAX_LABEL_LENGTH) || 'Zabbix';
    } catch {
        return 'Zabbix';
    }
}

/**
 * Parse the stored JSON document into a validated, de-duplicated server list.
 *
 * Never throws: a corrupt document yields an empty list plus the reason, so
 * the preferences window can offer to reset it.
 *
 * @param {string} json
 * @param {() => number} [random] injectable for tests
 * @returns {{servers: object[], recovered: boolean, error: string}}
 */
export function parseServers(json, random) {
    if (typeof json !== 'string' || json.trim() === '') {
        return { servers: [], recovered: false, error: '' };
    }

    let decoded;
    try {
        decoded = JSON.parse(json);
    } catch (error) {
        return {
            servers: [],
            recovered: false,
            error: `Stored server list is not valid JSON (${error.message}).`,
        };
    }

    const rawList = Array.isArray(decoded)
        ? decoded
        : Array.isArray(decoded?.servers)
          ? decoded.servers
          : null;

    if (!rawList) {
        return { servers: [], recovered: false, error: 'Stored server list has an unknown shape.' };
    }

    const servers = [];
    const ids = new Set();
    let repaired = false;

    for (const entry of rawList) {
        if (servers.length >= MAX_SERVERS) {
            repaired = true;
            break;
        }

        const server = sanitiseServer(entry, { index: servers.length, existing: [...ids], random });
        if (!server) {
            repaired = true;
            continue;
        }
        if (ids.has(server.id)) {
            // Two entries claiming one id would share a keyring slot; re-key
            // the later one instead of dropping the server.
            server.id = makeServerId({ existing: [...ids], random });
            server.secretRef = `zappix:${server.id}`;
            server.accessSecretRef = `zappix-access:${server.id}`;
            repaired = true;
        }
        ids.add(server.id);
        servers.push(server);
    }

    return { servers, recovered: repaired || rawList.length !== servers.length, error: '' };
}

/**
 * Serialise the list for storage.
 *
 * @param {object[]} servers
 * @returns {string}
 */
export function serialiseServers(servers) {
    return JSON.stringify({
        version: STORE_VERSION,
        servers: (servers ?? []).slice(0, MAX_SERVERS),
    });
}

/**
 * Insert or replace a server, preserving list order.
 *
 * @param {object[]} servers
 * @param {object} server
 * @returns {object[]}
 */
export function upsertServer(servers, server) {
    const list = servers ?? [];
    const index = list.findIndex((entry) => entry.id === server.id);
    if (index === -1) {
        if (list.length >= MAX_SERVERS) return list;
        return [...list, server];
    }
    const next = [...list];
    next[index] = server;
    return next;
}

/**
 * Remove a server by id.
 *
 * @param {object[]} servers
 * @param {string} id
 * @returns {object[]}
 */
export function removeServer(servers, id) {
    return (servers ?? []).filter((entry) => entry.id !== id);
}

/**
 * Move a server one position earlier or later.
 *
 * @param {object[]} servers
 * @param {string} id
 * @param {-1|1} delta
 * @returns {object[]}
 */
export function moveServer(servers, id, delta) {
    const list = [...(servers ?? [])];
    const index = list.findIndex((entry) => entry.id === id);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= list.length) return list;
    [list[index], list[target]] = [list[target], list[index]];
    return list;
}

/**
 * Servers that should be polled.
 *
 * @param {object[]} servers
 * @returns {object[]}
 */
export function enabledServers(servers) {
    return (servers ?? []).filter((server) => server.enabled);
}

/**
 * Resolve the active server, falling back to the first enabled one.
 *
 * @param {object[]} servers
 * @param {string} activeId
 * @returns {object|null}
 */
export function resolveActiveServer(servers, activeId) {
    const enabled = enabledServers(servers);
    if (enabled.length === 0) return null;
    return enabled.find((server) => server.id === activeId) ?? enabled[0];
}

/**
 * Update one server through a patch, returning a new list.
 *
 * @param {object[]} servers
 * @param {string} id
 * @param {object} patch
 * @returns {object[]}
 */
export function patchServer(servers, id, patch) {
    return (servers ?? []).map((entry) =>
        entry.id === id ? (sanitiseServer({ ...entry, ...patch }, { index: 0 }) ?? entry) : entry,
    );
}
