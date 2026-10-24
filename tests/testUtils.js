// testUtils.js — shared assertions and a tiny runner for the Zappix unit tests.
//
// The suites run under plain `gjs` (not `node`), because several modules touch
// GLib without needing the shell. That rules out `node:test`, so this file
// provides the four assertions the suites actually use plus a runner that
// understands async tests and reports a machine-readable summary line that
// scripts/run-tests.mjs parses.
//
// Deliberate choice: no mocking framework. Everything under src/model and
// src/api/RPC is a pure function of its arguments, so plain objects are enough
// and the tests double as executable documentation of the wire format.

/**
 * Assert a truthy condition.
 *
 * @param {unknown} condition
 * @param {string} [message]
 */
export function assert(condition, message = 'assertion failed') {
    if (!condition) throw new Error(message);
}

/**
 * Assert strict equality.
 *
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} [message]
 */
export function assertEqual(actual, expected, message = 'assertEqual') {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${stringify(expected)}, got ${stringify(actual)}`);
    }
}

/**
 * Assert structural equality, including nested objects and arrays.
 *
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} [message]
 */
export function assertDeepEqual(actual, expected, message = 'assertDeepEqual') {
    const difference = firstDifference(actual, expected, 'value');
    if (difference) {
        throw new Error(
            `${message}: ${difference}\n  expected: ${stringify(expected)}\n  actual:   ${stringify(actual)}`,
        );
    }
}

/**
 * Assert that a function throws, optionally matching part of the message.
 *
 * @param {() => unknown} fn
 * @param {string} [expectedSubstring]
 * @param {string} [message]
 */
export function assertThrows(fn, expectedSubstring = '', message = 'assertThrows') {
    let threw = false;
    try {
        fn();
    } catch (error) {
        threw = true;
        const text = String(error?.message ?? error);
        if (expectedSubstring && !text.includes(expectedSubstring)) {
            throw new Error(
                `${message}: exception did not contain "${expectedSubstring}". Got: ${text}`,
            );
        }
    }
    if (!threw) throw new Error(`${message}: expected an exception but none was thrown`);
}

/**
 * Assert that a numeric value is within a tolerance.
 *
 * @param {number} actual
 * @param {number} expected
 * @param {number} [tolerance=1e-9]
 * @param {string} [message]
 */
export function assertClose(actual, expected, tolerance = 1e-9, message = 'assertClose') {
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
        throw new Error(`${message}: expected ${expected} ±${tolerance}, got ${actual}`);
    }
}

/**
 * Structural comparison that reports the first differing path.
 *
 * Chosen over JSON.stringify because stringify is key-order sensitive, drops
 * `undefined` properties, and turns NaN/Infinity into null.
 *
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} path
 * @returns {string} '' when equal
 */
function firstDifference(actual, expected, path) {
    if (Object.is(actual, expected)) return '';

    if (typeof actual !== typeof expected) {
        return `${path}: type mismatch (${typeof actual} vs ${typeof expected})`;
    }

    if (actual === null || expected === null || typeof actual !== 'object') {
        return `${path}: expected ${stringify(expected)}, got ${stringify(actual)}`;
    }

    if (Array.isArray(actual) !== Array.isArray(expected)) {
        return `${path}: array/object mismatch`;
    }

    if (Array.isArray(actual)) {
        if (actual.length !== expected.length) {
            return `${path}: array length ${actual.length} vs ${expected.length}`;
        }
        for (let index = 0; index < actual.length; index++) {
            const difference = firstDifference(actual[index], expected[index], `${path}[${index}]`);
            if (difference) return difference;
        }
        return '';
    }

    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (actualKeys.join('\u0000') !== expectedKeys.join('\u0000')) {
        return `${path}: keys [${actualKeys.join(', ')}] vs [${expectedKeys.join(', ')}]`;
    }
    for (const key of actualKeys) {
        const difference = firstDifference(actual[key], expected[key], `${path}.${key}`);
        if (difference) return difference;
    }
    return '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringify(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/**
 * Run named test cases and report a summary line for scripts/run-tests.mjs.
 *
 * @param {Array<[string, () => unknown]>} tests
 */
export async function runTests(tests) {
    let passed = 0;
    let failed = 0;

    for (const [name, run] of tests) {
        try {
            const result = run();
            // Await async cases so their assertions are actually observed.
            if (result && typeof result.then === 'function') await result;
            console.log(`PASS ${name}`);
            passed++;
        } catch (error) {
            console.log(`FAIL ${name}: ${error?.message ?? error}`);
            failed++;
        }
    }

    console.log(`${passed} passed, ${failed} failed, ${tests.length} total`);

    if (failed > 0) throw new Error(`${failed} test(s) failed`);
}
