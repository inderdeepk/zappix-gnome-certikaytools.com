// zabbixResponse.test.js — recognising what actually answered the request.
//
// The production deployment sits behind Cloudflare Access, which answers a
// perfectly valid API token with a login page. Every one of these shapes was
// observed on a real request to a protected hostname, and each has to collapse
// into "configure a service token" rather than "the server is broken".
import { assertEqual, assert, runTests } from './testUtils.js';
import {
    ACCESS_MESSAGE,
    ACCESS_REJECTED_MESSAGE,
    describeAccessAnswer,
    describeHttpStatus,
    looksLikeHtml,
    looksLikeJson,
    looksLikeAccessChallenge,
} from '../src/api/zabbixResponse.js';

await runTests([
    // ── looksLikeHtml ───────────────────────────────────────────────────
    [
        'looksLikeHtml recognises a doctype and a bare html element',
        () => {
            assertEqual(looksLikeHtml('<!DOCTYPE html><html><body>x</body></html>'), true);
            assertEqual(looksLikeHtml('\n\n  <html lang="en">'), true);
            assertEqual(looksLikeHtml('<head><title>Login</title></head>'), true);
        },
    ],
    [
        'looksLikeHtml rejects JSON and empty bodies',
        () => {
            assertEqual(looksLikeHtml('{"jsonrpc":"2.0","result":[]}'), false);
            assertEqual(looksLikeHtml(''), false);
            assertEqual(looksLikeHtml(null), false);
        },
    ],
    [
        'looksLikeHtml ignores HTML that only appears deep in the body',
        () => {
            // A JSON error string quoting markup must not be mistaken for a page.
            assertEqual(looksLikeHtml('{"error":"unexpected <html> in value"}'), false);
        },
    ],

    // ── looksLikeAccessChallenge ────────────────────────────────────────
    [
        'looksLikeAccessChallenge spots a redirect to the team domain',
        () => {
            assertEqual(
                looksLikeAccessChallenge({
                    status: 302,
                    text: '',
                    location: 'https://deliveredge.cloudflareaccess.com/cdn-cgi/access/login',
                }),
                true,
            );
        },
    ],
    [
        'looksLikeAccessChallenge spots a redirect naming the Access headers',
        () => {
            assertEqual(
                looksLikeAccessChallenge({
                    status: 302,
                    text: '',
                    location: '/cdn-cgi/access/login',
                }),
                true,
            );
        },
    ],
    [
        'looksLikeAccessChallenge spots a 200 login document',
        () => {
            const page =
                '<!DOCTYPE html><html><head><script src="/cdn-cgi/access/login.js"></script>' +
                '</head><body>Sign in</body></html>';
            assertEqual(looksLikeAccessChallenge({ status: 200, text: page }), true);
        },
    ],
    [
        'looksLikeAccessChallenge honours the cf-mitigated header',
        () => {
            assertEqual(
                looksLikeAccessChallenge({ status: 403, text: '', cfMitigated: 'CHALLENGE' }),
                true,
            );
        },
    ],
    [
        'looksLikeAccessChallenge does not fire on a normal Zabbix answer',
        () => {
            assertEqual(
                looksLikeAccessChallenge({
                    status: 200,
                    text: '{"jsonrpc":"2.0","result":"7.4.16","id":1}',
                }),
                false,
            );
            assertEqual(
                looksLikeAccessChallenge({ status: 500, text: 'Internal Server Error' }),
                false,
            );
        },
    ],
    [
        'looksLikeAccessChallenge ignores a page that merely mentions Cloudflare',
        () => {
            const page = '<!DOCTYPE html><html><body>Cloudflare is our CDN.</body></html>';
            assertEqual(looksLikeAccessChallenge({ status: 200, text: page }), false);
        },
    ],

    // ── describeHttpStatus ──────────────────────────────────────────────
    [
        'describeHttpStatus names the layer behind a redirect',
        () => {
            const message = describeHttpStatus(302, '', { location: 'https://mon.example.com/' });
            assert(message.includes('https://mon.example.com/'), message);
        },
    ],
    [
        'describeHttpStatus hides the internal Access login target',
        () => {
            // Telling the user to "use the final URL" of the login page would
            // send them round the redirect loop again.
            const message = describeHttpStatus(302, '', {
                location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login',
            });
            assert(!message.includes('cloudflareaccess.com'), message);
        },
    ],
    [
        'describeHttpStatus explains the statuses a proxy produces',
        () => {
            assert(describeHttpStatus(401, '').includes('API token'));
            assert(describeHttpStatus(403, '').includes('permissions'));
            assert(describeHttpStatus(404, '').includes('base URL'));
            assert(describeHttpStatus(429, '').includes('refresh interval'));
            assert(describeHttpStatus(503, '').includes('unreachable'));
        },
    ],
    [
        'describeHttpStatus quotes an unexpected body',
        () => {
            const message = describeHttpStatus(418, 'short and stout');
            assert(message.includes('418'), message);
            assert(message.includes('short and stout'), message);
        },
    ],
    [
        'ACCESS_MESSAGE tells the user exactly what to do next',
        () => {
            assert(ACCESS_MESSAGE.includes('service token'), ACCESS_MESSAGE);
            assert(ACCESS_MESSAGE.includes('api_jsonrpc.php'), ACCESS_MESSAGE);
        },
    ],
    [
        'ACCESS_REJECTED_MESSAGE assumes a token was already supplied',
        () => {
            // The user who sees this has a token pasted in; telling them to
            // create one is the mistake this message exists to avoid.
            assert(ACCESS_REJECTED_MESSAGE.includes('rejected'), ACCESS_REJECTED_MESSAGE);
            assert(ACCESS_REJECTED_MESSAGE.includes('Service Auth'), ACCESS_REJECTED_MESSAGE);
        },
    ],
    [
        'describeAccessAnswer names the redirect target',
        () => {
            const text = describeAccessAnswer({
                status: 302,
                location: 'https://deliveredge.cloudflareaccess.com/cdn-cgi/access/login',
            });
            assert(text.includes('deliveredge.cloudflareaccess.com'), text);
            assert(text.includes('302'), text);
        },
    ],
    [
        'describeAccessAnswer calls out a WAF challenge specifically',
        () => {
            const text = describeAccessAnswer({ status: 403, cfMitigated: 'CHALLENGE' });
            assert(text.toLowerCase().includes('waf'), text);
        },
    ],
    [
        'describeAccessAnswer truncates an absurdly long redirect',
        () => {
            const text = describeAccessAnswer({
                status: 302,
                location: `https://x.example.com/${'a'.repeat(400)}`,
            });
            assert(text.length < 220, `too long: ${text.length}`);
        },
    ],
    [
        'looksLikeJson separates an origin answer from an edge page',
        () => {
            assertEqual(looksLikeJson('{"jsonrpc":"2.0","error":{"code":-32602}}'), true);
            assertEqual(looksLikeJson('  [ ]  '), true);
            assertEqual(looksLikeJson('<!DOCTYPE html><html></html>'), false);
            assertEqual(looksLikeJson(''), false);
            assertEqual(looksLikeJson('error code: 1020'), false);
        },
    ],
]);
