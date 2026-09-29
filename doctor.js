/*
 *  doctor.js — check the settings chain end to end, in the bot's own directory.
 *
 *  Run it from inside the installed bot folder, next to bot.py:
 *
 *      node doctor.js            (or: cd <bot dir> && node doctor.js)
 *
 *  When a setting in Akagi's Bots panel "will not stick", the cause is somewhere
 *  along a four-step chain and the UI reports the same symptom for all of them:
 *
 *      1. manifest.toml      declares the field        (Akagi renders the form)
 *      2. settings.toml      stores the user's choice  (Akagi writes it)
 *      3. .akagi/resolved_settings.json  Akagi passes it as AKAGI_BOT_CONFIG
 *      4. bridge/main.js     reads that JSON and uses it
 *
 *  This walks all four and reports the first place they disagree, printing the
 *  raw values rather than a summary, because the interesting failures are things
 *  like "the file says majsoul but the process was handed tenhou".
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const MANIFEST = path.join(HERE, 'manifest.toml');
const SETTINGS = path.join(HERE, 'settings.toml');
const RESOLVED = path.join(HERE, '.akagi', 'resolved_settings.json');

const results = [];
function check(ok, label, detail) {
    results.push({ ok, label, detail });
    const mark = ok === null ? '??' : ok ? 'OK' : 'FAIL';
    console.log(`[${mark}] ${label}`);
    if (detail) {
        for (const line of String(detail).split('\n')) console.log(`       ${line}`);
    }
}

function readFileOrNull(p) {
    try {
        return fs.readFileSync(p, 'utf8');
    } catch (e) {
        return null;
    }
}

/**
 * Extract `key = value` pairs from a TOML section, tolerating comments and blank
 * lines. Deliberately not a full TOML parser: this only needs to show what the
 * file literally says.
 */
function tomlSection(text, section) {
    const out = {};
    if (!text) return out;
    let current = null;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const header = line.match(/^\[([^\]]+)\]$/);
        if (header) {
            current = header[1];
            continue;
        }
        if (current !== section) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        const hash = value.search(/\s#/);
        if (hash !== -1) value = value.slice(0, hash).trim();
        out[key] = value.replace(/^"(.*)"$/, '$1');
    }
    return out;
}

/** Every `[settings.X]` sub-table declared in the manifest. */
function declaredSettings(manifestText) {
    const found = [];
    if (!manifestText) return found;
    for (const raw of manifestText.split('\n')) {
        const m = raw.trim().match(/^\[settings\.([A-Za-z0-9_]+)\]$/);
        if (m) found.push(m[1]);
    }
    return found;
}

console.log('kobalab settings doctor');
console.log(`bot directory: ${HERE}\n`);

// --- 1. manifest -----------------------------------------------------------
const manifestText = readFileOrNull(MANIFEST);
if (!manifestText) {
    check(false, 'manifest.toml present', `not found at ${MANIFEST}`);
} else {
    const declared = declaredSettings(manifestText);
    check(declared.length > 0, 'manifest.toml declares [settings.*] fields',
        declared.length ? declared.join(', ') : 'none found — Akagi renders no settings form');
    const bot = tomlSection(manifestText, 'bot');
    check(true, 'manifest [bot] block',
        `name=${JSON.stringify(bot.name)} supported_modes=${bot.supported_modes}`);
    // Akagi identifies a bot by its DIRECTORY NAME: it scans the direct
    // subdirectories of `bot.dir`, and the folder that contains bot.py is the bot.
    // A mismatch here is not cosmetic — `settings.toml` and the UI row key off
    // that name, so a wrong folder name is how "my setting will not save" can
    // actually present.
    const folder = path.basename(HERE);
    if (bot.name && bot.name !== folder) {
        check(false, 'the folder name matches the manifest name',
            `manifest says name=${JSON.stringify(bot.name)} but this folder is `
            + `${JSON.stringify(folder)}\n`
            + `Akagi registers this bot as "${folder}", so its settings are stored and `
            + `looked up under that name.\n`
            + `Fix: rename this folder to ${JSON.stringify(bot.name)} — i.e. install it at `
            + `<akagi>\\mjai_bot\\${bot.name}\\ so that ${bot.name}\\bot.py exists.\n`
            + `The shipped archive unpacks to a folder of that name for exactly this reason.`);
    } else if (bot.name) {
        check(true, 'the folder name matches the manifest name', folder);
    }
    for (const key of declared) {
        const spec = tomlSection(manifestText, `settings.${key}`);
        const missing = ['type', 'label', 'default'].filter((f) => spec[f] === undefined);
        if (missing.length) {
            check(false, `settings.${key} is complete`, `missing: ${missing.join(', ')}`);
        } else if (spec.type === 'enum' && spec.choices === undefined) {
            check(false, `settings.${key} is a valid enum`, 'enum without `choices` makes Akagi reject every load');
        }
    }
}

