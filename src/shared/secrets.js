// secrets.js — credential storage for Zabbix API tokens.
//
// A Zabbix API token is a long-lived credential that often has read access to
// every host an organisation monitors. It must not live in the GSettings key
// the preferences window edits, because:
//
//   • GSettings is world-readable plain text in dconf;
//   • it is synced by some backup tools;
//   • users routinely paste their settings when filing a bug report.
//
// Two secrets can exist per server: the Zabbix API token (or password) and,
// optionally, a Cloudflare Access client secret for a hostname published behind
// Access. They are separate keyring entries — `zappix:<id>` and
// `zappix-access:<id>` — because they have different lifetimes and rotating one
// must not disturb the other.
//
// Primary backend: the Secret Service (GNOME Keyring), reached through
// libsecret. It is unlocked with the user's login session and encrypts at rest.
//
// Fallback backend: a 0600 file under `~/.local/share/zappix/`. This exists
// because `gir1.2-secret-1` is not guaranteed to be installed on every distro,
// and a monitoring extension that refuses to work on a minimal server-side
// desktop is worse than one that degrades with a clear warning. The trade-off
// is documented in Documentation/Technical/SECURITY.md and surfaced in the
// preferences UI the first time the fallback is used.
//
// Shell-side module (Gio/GLib/libsecret), excluded from the import smoke test.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { debug, warn } from './log.js';

/** Keyring schema label shown by Seahorse and friends. */
const KEYRING_LABEL = 'Zappix Zabbix API token';
/** Attribute used to find entries without the label. */
const KEYRING_ATTRIBUTE = 'zappix-server';

/**
 * How long D-Bus may take to activate `org.freedesktop.secrets`.
 *
 * Without a bound, libsecret blocks on `StartServiceByName` until the bus gives
 * up — observed at 25 seconds, and unbounded on a session where the keyring is
 * wedged, which made saving a server hang forever behind a "Saving…" button.
 */
const SECRET_SERVICE_PROBE_MS = 2000;

/**
 * Hard ceiling on any single keyring call, as a backstop for a prompt that was
 * never answered. Generous enough to unlock a keyring by hand.
 */
const KEYRING_CALL_TIMEOUT_MS = 15000;

/**
 * How long a failed Secret Service probe is trusted.
 *
 * The answer used to be cached for the life of the process, which turned a
 * login-time race — the keyring is routinely not answering for the first
 * seconds of a session — into "no keyring" until the shell restarted, and on a
 * keyring install (empty file fallback) into a permanent "Not configured"
 * card. A negative answer now expires so the next poll can find the service.
 */
const SECRET_SERVICE_RETRY_MS = 30_000;

/** Cached probe result, and when it was taken. */
let secretServiceProbe = { available: null, checkedAt: 0 };

/**
 * Thrown when a credential could not be read *or* ruled out.
 *
 * "The keyring is locked / still starting / not answering" and "no token is
 * stored" must not look the same to the caller: the first deserves a retry and
 * an honest status line, the second is a configuration task. `lookup()`
 * resolves with `''` only for the latter.
 */
export class CredentialUnavailableError extends Error {
    /**
     * @param {string} message
     * @param {unknown} [cause]
     */
    constructor(message, cause) {
        super(message);
        this.name = 'CredentialUnavailableError';
        this.cause = cause;
    }
}

/**
 * Absolute path of the fallback credential file.
 *
 * `dataHome` is nullable on purpose: the store passes its own override field
 * straight through, and an explicit `null` must mean "use the XDG data dir"
 * rather than reaching `GLib.build_filenamev` (which rejects null components).
 *
 * @param {string|null} [dataHome]
 * @returns {string}
 */
export function credentialsPath(dataHome = null) {
    const base = dataHome || GLib.get_user_data_dir();
    return GLib.build_filenamev([base, 'zappix', 'credentials.json']);
}

