// zabbixEndpoints.js — URL normalisation and version helpers (pure).
//
// Users paste whatever their monitoring URL bar shows: a bare origin, the
// frontend directory, or the API script itself. Rather than reject the common
// variants, this module canonicalises all of them into the two URLs the client
// needs — the JSON-RPC endpoint and the human-facing frontend — so the rest of
// the code never has to guess.
//
// Pure JavaScript: no GI imports, unit-tested under plain `gjs`.

/** Zabbix's JSON-RPC entry point, relative to the frontend directory. */
const API_SCRIPT = 'api_jsonrpc.php';

/**
 * http(s) URL parser.
 *
 * GJS does not expose the WHATWG `URL` constructor (it is not a global in the
 * 1.80 runtime), so this minimal parser exists instead of pulling a dependency
 * into an extension that must stay loadable offline. It handles exactly the
 * shape a user can paste into the preferences window and rejects everything
 * else loudly, which is the behaviour the connection test depends on.
 *
 * Accepted: `scheme://authority/path?query#fragment`, with authority being
 * `host[:port]` and an optional `user:pass@` prefix that is discarded.
 *
 * @param {string} raw
 * @returns {{protocol: string, host: string, hostname: string, port: string, pathname: string}}
 * @throws {TypeError} when the input is not an absolute http(s) URL
 */
export function parseHttpUrl(raw) {
    const text = String(raw ?? '').trim();
    const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(text);

    if (!match) {
        throw new TypeError(`"${text}" is not a valid URL.`);
    }

    const protocol = match[1].toLowerCase();
    if (protocol !== 'http' && protocol !== 'https') {
        throw new TypeError('Only http:// and https:// URLs are supported.');
    }

    // Discard any embedded credentials; they are never valid for a Zabbix
    // frontend URL and would end up in logs.
    const authority = match[2];
    const hostPort = authority.includes('@')
        ? authority.slice(authority.lastIndexOf('@') + 1)
        : authority;

    if (!hostPort || /\s/.test(hostPort)) {
        throw new TypeError(`"${text}" is missing a host name.`);
    }

    const portMatch = /^\[?([^\]]+)\]?(?::(\d+))?$/.exec(hostPort);
    if (!portMatch) {
        throw new TypeError(`"${text}" has an invalid host.`);
    }

    return {
        protocol,
        host: hostPort,
        hostname: portMatch[1],
        port: portMatch[2] ?? '',
        pathname: match[3] || '',
    };
}

/**
 * Normalise a user-entered Zabbix URL.
 *
 * Accepted inputs (all resolve to the same endpoint):
 *   https://monitor.example.com
 *   https://monitor.example.com/
 *   https://monitor.example.com/zabbix
 *   https://monitor.example.com/zabbix/
 *   https://monitor.example.com/zabbix/api_jsonrpc.php
 *   monitor.example.com/zabbix          (scheme defaults to https)
 *
 * Query strings and fragments are dropped: they never belong to an API route
 * and keeping them would corrupt the endpoint.
 *
 * @param {string} raw user input
 * @returns {{origin: string, frontendUrl: string, apiUrl: string, path: string}}
 * @throws {TypeError} when the input cannot be turned into an http(s) URL
 */
export function normaliseBaseUrl(raw) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) {
        throw new TypeError('Server URL is empty.');
    }

    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

    const parsed = parseHttpUrl(withScheme);
    const origin = `${parsed.protocol}://${parsed.host}`;

    // Strip the API script (and any trailing slash) so the remainder is the
    // frontend directory, which is what users recognise.
    let path = parsed.pathname.replace(/\/+$/, '');
    path = path.replace(new RegExp(`/${API_SCRIPT}$`, 'i'), '');
    path = path.replace(/\/+$/, '');

    return {
        origin,
        frontendUrl: `${origin}${path}`,
        apiUrl: `${origin}${path}/${API_SCRIPT}`,
        path,
    };
}

