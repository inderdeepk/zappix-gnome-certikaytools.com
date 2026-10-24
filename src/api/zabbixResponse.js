// zabbixResponse.js — turning an HTTP answer into a sentence a human can act on.
//
// Pure: no sockets, no Soup. The transport collects the status, body and the
// handful of headers that matter and hands them here, which keeps the one
// genuinely awkward case — a deployment fronted by Cloudflare Access, where a
// correct token still yields an HTML login page — testable without a network.
//
// Zabbix never answers with HTML. Anything HTML-shaped in front of
// /api_jsonrpc.php is an intermediary: Access, a proxy login, a captive portal.

/**
 * Shown whenever Cloudflare Access intercepts a request.
 *
 * @type {string}
 */
export const ACCESS_MESSAGE =
    'Cloudflare Access is protecting this hostname. Create a service token ' +
    '(Zero Trust → Access → Service auth), then add its client id and secret ' +
    'to this server in Zappix, or scope an Access bypass policy to ' +
    '/api_jsonrpc.php.';

/**
 * Shown when a service token *was* sent and Access still asked for a login.
 *
 * The distinction matters: "create a token" is useless advice to someone who
 * already has one pasted in. What is almost always wrong is that the token is
 * not referenced by the application's policy.
 *
 * @type {string}
 */
export const ACCESS_REJECTED_MESSAGE =
    'Cloudflare Access rejected the service token. The token exists and was sent, ' +
    'but this application does not accept it. In Zero Trust → Access → ' +
    'Applications → your monitoring app → Policies, add a policy with Action ' +
    '"Service Auth" that includes this token (or add it as an include on the ' +
    'existing policy), then save. If it is already listed, check the client ' +
    'secret was pasted in full and has not been rotated.';

/**
 * One clause naming what Cloudflare actually answered.
 *
 * Kept short and appended to the actionable sentence, so a screenshot of the
 * dialog is enough to tell a redirect from a WAF challenge from a bare 403.
 *
 * @param {object} answer
 * @param {number} answer.status
 * @param {string} [answer.location]
 * @param {string} [answer.cfMitigated]
 * @returns {string}
 */
export function describeAccessAnswer({ status, location = '', cfMitigated = '' }) {
    if (String(cfMitigated).toLowerCase() === 'challenge') {
        return ' Cloudflare answered with a WAF challenge (cf-mitigated: challenge), which a service token cannot pass — check Security → WAF for this hostname.';
    }

    const target = String(location ?? '').trim();
    if (target) {
        const shown = target.length > 120 ? `${target.slice(0, 117)}…` : target;
        return ` Cloudflare redirected the request to ${shown} (HTTP ${status}).`;
    }

    if (status === 200) {
        return ' Cloudflare answered HTTP 200 with its login page.';
    }

    return ` Cloudflare answered HTTP ${status}.`;
}

/**
 * Does this body look like an HTML document rather than JSON?
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeHtml(text) {
    const head = String(text ?? '')
        .trimStart()
        .slice(0, 200)
        .toLowerCase();
    return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<head>');
}

/**
 * Is this body a JSON document?
 *
 * Zabbix answers `/api_jsonrpc.php` with JSON in every case, including its own
 * errors. JSON therefore means "the origin answered"; anything else at the HTTP
 * level came from the edge.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeJson(text) {
    const head = String(text ?? '')
        .trimStart()
        .slice(0, 1);
    return head === '{' || head === '[';
}

/**
 * Was this answer an identity check rather than an API response?
 *
 * Access answers a request without a valid service token three different ways
 * depending on configuration: a redirect to the team domain, a 302 to the
 * protected hostname's own login page, or — when the policy sends it straight
 * to the browser flow — a 200 carrying the login document itself. All three
 * mean "no credentials", which is why they collapse into one verdict.
 *
 * @param {object} response
 * @param {number} response.status
 * @param {string} response.text
 * @param {string} [response.location]
 * @param {string} [response.cfMitigated]
 * @returns {boolean}
 */
export function looksLikeAccessChallenge({ status, text, location = '', cfMitigated = '' }) {
    const haystack = `${location} ${text}`.toLowerCase();

    if (haystack.includes('cloudflareaccess.com')) return true;
    // Same-hostname Access apps redirect to their own /cdn-cgi/access/login
    // rather than to the team domain; the path is the durable signal.
    if (haystack.includes('/cdn-cgi/access/')) return true;
    if (haystack.includes('cf-access-client-id') || haystack.includes('cf-access-token'))
        return true;
    if (/cf_chl_opt|cf-challenge|cf_chl_prog/.test(haystack)) return true;
    if (cfMitigated.toLowerCase() === 'challenge') return true;

    // An Access login page is served from the protected hostname itself and
    // names the team domain; look for the marker script rather than any mention
    // of "cloudflare", which a normal Zabbix page could contain.
    if (status === 200 && looksLikeHtml(text) && /cdn-cgi\/access|__cf_access/i.test(text)) {
        return true;
    }

    return false;
}

/**
 * Human explanation for a non-200 answer.
 *
 * These are the statuses a self-hosted Zabbix actually produces in front of a
 * reverse proxy — the point is to name the likely layer so the user does not
 * go looking for faults in the extension.
 *
 * @param {number} status
 * @param {string} text
 * @param {object} [headers]
 * @returns {string}
 */
export function describeHttpStatus(status, text, headers = {}) {
    switch (status) {
        case 301:
        case 302:
        case 303:
        case 307:
        case 308: {
            const target = String(headers.location ?? '');
            if (target && !target.toLowerCase().includes('cloudflareaccess')) {
                return `The server redirected to ${target}. Use the final https:// URL, including any subdirectory.`;
            }
            return 'The server redirected the request. Use the final https:// URL, including any subdirectory.';
        }
        case 401:
            return 'The server rejected the credentials (HTTP 401). Check the API token.';
        case 403:
            return 'The server refused access (HTTP 403). The token may lack API permissions.';
        case 404:
            return 'The API endpoint was not found (HTTP 404). Check the Zabbix base URL and subdirectory.';
        case 413:
            return 'The server rejected the request as too large (HTTP 413).';
        case 429:
            return 'The server is rate limiting requests (HTTP 429). Increase the refresh interval.';
        case 502:
        case 503:
        case 504:
            return 'The Zabbix frontend is unreachable behind its proxy (HTTP 502/503/504).';
        default: {
            const snippet = String(text ?? '')
                .trim()
                .slice(0, 120);
            return snippet
                ? `The server answered HTTP ${status}: ${snippet}`
                : `The server answered HTTP ${status}.`;
        }
    }
}
