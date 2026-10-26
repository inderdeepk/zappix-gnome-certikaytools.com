// secrets.test.js — what "no credential" means to the rest of the extension.
//
// The regression pinned down here: a keyring that cannot answer yet (locked at
// login, unlock prompt that timed out, daemon still starting) used to be
// indistinguishable from a token that was never stored. Both produced '', so
// the panel showed "Not configured" and stopped polling until the shell was
// restarted. `lookup()` may only resolve to '' when a backend positively
// reports an absence; every other failure must surface as
// CredentialUnavailableError so the poller can retry.
import GLib from 'gi://GLib';

import { assert, assertEqual, runTests } from './testUtils.js';
import { CredentialUnavailableError, SecretStore } from '../src/shared/secrets.js';

/**
 * A fake `gi://Secret` namespace.
 *
 * @param {object} [options]
 * @param {string|null} [options.value] what the lookup finds
 * @param {Error|null} [options.error] what the lookup fails with
 * @returns {object}
 */
function fakeSecret({ value = null, error = null } = {}) {
    return {
        Schema: class { },
        SchemaFlags: { NONE: 0 },
        SchemaAttributeType: { STRING: 0 },
        password_lookup(_schema, _attributes, _cancellable, callback) {
            callback(null, error ?? value);
        },
        password_lookup_finish(result) {
            if (result instanceof Error) throw result;
            return result;
        },
    };
}

/** @returns {string} a throwaway XDG data dir, so the file fallback is isolated */
function tempDataHome() {
    return GLib.dir_make_tmp('zappix-secrets-test-XXXXXX');
}

/**
 * Write the private credential file the way `SecretStore.store` would.
 *
 * @param {string} dataHome
 * @param {Record<string, string>} credentials
 */
function writeFileStore(dataHome, credentials) {
    const directory = GLib.build_filenamev([dataHome, 'zappix']);
    GLib.mkdir_with_parents(directory, 0o700);
    GLib.file_set_contents(
        GLib.build_filenamev([directory, 'credentials.json']),
        JSON.stringify(credentials),
    );
}

/** @returns {SecretStore} a store whose keyring call fails and whose file is empty */
function unavailableStore() {
    return new SecretStore({
        dataHome: tempDataHome(),
        secretModule: fakeSecret({ error: new Error('keyring is locked') }),
    });
}

await runTests([
    [
        'lookup returns the keyring value',
        async () => {
            const store = new SecretStore({
                dataHome: tempDataHome(),
                secretModule: fakeSecret({ value: 'token-1' }),
            });
            assertEqual(await store.lookup('zappix:srv1'), 'token-1');
            assertEqual(store.backend, 'keyring');
        },
    ],
    [
        'lookup resolves to an empty string when nothing is stored',
        async () => {
            const store = new SecretStore({
                dataHome: tempDataHome(),
                secretModule: fakeSecret(),
            });
            assertEqual(await store.lookup('zappix:srv1'), '');
            // The keyring answered; the entry simply does not exist.
            assertEqual(store.backend, 'keyring');
        },
    ],
    [
        'lookup falls back to the private file when the keyring answers nothing',
        async () => {
            const dataHome = tempDataHome();
            writeFileStore(dataHome, { 'zappix:srv1': 'from-file' });
            const store = new SecretStore({ dataHome, secretModule: fakeSecret() });
            assertEqual(await store.lookup('zappix:srv1'), 'from-file');
            assertEqual(store.backend, 'file');
        },
    ],
    [
        'lookup still uses the file when the keyring call fails',
        async () => {
            const dataHome = tempDataHome();
            writeFileStore(dataHome, { 'zappix:srv1': 'from-file' });
            const store = new SecretStore({
                dataHome,
                secretModule: fakeSecret({ error: new Error('keyring is locked') }),
            });
            assertEqual(await store.lookup('zappix:srv1'), 'from-file');
            assertEqual(store.backend, 'file');
        },
    ],
    [
        'lookup reports an unavailable keyring instead of an empty credential',
        async () => {
            const store = unavailableStore();
            let caught = null;
            try {
                await store.lookup('zappix:srv1');
            } catch (error) {
                caught = error;
            }
            assert(
                caught instanceof CredentialUnavailableError,
                `expected CredentialUnavailableError, got ${caught}`,
            );
            assertEqual(caught.message, 'The login keyring is locked or not answering yet.');
        },
    ],
    [
        'a missing reference is not treated as an error',
        async () => {
            const store = unavailableStore();
            assertEqual(await store.lookup(''), '');
        },
    ],
]);