/**
 * Parse the fallback credential file.
 *
 * Format: `{ "<secretRef>": "<secret>", … }`. A corrupt file yields an empty
 * map so a broken store never takes the extension down with it.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseCredentials(text) {
    if (typeof text !== 'string' || text.trim() === '') return {};
    try {
        const decoded = JSON.parse(text);
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return {};
        const result = {};
        for (const [ref, secret] of Object.entries(decoded)) {
            if (typeof secret === 'string') result[ref] = secret;
        }
        return result;
    } catch {
        return {};
    }
}

/**
 * Credential store with a keyring-first strategy.
 */
export class SecretStore {
    /**
     * @param {object} [options]
     * @param {string} [options.dataHome] override for tests
     * @param {object} [options.secretModule] injected `gi://Secret` stand-in for tests
     */
    constructor({ dataHome, secretModule = null } = {}) {
        this._dataHome = dataHome ?? null;
        this._secretModule = secretModule;
        this._secretPromise = null;
        /** Set when `gi://Secret` itself is missing; retrying the import is pointless. */
        this._moduleMissing = false;
        /** Set once a lookup has proven which backend is in use. */
        this._backend = 'unknown';
    }

    /**
     * Backend currently in use: `keyring`, `file`, or `unknown`.
     *
     * @returns {string}
     */
    get backend() {
        return this._backend;
    }

    /**
     * Lazily import libsecret.
     *
     * A dynamic import keeps the extension loadable on systems without
     * `gir1.2-secret-1`: a static import failure would abort module evaluation
     * and the whole extension with it.
     *
     * @returns {Promise<object|null>}
     */
    async _secret() {
        if (this._secretModule) return this._secretModule;
        if (this._moduleMissing) return null;

        // Cache the promise, not a boolean: the import and the D-Bus probe are
        // asynchronous, and a second caller arriving mid-flight used to see
        // "resolved" with a null module and silently take the file path.
        //
        // The promise is cleared once it settles: a failed probe or import is
        // retried on a later poll (the 30 s negative cache in
        // `hasSecretService()` keeps that cheap) instead of downgrading the
        // whole session to the empty file fallback.
        if (!this._secretPromise) this._secretPromise = this._loadSecret();
        try {
            return await this._secretPromise;
        } finally {
            this._secretPromise = null;
        }
    }

    /**
     * @returns {Promise<object|null>} the Secret namespace, or null
     */
    async _loadSecret() {
        if (!(await hasSecretService())) {
            debug('Secret Service not answering yet; using the private file store');
            return null;
        }

        try {
            const imported = await import('gi://Secret');
            this._secretModule = imported?.default ?? imported ?? null;
        } catch (error) {
            // `gir1.2-secret-1` is not installed: the file store is the only
            // backend this machine will ever have, so stop retrying.
            warn('libsecret unavailable; falling back to a private file store', error?.message);
            this._secretModule = null;
            this._moduleMissing = true;
        }

        return this._secretModule;
    }

    /**
     * Fetch a credential.
     *
     * @param {string} ref secret reference (`zappix:<serverId>`)
     * @returns {Promise<string>} empty string when nothing is stored
     * @throws {CredentialUnavailableError} when the keyring could not be asked
     *   (locked, still starting, timed out) and the file has no copy either —
     *   the caller must retry rather than present the server as unconfigured
     */
    async lookup(ref) {
        if (!ref) return '';

        const secret = await this._secret();
        if (secret?.password_lookup) {
            try {
                const value = await withTimeout(
                    lookupKeyring(secret, ref),
                    KEYRING_CALL_TIMEOUT_MS,
                    'keyring lookup',
                );
                // The keyring answered, so it is the backend in use — even when
                // this particular entry is missing. Only a value that came from
                // the file makes the file the backend.
                this._backend = 'keyring';
                if (value !== null) return value;

                const fromFile = this._readFile()[ref] ?? '';
                if (fromFile) this._backend = 'file';
                return fromFile;
            } catch (error) {
                // The keyring exists but did not answer (locked collection, an
                // unlock prompt that timed out, a wedged daemon). The file may
                // still hold a working credential; when it does not, this is
                // *not* "nothing configured" and the caller must retry.
                warn('keyring lookup failed; trying the file store', error?.message);
                const fromFile = this._readFile()[ref] ?? '';
                if (fromFile) {
                    this._backend = 'file';
                    return fromFile;
                }
                throw new CredentialUnavailableError(
                    'The login keyring is locked or not answering yet.',
                    error,
                );
            }
        }

        this._backend = 'file';
        return this._readFile()[ref] ?? '';
    }

