/*
 *  main.js — the Akagi-facing bridge process.
 *
 *  Protocol (see Akagi's mjai_bot/README.md, "The I/O protocol"):
 *
 *    stdin  <- one JSON ARRAY of mjai events per line. Each line is a *batch*:
 *              every event the game produced since the bot was last asked to
 *              react, ending with the event that opened this decision.
 *    stdout -> EXACTLY ONE JSON action per line, in reply to each batch.
 *              `{"type":"none"}` when there is nothing to do.
 *    stderr -> free-form logs, plus `@@AKAGI_NOTIFY@@ {json}` toast lines.
 *
 *  Akagi kills a bot that stops answering, so the cardinal rule here is that
 *  every input line produces exactly one output line, whatever goes wrong
 *  inside. All the failure paths below funnel into `{"type":"none"}`.
 *
 *  Usage: node bridge/main.js [seat]
 *
 *  `seat` comes from Akagi as argv[2] (the mjai.app convention). It is only a
 *  fallback: `start_game.id` is authoritative and overrides it.
 */
'use strict';

const path = require('path');

const Majiang = require('@kobalab/majiang-core');
const AI = require('@kobalab/majiang-ai');

const { MajiangDriver } = require('./to_majiang');
const { DecisionTranslator } = require('./from_majiang');
const show = require('./show');

const NONE = Object.freeze({ type: 'none' });

/** Toast prefix Akagi parses on stderr. The trailing space is required. */
const NOTIFY_PREFIX = '@@AKAGI_NOTIFY@@ ';

function notify(level, title, body, opts = {}) {
    const payload = { level, title };
    if (body) payload.body = body;
    if (opts.sticky) payload.sticky = true;
    if (opts.id) payload.id = opts.id;
    process.stderr.write(NOTIFY_PREFIX + JSON.stringify(payload) + '\n');
}

function log(message) {
    process.stderr.write(`[kobalab] ${message}\n`);
}

/**
 * Rule presets.
 *
 * The library's own defaults are already Tenhou-shaped — `majiang-core`'s
 * `rule()` ships red fives (one of each), kuitan ON and kuikae OFF, which is
 * what Tenhou uses. So the presets only need to state the axes where the two
 * floors actually differ, and the honest answer is: the number of simultaneous
 * winners and whether a called tile may be swapped back out.
 *
 * BOTH floors use head-bump (頭ハネ — only the closest winner takes a ron), so
 * both presets set `最大同時和了数: 1`; the library's default of 2 would allow a
 * double ron, which is neither Tenhou's rule nor Majsoul's.
 *
 * This is deliberately explicit rather than "empty param means Tenhou": the
 * previous version left the tenhou preset as the library default and called the
 * two axes it re-set "the differences", which is how the double-ron default went
 * unnoticed.
 */
function ruleFor(preset) {
    const param = {
        '最大同時和了数': 1,
    };
    if (preset === 'majsoul') {
        // Majsoul allows kuikae (swapping the called tile straight back out).
        param['喰い替え許可レベル'] = 2;
    }
    return Majiang.rule(param);
}

class Bridge {
    /**
     * @param {object} [opts]
     * @param {number} [opts.seat]      fallback seat (from argv)
     * @param {string} [opts.rulePreset]
     * @param {Function} [opts.emit]    sink for output lines, defaults to stdout
     */
    constructor(opts = {}) {
        this.fallbackSeat = Number.isInteger(opts.seat) ? opts.seat : 0;
        this.seat = this.fallbackSeat;
        this.rulePreset = opts.rulePreset || 'tenhou';
        // From manifest.toml `show_candidates` via AKAGI_BOT_CONFIG.
        this.showCandidates = opts.showCandidates !== false;
        this.emit = opts.emit || ((line) => process.stdout.write(line + '\n'));

        this.driver = null;
        this.translator = null;
        this.sawStartGame = false;
        this.ended = false;

        // Diagnostics, surfaced in stderr logs and in `meta`.
        this.batches = 0;
        this.decisions = 0;
        this.refusals = 0;
    }

    // -----------------------------------------------------------------------
    // Batch handling
    // -----------------------------------------------------------------------