/**
 * Build the frontend URL for a specific dashboard, so a server card can link
 * straight to the relevant Zabbix screen.
 *
 * Zabbix accepts `?kiosk` to hide the surrounding chrome and
 * `?dashboardid=` to select a dashboard; unknown parameters are ignored, so
 * this is safe against older servers.
 *
 * @param {string} baseUrl any accepted by `normaliseBaseUrl`
 * @param {object} [options]
 * @param {string} [options.tab] frontend action, e.g. 'host.dashboard.view'
 * @param {string} [options.hostId] host to focus
 * @returns {string}
 */
export function buildFrontendUrl(baseUrl, { tab = '', hostId = '' } = {}) {
    const { frontendUrl } = normaliseBaseUrl(baseUrl);
    const params = [];
    if (tab) params.push(`action=${encodeURIComponent(tab)}`);
    if (hostId) params.push(`hostid=${encodeURIComponent(hostId)}`);
    return params.length ? `${frontendUrl}?${params.join('&')}` : frontendUrl;
}

/**
 * Compare two dotted Zabbix versions.
 *
 * Zabbix reports `apiinfo.version` as e.g. "7.0.3" or "6.4.10rc1"; anything
 * after the first non-numeric run is a pre-release tag and is ignored, which
 * matches how the server itself gates features (7.0.0rc1 behaves like 7.0).
 *
 * @param {string} version
 * @param {string} target
 * @returns {boolean} true when `version` >= `target`
 */
export function versionAtLeast(version, target) {
    const left = parseVersionParts(version);
    const right = parseVersionParts(target);
    const length = Math.max(left.length, right.length);

    for (let index = 0; index < length; index++) {
        const a = left[index] ?? 0;
        const b = right[index] ?? 0;
        if (a > b) return true;
        if (a < b) return false;
    }
    return true;
}

/**
 * Numeric components of a version string.
 *
 * @param {string} version
 * @returns {number[]}
 */
export function parseVersionParts(version) {
    const match = String(version ?? '').match(/\d+(?:\.\d+)*/);
    if (!match) return [];
    return match[0].split('.').map((part) => Number.parseInt(part, 10));
}

/**
 * Should this server receive session tokens in the `auth` body field?
 *
 * Zabbix 7.2 removed the `auth` property, so anything at or above that version
 * must authenticate with the Authorization header exclusively. Older servers
 * accept both, and sending both is the compatibility sweet spot — except when
 * the server rejects unknown body properties, which 7.2+ does.
 *
 * @param {string} version `apiinfo.version` result
 * @returns {boolean}
 */
export function supportsLegacyAuthField(version) {
    if (!version) return true; // unknown → assume permissive
    return !versionAtLeast(version, '7.2');
}

/**
 * Does this server accept the `Authorization: Bearer` header?
 *
 * Introduced in Zabbix 6.4 (ZBXNEXT-8051). Zabbix 6.0 and older understand the
 * top-level `auth` property only, which is why the client keeps both paths.
 *
 * @param {string} version `apiinfo.version` result
 * @returns {boolean}
 */
export function supportsBearerHeader(version) {
    if (!version) return true;
    return versionAtLeast(version, '6.4');
}

/**
 * Does `user.login` take `username` rather than the legacy `user` parameter?
 *
 * Zabbix 6.4 renamed the field; 6.0 and older reject `username`.
 *
 * @param {string} version
 * @returns {boolean}
 */
export function usesModernLoginField(version) {
    if (!version) return true;
    return versionAtLeast(version, '6.4');
}

/**
 * Does this server use the renamed host-group property?
 *
 * Zabbix renamed `selectGroups` to `selectHostGroups` in 7.0 (the old name was
 * removed in 7.2). Feature detection is cheaper than version detection, but
 * the API gives us the version for free during the probe, so use it.
 *
 * @param {string} version
 * @returns {boolean}
 */
export function usesHostGroupsProperty(version) {
    if (!version) return true;
    return versionAtLeast(version, '7.0');
}
