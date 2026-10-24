// check-syntax.mjs — Parse every JS/MJS file in the repo as an ES module.
//
// Replaces the previous `node --input-type=module --check < file` loop, which
// started ~110 Node processes (~10 s). Parsing with espree in a single process
// is ~25x faster and catches the same syntax errors; when espree is not
// installed (no `npm ci`) it falls back to the per-file `node --check` spawn.
//
// Usage: node scripts/check-syntax.mjs
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT_FILES = ['extension.js', 'prefs.js'];
const SCAN_DIRS = ['src', 'tests', 'scripts'];
const EXTENSIONS = new Set(['.js', '.mjs']);
const ECMA_VERSION = 2023;

function listFiles(dir) {
    const files = [];
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return files;
    }
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...listFiles(full));
        else if (EXTENSIONS.has(path.extname(entry.name))) files.push(full);
    }
    return files;
}

const files = [...ROOT_FILES, ...SCAN_DIRS.flatMap((dir) => listFiles(dir))];

async function loadEspree() {
    try {
        return await import('espree');
    } catch {
        return null;
    }
}

function checkWithNode(filesToCheck) {
    let failures = 0;
    for (const file of filesToCheck) {
        const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
            input: readFileSyncSafe(file),
        });
        if (result.status !== 0) {
            failures++;
            process.stderr.write(`[FAIL] ${file}\n`);
            process.stderr.write(result.stderr?.toString() ?? '');
        }
    }
    return failures;
}

function readFileSyncSafe(file) {
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

async function main() {
    const espree = await loadEspree();
    if (!espree) {
        const failures = checkWithNode(files);
        if (failures > 0) {
            console.error(`[FAIL] ${failures} file(s) failed to parse`);
            process.exit(1);
        }
        console.log(`[OK] ${files.length} files parse as ES modules (node --check fallback)`);
        return;
    }

    let failures = 0;
    for (const file of files) {
        let code;
        try {
            code = readFileSync(file, 'utf8');
        } catch (error) {
            failures++;
            console.error(`[FAIL] ${file}: ${error.message}`);
            continue;
        }
        try {
            espree.parse(code, {
                ecmaVersion: ECMA_VERSION,
                sourceType: 'module',
                loc: true,
            });
        } catch (error) {
            failures++;
            console.error(`[FAIL] ${file}:${error.lineNumber}: ${error.message}`);
        }
    }

    if (failures > 0) {
        console.error(`[FAIL] ${failures} file(s) failed to parse`);
        process.exit(1);
    }
    console.log(`[OK] ${files.length} files parse as ES modules`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
