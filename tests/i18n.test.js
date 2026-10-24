// i18n.test.js — the gettext bridge and its placeholder helper.
//
// The bridge must be safe BEFORE initialisation (identity translation) because
// it is imported under plain gjs by the tests and the import smoke script, and
// must delegate to the injected functions afterwards. Order matters inside this
// file: identity assertions run before initI18n(), injection assertions after.
import { assertEqual, runTests } from './testUtils.js';
import { format, gettext, initI18n, ngettext } from '../src/shared/i18n.js';

await runTests([
    [
        'gettext is identity before initI18n',
        () => {
            assertEqual(gettext('Ask anything…'), 'Ask anything…');
        },
    ],
    [
        'ngettext falls back to singular and plural',
        () => {
            assertEqual(ngettext('one host', 'many hosts', 1), 'one host');
            assertEqual(ngettext('one host', 'many hosts', 0), 'many hosts');
            assertEqual(ngettext('one host', 'many hosts', 5), 'many hosts');
        },
    ],
    [
        'format substitutes placeholders',
        () => {
            assertEqual(format('Deleting {name}', { name: 'Production' }), 'Deleting Production');
        },
    ],
    [
        'format substitutes several placeholders including falsy values',
        () => {
            assertEqual(format('{a}-{b}-{c}', { a: 'x', b: 2, c: 0 }), 'x-2-0');
        },
    ],
    [
        'format leaves unknown placeholders verbatim',
        () => {
            assertEqual(format('{known} {unknown}', { known: 'ok' }), 'ok {unknown}');
        },
    ],
    [
        'format is a no-op without params',
        () => {
            assertEqual(format('plain {text}'), 'plain {text}');
        },
    ],
    [
        'initI18n accepts partial injection',
        () => {
            initI18n({ gettext: (text) => `T:${text}` });
            assertEqual(gettext('hello'), 'T:hello');
            // ngettext was never injected, so it keeps the identity fallback.
            assertEqual(ngettext('a', 'b', 2), 'b');
        },
    ],
    [
        'initI18n ignores non-function arguments',
        () => {
            initI18n({ gettext: 'not a function' });
            assertEqual(gettext('hello'), 'T:hello');
        },
    ],
    [
        'initI18n injects ngettext',
        () => {
            initI18n({
                gettext: (text) => text,
                ngettext: (singular, plural, count) =>
                    `${count}:${count === 1 ? singular : plural}`,
            });
            assertEqual(ngettext('item', 'items', 3), '3:items');
        },
    ],
]);