    /**
     * Process one batch and return the single reaction line to write.
     *
     * @param {object[]} events
     * @returns {object} the mjai action (with an optional `meta`)
     */
    handleBatch(events) {
        this.batches++;

        if (!Array.isArray(events)) {
            // `JSON.stringify(undefined)` is `undefined`, not a string, so the
            // value needs coercing before it can be sliced for the log line.
            log(`ignoring non-array batch: ${String(JSON.stringify(events)).slice(0, 120)}`);
            return NONE;
        }

        const startGame = events.find((e) => e && e.type === 'start_game');
        if (startGame) {
            if (!this._begin(startGame)) return NONE;
        }

        if (!this.driver) {
            // Events before `start_game` are meaningless; answer politely.
            log('batch before start_game; replying none');
            return NONE;
        }

        // Feed every event, tracking the ones that opened a decision. Akagi
        // already asks only at decision points for our seat, but a batch can
        // contain a boundary event after the triggering one, and round/game
        // boundaries flush too.
        //
        // `driver.asked` is per-EVENT (reset in `feed`), so a later event cannot
        // inherit an earlier decision: the trigger recorded here is the event the
        // reply actually belongs to, and a batch whose last event opens nothing
        // still reports the earlier decision instead of dropping it.
        let last = null;
        for (const ev of events) {
            if (!ev || typeof ev.type !== 'string') continue;
            // `_begin` has already fed the same `start_game`; feeding it again
            // would set the model up twice.
            if (startGame && ev === startGame) continue;
            const reply = this.driver.feed(ev);
            // `feed` returns null both for "no decision" and for "the AI passed
            // explicitly" (majiang signals a pass with `{}`). Only `driver.asked`
            // separates them, and getting it wrong means staying silent on a
            // pass, which desyncs Akagi's one-reply-per-batch protocol.
            if (this.driver.asked) {
                last = { reply: reply || {}, trigger: ev };
            }
            if (ev.type === 'end_game') this.ended = true;
        }

        if (last === null) return NONE;

        this.decisions++;
        return this._react(last.reply, last.trigger);
    }