    /**
     * Store or replace a credential.
     *
     * @param {string} ref
     * @param {string} value
     * @returns {Promise<{backend: string, ok: boolean, error: string}>}
     */
    async store(ref, value) {
        if (!ref) return { backend: 'none', ok: false, error: 'Missing credential reference.' };

        const secret = await this._secret();
        if (secret?.password_store) {
            try {
                await withTimeout(
                    storeKeyring(secret, ref, value),
                    KEYRING_CALL_TIMEOUT_MS,
                    'keyring store',
                );
                this._backend = 'keyring';
                // Remove any stale copy so a later downgrade of libsecret
                // cannot resurrect an old token from the fallback file.
                if (this._fileExists()) this._writeFile(deleteKey(this._readFile(), ref));
                return { backend: 'keyring', ok: true, error: '' };
            } catch (error) {
                warn('keyring store failed; falling back to the file store', error?.message);
            }
        }

        const credentials = this._readFile();
        credentials[ref] = value;
        try {
            this._writeFile(credentials);
            this._backend = 'file';
            return { backend: 'file', ok: true, error: '' };
        } catch (error) {
            return {
                backend: 'file',
                ok: false,
                error: `Could not write ${credentialsPath(this._dataHome)}: ${error?.message ?? error}`,
            };
        }
    }

    /**
     * Remove a credential from both backends.
     *
     * @param {string} ref
     * @returns {Promise<void>}
     */
    async remove(ref) {
        if (!ref) return;

        const secret = await this._secret();
        if (secret?.password_clear) {
            try {
                await withTimeout(
                    clearKeyring(secret, ref),
                    KEYRING_CALL_TIMEOUT_MS,
                    'keyring clear',
                );
            } catch (error) {
                debug('keyring clear failed', error?.message);
            }
        }

        if (this._fileExists()) {
            this._writeFile(deleteKey(this._readFile(), ref));
        }
    }

    /** @returns {boolean} */
    _fileExists() {
        try {
            return Gio.File.new_for_path(credentialsPath(this._dataHome)).query_exists(null);
        } catch {
            return false;
        }
    }

    /** @returns {Record<string, string>} */
    _readFile() {
        const path = credentialsPath(this._dataHome);
        try {
            const file = Gio.File.new_for_path(path);
            const [ok, contents] = file.load_contents(null);
            if (!ok) return {};
            return parseCredentials(new TextDecoder().decode(contents));
        } catch {
            return {};
        }
    }

    /**
     * Write the credential file with 0600 permissions.
     *
     * `GLib.file_set_contents` creates the file with the process umask, so the
     * explicit chmod afterwards is what actually enforces owner-only access.
     * The directory is chmod'ed too: a world-readable directory leaks the file
     * name, and some backup tools walk readable directories.
     *
     * @param {Record<string, string>} credentials
     */
    _writeFile(credentials) {
        const path = credentialsPath(this._dataHome);
        const directory = GLib.path_get_dirname(path);

        GLib.mkdir_with_parents(directory, 0o700);
        GLib.chmod(directory, 0o700);

        GLib.file_set_contents(path, JSON.stringify(credentials, null, 2));
        GLib.chmod(path, 0o600);
    }
}

/** @returns {Record<string, string>} */
function deleteKey(record, key) {
    const next = { ...record };
    delete next[key];
    return next;
}

/**
 * Is there a Secret Service this session can actually talk to?
 *
 * `StartServiceByName` is the same activation libsecret performs, so probing it
 * first turns an indefinite block into a two-second answer. A positive answer
 * is cached for the session; a negative one expires after 30 s, because the
 * keyring is often a few seconds behind the shell at login.
 *
 * @returns {Promise<boolean>}
 */
