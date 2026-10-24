// check-api.mjs — reject GNOME Shell APIs that no longer exist.
//
// Tests cannot catch this class of failure: the shell-side widgets are excluded
// from the unit suites and from the plain-gjs import smoke test, so a call to a
// method that was removed in GNOME 45/46 compiles, imports and passes every
// check — then throws at runtime the first time a card actually renders. Two
// such calls (`this.repaint()` in the sparkline and the meter) made every poll
// fail with "this.repaint is not a function" while all gates were green.
//
// Static text matching is crude, but the alternative is no coverage at all, and
// these names have no legitimate use in this codebase.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

/** `[pattern, replacement, why]` */
const BANNED = [
    [
        /\.repaint\s*\(/,
        'queue_repaint()',
        'St stopped exposing repaint() before GNOME 45; use queue_repaint()',
    ],
    [
        /\bClutter\.Color\b/,
        'Clutter.Color was removed in GNOME 46; use a Cogl/Clutter colour literal or CSS',
        'Clutter.Color is gone in 46',
    ],
    [
        /\.get_actor\s*\(/,
        'the Shell removed container actors in GNOME 45; use the widget directly',
        'get_actor() was removed in 45',
    ],
    [
        /\bSt\.ThemeContext\b(?!\.get_for_stage\b)/,
        'St.ThemeContext was replaced by St.ThemeContext.get_for_stage()',
        'St.ThemeContext as a constructor is gone',
    ],
];

/** Files that must be scanned: everything the shell loads. */
const ROOTS = ['src', 'extension.js', 'prefs.js'];

/**
 * @param {string} path
 * @returns {string[]}
 */
function readLines(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok) return [];
    return new TextDecoder().decode(bytes).split('\n');
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listJsFiles(dir) {
    const files = [];
    let enumerator;
    try {
        enumerator = Gio.File.new_for_path(dir).enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null,
        );
    } catch {
        return files;
    }

    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        const path = `${dir}/${name}`;
        if (info.get_file_type() === Gio.FileType.DIRECTORY) files.push(...listJsFiles(path));
        else if (name.endsWith('.js')) files.push(path);
    }
    return files;
}

const cwd = GLib.get_current_dir();
const files = [];
for (const root of ROOTS) {
    if (GLib.file_test(`${cwd}/${root}`, GLib.FileTest.IS_DIR))
        files.push(...listJsFiles(`${cwd}/${root}`));
    else if (GLib.file_test(`${cwd}/${root}`, GLib.FileTest.EXISTS)) files.push(`${cwd}/${root}`);
}

const problems = [];

for (const path of files) {
    const relative = path.slice(cwd.length + 1);
    const lines = readLines(path);

    lines.forEach((text, index) => {
        const code = text.replace(/\/\/.*$/, '');
        if (!code.trim() || code.trimStart().startsWith('*')) return;

        for (const [pattern, hint, why] of BANNED) {
            if (!pattern.test(code)) continue;
            problems.push(`${relative}:${index + 1}  ${why}\n    ${text.trim()}\n    → ${hint}`);
        }
    });
}

if (problems.length > 0) {
    printerr(`[FAIL] ${problems.length} call(s) to removed GNOME Shell API:`);
    for (const problem of problems) printerr(`  ${problem}`);
    System.exit(1);
}

print(`[OK] No removed shell APIs (${files.length} files scanned)`);
