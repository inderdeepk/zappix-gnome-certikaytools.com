// Balanced-delimiter check for the St-dialect stylesheets.
//
// GNOME Shell's CSS parser is fatal on a stray brace — an extra `}` at EOF once
// blocked the whole extension from loading (errcode 15) — while editors don't
// parse St syntax and won't flag it.  This cheap check runs in `make check`
// and CI to guard both stylesheets.
//
// Run: node scripts/check-css.mjs
import { readFileSync } from 'node:fs';

const FILES = ['stylesheet.css', 'prefs.css'];
const PAIRS = { '}': '{', ')': '(', ']': '[' };

function checkBalanced(path, text) {
    const stack = [];
    let line = 1;
    let col = 0;
    let i = 0;
    const n = text.length;

    while (i < n) {
        const ch = text[i];
        const next = text[i + 1];

        if (ch === '\n') {
            line++;
            col = 0;
            i++;
            continue;
        }
        col++;

        // Block comments — delimiters inside are ignored.
        if (ch === '/' && next === '*') {
            i += 2;
            col++;
            while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
                if (text[i] === '\n') {
                    line++;
                    col = 0;
                } else {
                    col++;
                }
                i++;
            }
            i += 2;
            col++;
            continue;
        }

        // Strings — delimiters inside are ignored; backslash escapes skipped.
        if (ch === '"' || ch === "'") {
            const quote = ch;
            i++;
            col++;
            while (i < n && text[i] !== quote) {
                if (text[i] === '\\') {
                    i += 2;
                    col += 2;
                    continue;
                }
                if (text[i] === '\n') {
                    line++;
                    col = 0;
                } else {
                    col++;
                }
                i++;
            }
            i++;
            col++;
            continue;
        }

        if (ch === '{' || ch === '(' || ch === '[') {
            stack.push({ ch, line, col });
        } else if (ch === '}' || ch === ')' || ch === ']') {
            const top = stack.pop();
            if (!top || top.ch !== PAIRS[ch]) {
                return { ok: false, detail: `${path}:${line}:${col} unmatched '${ch}'` };
            }
        }
        i++;
    }

    if (stack.length > 0) {
        const top = stack[stack.length - 1];
        return { ok: false, detail: `${path}:${top.line}:${top.col} unclosed '${top.ch}'` };
    }
    return { ok: true };
}

let failed = false;
for (const file of FILES) {
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (error) {
        console.error(`[FAIL] ${file}: ${error.message}`);
        failed = true;
        continue;
    }
    const result = checkBalanced(file, text);
    if (!result.ok) {
        console.error(`[FAIL] CSS delimiter balance: ${result.detail}`);
        failed = true;
    }
}

if (failed) process.exit(1);
console.log(`[OK] CSS delimiters balanced (${FILES.join(', ')})`);