async function hasSecretService() {
    if (secretServiceProbe.available === true) return true;
    if (
        secretServiceProbe.available === false &&
        Date.now() - secretServiceProbe.checkedAt < SECRET_SERVICE_RETRY_MS
    ) {
        return false;
    }

    let available = false;
    try {
        const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        await new Promise((resolve, reject) => {
            bus.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'StartServiceByName',
                new GLib.Variant('(su)', ['org.freedesktop.secrets', 0]),
                null,
                Gio.DBusCallFlags.NONE,
                SECRET_SERVICE_PROBE_MS,
                null,
                (connection, result) => {
                    try {
                        connection.call_finish(result);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                },
            );
        });
        available = true;
    } catch (error) {
        debug('Secret Service probe failed', error?.message);
    }

    secretServiceProbe = { available, checkedAt: Date.now() };
    return available;
}

/**
 * Reject if `promise` has not settled within `ms`.
 *
 * A rejected keyring call is handled by the caller exactly like a failed one:
 * the credential goes to the private file, so the user is never blocked.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (!settled) {
                settled = true;
                reject(new Error(`${label} did not answer within ${Math.round(ms / 1000)}s`));
            }
            return GLib.SOURCE_REMOVE;
        });

        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                GLib.source_remove(sourceId);
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                GLib.source_remove(sourceId);
                reject(error);
            },
        );
    });
}

/**
 * libsecret's async API is callback-based; wrap it once here.
 *
 * @param {object} secret the Secret namespace
 * @param {string} ref
 * @returns {Promise<string|null>} null when no entry exists
 */
function lookupKeyring(secret, ref) {
    return new Promise((resolve, reject) => {
        secret.password_lookup(
            keyringSchema(secret),
            { [KEYRING_ATTRIBUTE]: ref },
            null,
            (_source, result) => {
                try {
                    // `Secret.password_lookup` is a static method, so the
                    // callback's source object is null; the finish function
                    // must be taken from the namespace.
                    resolve(secret.password_lookup_finish(result) ?? null);
                } catch (error) {
                    reject(error);
                }
            },
        );
    });
}

/**
 * @param {object} secret
 * @param {string} ref
 * @param {string} value
 * @returns {Promise<void>}
 */
function storeKeyring(secret, ref, value) {
    return new Promise((resolve, reject) => {
        // Only attributes declared on the schema may be passed: libsecret
        // validates the map and, on a mismatch, emits a GLib warning and never
        // invokes this callback — which is an indefinite hang, not an error.
        // An undeclared `service: 'zabbix'` here did exactly that.
        secret.password_store(
            keyringSchema(secret),
            { [KEYRING_ATTRIBUTE]: ref },
            secret.COLLECTION_DEFAULT,
            `${KEYRING_LABEL} (${ref})`,
            value,
            null,
            (_source, result) => {
                try {
                    secret.password_store_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            },
        );
    });
}

/**
 * @param {object} secret
 * @param {string} ref
 * @returns {Promise<void>}
 */
function clearKeyring(secret, ref) {
    return new Promise((resolve, reject) => {
        secret.password_clear(
            keyringSchema(secret),
            { [KEYRING_ATTRIBUTE]: ref },
            null,
            (_source, result) => {
                try {
                    secret.password_clear_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            },
        );
    });
}

/**
 * Cached Secret.Schema — building it on every call would allocate a new schema
 * and, in libsecret, a schema is identity-bearing for lookups.
 *
 * @param {object} secret the Secret namespace
 * @returns {object}
 */
let cachedSchema = null;
function keyringSchema(secret) {
    if (cachedSchema) return cachedSchema;
    cachedSchema = new secret.Schema(
        'com.certikaytools.zappix.credentials',
        secret.SchemaFlags.NONE,
        { [KEYRING_ATTRIBUTE]: secret.SchemaAttributeType.STRING },
    );
    return cachedSchema;
}