    _begin(startGame) {
        const numPlayers = startGame.num_players || 4;
        const seat = Number.isInteger(startGame.id) ? startGame.id : this.fallbackSeat;

        try {
            this.seat = seat;
            this.driver = new MajiangDriver({
                Majiang,
                AI,
                seat,
                numPlayers,
                rule: ruleFor(this.rulePreset),
                onNote: (m) => log(m),
            });
            this.translator = new DecisionTranslator({
                seat,
                onNote: (m) => { this.refusals++; log(m); },
            });
            // Hand the driver its own `start_game` — that is what sets the seat,
            // the base dealer and the rule on the player, and without it every
            // `start_kyoku` is rejected (the AI builds its tile counters from the
            // rule it never received). The batch loop below skips this exact
            // event so the setup cannot happen twice.
            this.driver.feed(startGame);
            this.sawStartGame = true;
            log(`started: seat=${seat} players=${numPlayers} rule=${this.rulePreset}`);
            return true;
        } catch (e) {
            // The usual cause is sanma, which this bot refuses by design.
            log(`cannot serve this game: ${e.message}`);
            notify('error', 'kobalab bot cannot serve this game', e.message,
                { sticky: true, id: 'kobalab-unsupported' });
            this.driver = null;
            this.translator = null;
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // Reaction
    // -----------------------------------------------------------------------

    _react(reply, trigger) {
        let actions;
        try {
            // The translator needs our melds to tell an added kan from a closed
            // one, and there is no reply field that distinguishes them.
            this.translator.hand = this.driver.player.shoupai;
            // The legal set is ours, not Akagi's: the mjai stream carries no
            // legal set, so the driver derives one from the model with the same
            // library predicates the AI decided with. Without it the "gate" was
            // decorative and any illegal proposal went straight to the engine.
            actions = this.translator.translate(reply, {
                trigger,
                legal: this.driver.lastLegal,
            });
        } catch (e) {
            log(`decision translation failed: ${e.message}`);
            return NONE;
        }

        if (!Array.isArray(actions) || !actions.length) return NONE;

        // Exactly one action goes on the wire. A riichi used to be two (`reach`
        // plus the discard pushed into `meta.extra_actions`) but Akagi has no
        // notion of `extra_actions` — it reads one action per batch and keeps the
        // declaring discard on `Reach.pai` — so the translator now folds them
        // into the `reach` itself.
        const primary = actions[0];
        if (actions.length > 1) {
            log(`dropping ${actions.length - 1} extra action(s) after ${primary.type}`);
        }

        const card = this._card(reply, primary);
        // `show.attach` only decorates the primary action, which for a declined
        // call is `{"type":"none"}` — still a legitimate reaction to send, and
        // Akagi reads `meta` off it without interpreting the action itself.
        const out = show.attach(primary, card);

        if (out.type === 'none') {
            log(`no action for ${trigger.type} (reply ${JSON.stringify(reply)})`);
        }
        return out;
    }

    _card(reply, primary) {
        if (!this.showCandidates) return null;
        try {
            // A declined call is the one case where a `none` reply still has
            // something worth showing: the AI weighed a real choice and passed.
            // It is checked before the candidate-list path below.
            if (primary.type === 'none') {
                return this.driver.lastCallCard
                    ? show.declineCard(this.driver.lastCallCard)
                    : null;
            }

            const info = this.driver.lastCandidates;
            if (!info || !info.length) return null;

            if (reply && reply.fulou !== undefined) {
                return show.callCard(info, { chosen: reply.fulou });
            }
            if (reply && typeof reply.dapai === 'string') {
                return show.discardCard(info, {
                    chosen: reply.dapai,
                    riichi: reply.dapai.includes('*'),
                });
            }
            // A declined call. The AI looked at this window and chose to pass,
            // and the candidate list it kept is empty of the calls it rejected —
            // so explain the decision from the driver's own comparison instead of
            // leaving the overlay silent (which reads as "not looking").
            if (this.driver.lastCallCard) {
                return show.declineCard(this.driver.lastCallCard);
            }
            return null;
        } catch (e) {
            log(`HUD card failed: ${e.message}`);
            return null;
        }
    }
}

// ---------------------------------------------------------------------------
// Process entry point
// ---------------------------------------------------------------------------

function main() {
    const seatArg = process.argv[2];
    const seat = seatArg === undefined ? 0 : Number.parseInt(seatArg, 10);
    if (seatArg !== undefined && Number.isNaN(seat)) {
        log(`ignoring non-numeric seat argument ${JSON.stringify(seatArg)}`);
    }

    const bridge = new Bridge({
        seat: Number.isNaN(seat) ? 0 : seat,
        rulePreset: process.env.KOBALAB_RULE || 'tenhou',
    });

    // Read config the way Akagi's manifest protocol expects, if present.
    const cfgPath = process.env.AKAGI_BOT_CONFIG;
    if (cfgPath) {
        try {
            const cfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'));
            if (cfg.rule_preset) bridge.rulePreset = String(cfg.rule_preset);
            if (cfg.show_candidates !== undefined) {
                bridge.showCandidates = cfg.show_candidates !== false;
            }
            log(`loaded settings from ${path.basename(cfgPath)}: ${JSON.stringify(cfg)}`);
        } catch (e) {
            log(`could not read AKAGI_BOT_CONFIG: ${e.message}`);
        }
    }

    notify('info', 'kobalab bot ready', `seat ${bridge.fallbackSeat}`, { id: 'kobalab-ready' });

    let buffer = '';
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) handleLine(bridge, line);
            nl = buffer.indexOf('\n');
        }
    });

    process.stdin.on('end', () => {
        const line = buffer.trim();
        if (line) handleLine(bridge, line);
        log(`stdin closed after ${bridge.batches} batches; exiting`);
        process.exit(0);
    });
}

function handleLine(bridge, line) {
    let reaction;
    try {
        reaction = bridge.handleBatch(JSON.parse(line));
    } catch (e) {
        // Never let a bad batch desync the protocol: one line in, one line out.
        log(`batch failed entirely: ${e.message}`);
        reaction = NONE;
    }
    try {
        bridge.emit(JSON.stringify(reaction));
    } catch (e) {
        log(`could not write reaction: ${e.message}`);
    }

    // Akagi's bot contract is to exit cleanly on `end_game` (its `reset()`
    // writes `[{"end_game"}]`, waits ~500 ms and SIGKILLs whatever is left). The
    // reply above is flushed before exiting: stdout is a pipe, so a bare
    // `process.exit()` here could truncate it.
    if (bridge.ended) {
        log(`end_game seen after ${bridge.batches} batches; exiting`);
        process.stdout.write('', () => process.exit(0));
    }
}

module.exports = { Bridge, ruleFor, notify, NOTIFY_PREFIX };

if (require.main === module) main();
