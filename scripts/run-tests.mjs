// run-tests.mjs — Discover and run every tests/*.test.js suite under GJS.
//
// Each suite still runs in its own `gjs -m` process (state isolation between
// suites is intentional), but suites run concurrently and their output is
// buffered, so the default output is a compact per-suite summary instead of
// ~600 PASS lines. A hung suite is killed after --timeout instead of blocking
// CI forever.
//
// Usage:
//   node scripts/run-tests.mjs [--verbose] [--jobs N] [--timeout ms] [--filter text]
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
    const options = {
        verbose: false,
        jobs: Math.max(1, Math.min(8, os.availableParallelism?.() ?? os.cpus().length ?? 4)),
        timeout: DEFAULT_TIMEOUT_MS,
        filter: '',
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--verbose' || arg === '-v') options.verbose = true;
        else if (arg === '--jobs' || arg === '-j') options.jobs = positiveInt(argv[++i], '--jobs');
        else if (arg === '--timeout') options.timeout = positiveInt(argv[++i], '--timeout');
        else if (arg === '--filter') options.filter = argv[++i] ?? '';
        else if (arg === '--help' || arg === '-h') {
            console.log(
                'Usage: node scripts/run-tests.mjs [--verbose] [--jobs N] [--timeout ms] [--filter text]',
            );
            process.exit(0);
        } else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(2);
        }
    }
    return options;
}

function positiveInt(value, flag) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        console.error(`${flag} expects a positive integer, got: ${value}`);
        process.exit(2);
    }
    return parsed;
}

const SUMMARY_RE = /(\d+) passed, (\d+) failed, (\d+) total/g;

function runSuite(file, timeoutMs) {
    return new Promise((resolve) => {
        const startedAt = process.hrtime.bigint();
        const child = spawn('gjs', ['-m', file], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        const append = (chunk) => {
            output += chunk.toString();
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);

        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({
                file,
                ok: false,
                timedOut: false,
                durationMs: 0,
                passed: 0,
                failed: 0,
                total: 0,
                output: `failed to start gjs: ${error.message}`,
            });
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            const summary = [...output.matchAll(SUMMARY_RE)].pop();
            const passed = summary ? Number(summary[1]) : 0;
            const failed = summary ? Number(summary[2]) : 0;
            const total = summary ? Number(summary[3]) : 0;
            resolve({
                file,
                ok: code === 0 && !timedOut && failed === 0,
                timedOut,
                durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
                passed,
                failed,
                total,
                output,
            });
        });
    });
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const testsDir = path.resolve('tests');

    let files;
    try {
        files = readdirSync(testsDir)
            .filter((name) => name.endsWith('.test.js'))
            .filter((name) => name.includes(options.filter))
            .sort()
            .map((name) => path.posix.join('tests', name));
    } catch (error) {
        console.error(`Cannot read ${testsDir}: ${error.message}`);
        process.exit(2);
    }

    if (files.length === 0) {
        console.error(`No test suites found in ${testsDir}`);
        process.exit(2);
    }

    console.log(`=== Unit tests: ${files.length} suite(s), ${options.jobs} parallel ===`);

    const results = new Array(files.length);
    let nextIndex = 0;

    const worker = async () => {
        while (nextIndex < files.length) {
            const index = nextIndex++;
            results[index] = await runSuite(files[index], options.timeout);
            if (!results[index].ok) printFailure(results[index]);
        }
    };

    await Promise.all(Array.from({ length: Math.min(options.jobs, files.length) }, worker));

    if (options.verbose) {
        console.log('\n=== Per-suite results ===');
        for (const result of results) printSuiteLine(result);
    }

    const failedSuites = results.filter((result) => !result.ok);
    const passed = results.reduce((sum, result) => sum + result.passed, 0);
    const failed = results.reduce((sum, result) => sum + result.failed, 0);
    const total = results.reduce((sum, result) => sum + result.total, 0);
    const slowest = [...results].sort((a, b) => b.durationMs - a.durationMs)[0];

    console.log(
        `\n${files.length - failedSuites.length}/${files.length} suites ok — ` +
            `${passed} passed, ${failed} failed, ${total} tests`,
    );
    if (slowest) console.log(`slowest: ${slowest.file} (${slowest.durationMs.toFixed(0)} ms)`);

    if (failedSuites.length > 0) {
        const names = failedSuites.map((result) => result.file).join(', ');
        console.error(`[FAIL] ${failedSuites.length} suite(s) failed: ${names}`);
        process.exit(1);
    }
    console.log('[OK] All tests passed');
}

function printSuiteLine(result) {
    console.log(
        `${result.ok ? 'PASS' : 'FAIL'} ${result.file.padEnd(40)} ` +
            `${String(result.passed).padStart(3)} passed  ${result.durationMs.toFixed(0)} ms`,
    );
}

function printFailure(result) {
    const reason = result.timedOut ? 'timed out' : 'failed';
    console.error(`\n--- FAIL ${result.file} (${reason}) ---`);
    console.error(result.output.trimEnd());
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