// --- 2. settings.toml (what the user actually chose) -----------------------
const settingsText = readFileOrNull(SETTINGS);
if (settingsText === null) {
    check(null, 'settings.toml exists',
        'not written yet — Akagi creates it when you press Save in the Bots panel.\n'
        + 'Until then every field reads as its manifest default.');
} else {
    check(true, 'settings.toml exists', SETTINGS);
    // Akagi writes these as TOP-LEVEL keys, not nested tables.
    const nested = /^\s*\[settings/.test(settingsText);
    check(!nested, 'settings.toml uses flat top-level keys',
        nested ? 'found a [settings] table — Akagi expects `key = value` at the top level'
            : settingsText.trim().split('\n').map((l) => l.trim()).filter(Boolean).join('\n'));
}

// --- 3. what Akagi resolves and hands over ---------------------------------
const resolvedText = readFileOrNull(RESOLVED);
if (resolvedText === null) {
    check(null, 'resolved_settings.json exists',
        `not written yet at ${RESOLVED}\n`
        + 'Akagi writes it when it spawns the bot (i.e. at game start).');
} else {
    let resolved = null;
    try {
        resolved = JSON.parse(resolvedText);
        check(true, 'resolved_settings.json parses', JSON.stringify(resolved));
    } catch (e) {
        check(false, 'resolved_settings.json parses', e.message);
    }
    if (resolved) {
        const declared = declaredSettings(manifestText);
        for (const key of declared) {
            if (!(key in resolved)) {
                check(false, `resolved_settings contains ${key}`,
                    'Akagi merges manifest defaults, so it should always be present');
            }
        }
        // The settings.toml value must win over the manifest default.
        const fromDisk = tomlSection(settingsText, '') && settingsText
            ? Object.fromEntries(settingsText.split('\n')
                .map((l) => l.trim())
                .filter((l) => l && !l.startsWith('#') && !l.startsWith('[') && l.includes('='))
                .map((l) => {
                    const i = l.indexOf('=');
                    let v = l.slice(i + 1).trim();
                    const h = v.search(/\s#/);
                    if (h !== -1) v = v.slice(0, h).trim();
                    return [l.slice(0, i).trim(), v.replace(/^"(.*)"$/, '$1')];
                }))
            : {};
        for (const [key, diskValue] of Object.entries(fromDisk)) {
            if (!(key in resolved)) continue;
            const resolvedValue = String(resolved[key]);
            if (diskValue !== resolvedValue) {
                check(false, `${key}: settings.toml and resolved_settings.json agree`,
                    `settings.toml says ${JSON.stringify(diskValue)}, `
                    + `resolved says ${JSON.stringify(resolvedValue)}\n`
                    + 'If the bot is running, this just means it was spawned before your last Save — '
                    + 'settings take effect at the NEXT game.');
            }
        }
    }
}

// --- 4. what this process was handed ---------------------------------------
const cfgPath = process.env.AKAGI_BOT_CONFIG;
if (!cfgPath) {
    check(null, 'AKAGI_BOT_CONFIG is set in this environment',
        'It is only set when Akagi spawns the bot. Running this by hand from a '
        + 'terminal will not have it — that is expected and not a fault.');
} else {
    check(true, 'AKAGI_BOT_CONFIG is set', cfgPath);
    let cfg = null;
    try {
        cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        check(true, 'the file it points at parses', JSON.stringify(cfg));
    } catch (e) {
        check(false, 'the file it points at parses', `${cfgPath}: ${e.message}`);
    }
}

// --- summary ---------------------------------------------------------------
const failed = results.filter((r) => r.ok === false);
const unknown = results.filter((r) => r.ok === null);

console.log('\n' + '-'.repeat(64));
if (failed.length) {
    console.log(`${failed.length} problem(s) found. The first one is the place to look:`);
    console.log(`  -> ${failed[0].label}`);
} else if (unknown.length) {
    console.log('No problems found in what could be checked here.');
    console.log(`${unknown.length} item(s) could not be checked from this context (marked ??).`);
} else {
    console.log('All checks passed.');
}

// Node version matters for the bridge itself.
console.log(`\nnode ${process.version} (bridge needs >= 18)`);
console.log(`platform ${os.platform()} ${os.release()}`);

process.exit(failed.length ? 1 : 0);
