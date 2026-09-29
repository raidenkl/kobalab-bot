/*
 *  harness.js — whole-game verification for the kobalab bridge.
 *
 *  The unit suites in ../test pin down each translating layer on its
 *  own. This one answers the harder question: when real 4-player games are played
 *  out by `Majiang.Game`, does the bridge's model stay identical to the engine's?
 *
 *  HOW IT WORKS
 *
 *  `Majiang.Game` drives four `Player`s with majiang-core messages and reads
 *  their replies. For a given seat we install `BridgeReferee` as the engine's
 *  player for that seat, and intercept the messages it receives. Each intercepted
 *  message is converted into mjai (opponents' hands and draws censored to "?"),
 *  fed to the bridge, and the bridge's reply is handed back to the engine.
 *
 *  That makes the bridge the thing actually playing the seat — and the engine's
 *  own board is an INDEPENDENT witness for what that seat's hand should be, since
 *  the engine maintains all four hands itself. After every message the two are
 *  compared: the concealed tiles and the melds must match exactly, and the live
 *  wall count the bridge reconstructs must match the engine's.
 *
 *  Two things about that comparison are worth stating, because getting either
 *  wrong is how a harness turns into a green light that means nothing:
 *
 *   - The reference must come from the ENGINE, not from the bridge. Comparing
 *     `driver.player` against itself is vacuously true, and it hides exactly the
 *     class of bug this file exists to find.
 *   - The engine applies a message to its board BEFORE notifying the players, and
 *     it applies OUR action only after we return it. So at the point where we can
 *     compare, the engine is one step ahead of the bridge in one specific way: a
 *     discard the bridge already applied at the decision is still in the engine's
 *     hand. That single tile is added back before comparing.
 *
 *  Games are SEEDED: the wall is a deterministic shuffle (`--seed`) handed to the
 *  engine, so a failure can be replayed exactly. Multi-hand games are the default
 *  (`--rounds south`) because the seat rotation changes with the hand counter, and
 *  the first hand of a game exercises none of it.
 *
 *  Usage:
 *      node probe/harness.js                       # 1 game per seat, southern
 *      node probe/harness.js --games 4 --seed 7
 *      node probe/harness.js --seat 2 --rounds 1 --verbose
 *      node probe/harness.js --rounds east         # 東風戦
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Where the bot under test lives.
 *
 * This file ships in two layouts and has to work in both:
 *
 *   repo            <repo>/probe/harness.js        bot at the repo root
 *   installed bot   mjai_bot/kobalab/probe/harness.js   bot at ..
 *
 * The test is whether our parent already holds the bridge. Anything else would
 * have to guess, and a wrong guess here loads a stale copy of the bridge — which
 * is the one failure that would make the whole sweep lie.
 */
const BOT_DIR = fs.existsSync(path.join(__dirname, '..', 'bridge', 'to_majiang.js'))
    ? path.join(__dirname, '..')
    : path.join(__dirname, '..', 'kobalab-bot');
const Majiang = require(path.join(BOT_DIR, 'node_modules', '@kobalab', 'majiang-core'));
const AI = require(path.join(BOT_DIR, 'node_modules', '@kobalab', 'majiang-ai'));

const T = require(path.join(BOT_DIR, 'bridge', 'tiles'));
const { MajiangDriver } = require(path.join(BOT_DIR, 'bridge', 'to_majiang'));
const { DecisionTranslator } = require(path.join(BOT_DIR, 'bridge', 'from_majiang'));

/** `--rounds` → the library's 場数 setting (0 one hand, 1 east, 2 south, 4 full). */
const ROUNDS = { '1': 0, east: 1, south: 2, full: 4 };

// ---------------------------------------------------------------------------
// Deterministic wall
// ---------------------------------------------------------------------------

/** A tiny reproducible PRNG (mulberry32), so a failure can be replayed exactly. */
function rng(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A full 136-tile wall in a seeded order, in majiang notation. */
function makeWall(seed, rule) {
    const hongpai = rule['赤牌'];
    const tiles = [];
    for (const suit of ['m', 'p', 's', 'z']) {
        const max = suit === 'z' ? 7 : 9;
        for (let n = 1; n <= max; n++) {
            for (let i = 0; i < 4; i++) {
                // Red fives are drawn as digit 0 and count against the five.
                if (n === 5 && i < hongpai[suit]) tiles.push(suit + '0');
                else tiles.push(suit + n);
            }
        }
    }
    const rand = rng(seed);
    for (let i = tiles.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = tiles[i];
        tiles[i] = tiles[j];
        tiles[j] = tmp;
    }
    return tiles;
}

/**
 * A `Majiang.Shan` that deals a fixed wall.
 *
 * `Majiang.Shan` shuffles inside its constructor and offers no way to pass an
 * order in, so one is built and then overwritten: `_pai` is the wall in draw
 * order (`zimo` pops the end, `gangzimo` shifts the front, `paishu` is
 * `_pai.length - 14`), and the indicators are read out of the same array.
 */
function makeShan(rule, wall) {
    const shan = new Majiang.Shan(rule);
    shan._pai = wall.slice();
    shan._baopai = [shan._pai[4]];
    shan._fubaopai = rule['裏ドラあり'] ? [shan._pai[9]] : null;
    return shan;
}

// ---------------------------------------------------------------------------
// mjai encoding of an engine message
// ---------------------------------------------------------------------------

/**
 * Convert a majiang-core message into the mjai batch Akagi would deliver, from
 * `seat`'s point of view — which means censoring everything the seat cannot see.
 *
 * SEAT SPACES. This is the crux of the whole exercise. majiang-core's messages
 * are expressed in *menfeng* (relative) seats — `qipai.shoupai[l]` is the player
 * at relative position `l`, and every event carries a relative `l`. Akagi's mjai
 * stream is in *absolute* seats. So every index has to cross the same boundary
 * the bridge crosses in the other direction:
 *
 *     absolute = (menfeng + qijia + jushu) % 4
 *
 * where `qijia` is the game's base dealer (from `msg.kaiju.qijia`) and `jushu`
 * the hand counter.
 *
 * The censoring falls out of the same fact: a message handed to this seat has
 * `shoupai[0]` filled in and the other three empty, so only relative 0 is ever
 * revealed — exactly what Akagi does by replacing every other hand with "?".
 */
function toMjaiBatch(msg, seat, state) {
    if (msg.kaiju) {
        state.qijia = msg.kaiju.qijia || 0;
        state.rule = msg.kaiju.rule;
        return [{
            type: 'start_game',
            names: ['a', 'b', 'c', 'd'],
            id: seat,
            num_players: 4,
            // Majiang.Game hands every player a view whose `qijia` is the game's
            // base dealer, and its messages are relative to that. The bridge needs
            // the same value or its absolute<->menfeng mapping is offset.
            // Majiang.Game picks this at random, so it cannot be inferred.
            qijia: state.qijia,
        }];
    }

    // Absolute seat of relative position `l` for the current hand.
    const abs = (l) => (l + state.qijia + state.jushu) % 4;

    if (msg.qipai) {
        const q = msg.qipai;
        state.jushu = q.jushu;
        state.melds = [];
        // The engine blanks every hand but the recipient's, and the recipient of
        // `msg[l]` is `player_id[l]` — so the one real hand sits at OUR menfeng
        // index, which is 0 only when we happen to be this hand's dealer. Reading
        // index 0 unconditionally hands the bridge the dealer's tiles.
        const oursRelative = (((seat - state.qijia - q.jushu) % 4) + 4) % 4;
        const decoded = decodeHand(q.shoupai[oursRelative] || '');
        const mask = new Array(13).fill('?');
        const tiles = mask.slice();
        // `decoded` is majiang notation; mjai's `tehais` is mjai notation. The
        // other three seats are censored exactly as Akagi censors them.
        if (decoded.length === 13) {
            for (let i = 0; i < 13; i++) {
                const m = T.toMjai(decoded[i]);
                tiles[i] = m === null ? '?' : m;
            }
        }
        const tehais = [mask.slice(), mask.slice(), mask.slice(), mask.slice()];
        tehais[seat] = tiles;
        const scores = [];
        for (let l = 0; l < 4; l++) scores[abs(l)] = q.defen[l];
        return [{
            type: 'start_kyoku',
            bakaze: ['E', 'S', 'W', 'N'][q.zhuangfeng],
            dora_marker: T.toMjai(q.baopai) || '?',
            kyoku: (q.jushu % 4) + 1,
            honba: q.changbang,
            kyotaku: q.lizhibang,
            oya: abs(0),          // menfeng 0 is the dealer of this hand
            scores,
            tehais,
            num_players: 4,
        }];
    }

    // A draw from the wall and a replacement draw from the dead wall are the same
    // mjai event (`tsumo`): mjai does not distinguish them, and the bridge tells
    // them apart by the kan that preceded them. Dropping a replacement draw here
    // (as this file once did) leaves the engine auto-discarding on the bot's
    // behalf while the two models drift apart.
    if (msg.zimo || msg.gangzimo) {
        const z = msg.zimo || msg.gangzimo;
        const p = z.p;
        const actor = abs(z.l);
        const tile = p ? T.toMjai(p) : '?';
        return [{ type: 'tsumo', actor, pai: tile }];
    }

    if (msg.dapai) {
        const raw = msg.dapai.p;
        const actor = abs(msg.dapai.l);
        // The engine's own spelling carries the same markers mjai does, and they
        // stack in whatever order the player emitted them: `<tile>`, `_` for a
        // tsumogiri, `*` for a riichi, so `m1_*` and `m1*` are both real. Strip
        // the WHOLE run.
        //
        // Stripping only `*` left `m1_`, which is not a tile: `toMjai` returned
        // null, and the harness then handed the bridge a `dahai` with NO tile.
        // The bridge (correctly) refuses one of those, so every tsumogiri in every
        // replayed game was dropped before it reached the model — the discarder's
        // river never recorded it and the AI's danger model never saw it. That is
        // a hole in this test rather than in the bot, and it is exactly why the
        // river and placeholder bugs below went unnoticed for so long.
        //
        // The marker is also the authoritative `tsumogiri`: deriving it by asking
        // "is this the tile we just drew?" gets it wrong whenever a player holds
        // two copies of the drawn tile and throws one of them.
        const riichi = raw.includes('*');
        const tsumogiri = raw.includes('_');
        const tile = T.toMjai(raw.replace(/[*_]+$/, ''));
        if (tile === null) return [];
        const out = [];
        if (riichi) out.push({ type: 'reach', actor, pai: tile });
        out.push({ type: 'dahai', actor, pai: tile, tsumogiri });
        if (riichi) out.push({ type: 'reach_accepted', actor });
        return out;
    }

    if (msg.fulou) {
        const parts = T.mianziParts(msg.fulou.m);
        if (!parts) return [];
        const called = T.toMjai(parts.called);
        const consumed = parts.fromHand.map(T.toMjai);
        const isKan = parts.fromHand.length === 3;
        const want = T.canonical(parts.called);
        const isSet = parts.fromHand.every((t) => T.canonical(t) === want);
        // Remember melds so a later kan can be told from a closed one.
        state.melds = state.melds || [];
        state.melds.push(msg.fulou.m);
        // The engine's `l` is the caller; the discarder follows from the marker,
        // which sits on the called digit — NOT necessarily at the end (a chi on
        // the middle tile is `m12-3`).
        const offset = { '': 0, '-': 1, '=': 2, '+': 3 }[parts.marker] || 0;
        const targetRelative = (msg.fulou.l - offset + 4) % 4;
        return [{
            type: isKan ? 'daiminkan' : (isSet ? 'pon' : 'chi'),
            actor: abs(msg.fulou.l),
            target: abs(targetRelative),
            pai: called,
            consumed,
        }];
    }

    if (msg.gang) {
        const parts = T.mianziParts(msg.gang.m);
        if (!parts) return [];
        const tiles = [parts.called, ...parts.fromHand];
        if (tiles.length !== 4) return [];
        const want = T.canonical(tiles[0]);
        if (!tiles.every((t) => T.canonical(t) === want)) return [];
        // Closed kan vs added kan. majiang spells both with a 4-tile mianzi; the
        // difference is visible in the melds already seen — an added kan extends
        // a pon of the same tile, a closed kan does not.
        const isAdded = (state.melds || []).some((m) => {
            const p2 = T.mianziParts(m);
            return p2 && p2.fromHand.length === 2
                && T.canonical(p2.called) === want
                && p2.fromHand.every((t) => T.canonical(t) === want);
        });
        if (isAdded) {
            // Akagi's kakan shape: the added tile in `pai` plus three `consumed`
            // (its `Kakan { pai, consumed: [Tile; 3] }`).
            return [{
                type: 'kakan',
                actor: abs(msg.gang.l),
                pai: T.toMjai(tiles[0]),
                consumed: tiles.slice(1).map(T.toMjai),
            }];
        }
        // `Ankan { consumed: [Tile; 4] }` — all four, and no `pai`.
        return [{
            type: 'ankan',
            actor: abs(msg.gang.l),
            consumed: tiles.map(T.toMjai),
        }];
    }

    if (msg.kaigang) {
        const marker = T.toMjai(msg.kaigang.baopai);
        return marker ? [{ type: 'dora', dora_marker: marker }] : [];
    }

    if (msg.hule) {
        const actor = abs(msg.hule.l);
        const target = (msg.hule.baojia === undefined || msg.hule.baojia === null)
            ? actor : abs(msg.hule.baojia);
        return [{ type: 'hora', actor, target }];
    }

    if (msg.pingju) {
        return [{ type: 'ryukyoku' }];
    }

    return [];
}

/**
 * A majiang hand string → the tile list for `tehais`.
 *
 * `tehais` is built in majiang notation here and converted to mjai only when the
 * batch is assembled, because the engine's own source strings are majiang
 * notation ("m2", "p1") — feeding those to `fromMjai` would be a second, wrong
 * conversion.
 */
function decodeHand(handStr) {
    const tiles = [];
    for (const group of handStr.match(/[mpsz]\d+/g) || []) {
        const suit = group[0];
        for (const d of group.slice(1)) tiles.push(suit + d);
    }
    return tiles;
}

// ---------------------------------------------------------------------------
// One seat's bridge, wrapped as a majiang Player
// ---------------------------------------------------------------------------

class BridgeReferee {
    /**
     * Sits in for `seat`. The engine gives it majiang messages; it converts them
     * to mjai, runs them through the bridge, and returns the bridge's decision in
     * mahjong's reply format.
     */
    constructor(seat, opts = {}) {
        this.seat = seat;
        this.verbose = !!opts.verbose;
        this.onDivergence = opts.onDivergence || (() => {});
        this.messages = 0;
        // The engine's own board, published by `runGame`: it holds all four hands
        // and its wall counter, and it is the only independent witness there is —
        // the bridge's own player cannot witness itself.
        this.engine = null;

        this.driver = new MajiangDriver({
            Majiang,
            AI,
            seat,
            numPlayers: 4,
            rule: opts.rule || Majiang.rule({ '場数': 0 }),
            onNote: (m) => { if (this.verbose) console.log(`      [bridge] ${m}`); },
        });
        this.translator = new DecisionTranslator({ seat });
        this.state = { qijia: 0 };

        // Rolling record of recent events, so a divergence in a long game can be
        // reported with the run-up that caused it. Only kept when tracing.
        this.trace = [];
        this.tracing = !!opts.trace;
    }

    /**
     * The engine's entry point. `msg` is in this seat's view.
     * Returns the mahjong reply object the engine expects.
     */
    action(msg, callback) {
        const reply = this.replay(msg);
        // The engine calls `notify_players` without a callback in some paths
        // (e.g. a kan revealing dora), so this cannot assume one.
        if (typeof callback === 'function') callback(reply || {});
    }

    replay(msg) {
        this.messages++;

        const batch = toMjaiBatch(msg, this.seat, this.state);
        if (this.tracing) {
            for (const ev of batch) {
                this.trace.push(`${ev.type} a=${ev.actor}`
                    + ` wc=${this.driver.wallCount} ld=${this.driver.liveDraws}`
                    + ` kd=${this.driver.kans} rp=${this.driver.rinshanPending}`
                    + ` rf=${this.driver.rinshanFrom}`);
                if (this.trace.length > 120) this.trace.shift();
            }
        }
        let bridgeReply = null;
        let trigger = null;
        let askedAny = false;

        for (const ev of batch) {
            const r = this.driver.feed(ev);
            if (this.driver.asked) {
                askedAny = true;
                bridgeReply = r || {};
                trigger = ev;
            }
        }

        // Compare against the engine wherever the two are supposed to agree.
        //
        // Two deliberate restrictions, both about WHEN the two models are
        // legitimately in step:
        //
        //  - `kaigang` is skipped. The engine flips a kan's dora inside
        //    `Game.gangzimo`, i.e. after it has already taken the replacement draw
        //    and before it announces either, so at that message its hand is one
        //    step ahead by construction.
        //  - the wall count is checked at DECISION points only. Between decisions
        //    the bridge's private counter lags on purpose — it re-asserts it from
        //    its own accounting whenever it is asked something — and the two
        //    conventions for a kan's tile (this bridge charges the kan for its
        //    dora indicator, `Majiang.Shan` for its replacement draw) only meet
        //    once that draw has happened. Comparing mid-kan reports a difference
        //    that is not one; comparing where the counters are re-asserted is what
        //    found the real drifts.
        if (this.comparable(msg)) this.compare(msg, bridgeReply, askedAny);

        if (bridgeReply === null) return {};
        if (!trigger) return {};

        this.translator.hand = this.driver.player.shoupai;
        // The same legal set Akagi's path uses: the bridge derives it from its own
        // model, so a decision the model cannot justify is refused here too.
        const actions = this.translator.translate(bridgeReply, {
            trigger,
            legal: this.driver.lastLegal,
        });
        return mjaiToMajiang(actions, this.seat, this.state);
    }

    /**
     * Whether this message leaves both models in a state that must be identical.
     *
     * `hule`/`pingju` end the hand and rewrite hands the bot never sees (the
     * engine fills in the revealed ones), `kaiju` happens before any hand exists,
     * and `kaigang` is announced by an engine that has already moved on (see
     * `replay`). Everything else is.
     */
    comparable(msg) {
        if (!this.engine) return false;
        if (msg.kaiju || msg.hule || msg.pingju || msg.jieju || msg.kaigang) return false;
        return true;
    }

    /**
     * Compare the bridge's model against the ENGINE's board for our seat — the
     * concealed tiles and the melds, plus the live-wall count.
     *
     * The engine has already applied this message to its own board, and it applies
     * our action only after `replay` returns it. So when the AI has just chosen a
     * discard (and `_applyOwnDiscard` has taken that tile out of the bridge's
     * hand), the engine still holds it: exactly one tile is added back before the
     * comparison. Nothing else about the two states should differ.
     *
     * @param {boolean} wallToo  whether this batch re-asserted the wall counters
     */
    compare(msg, bridgeReply, wallToo) {
        const mine = this.driver.player.shoupai;
        const theirs = this.engineHand();
        if (!mine || !theirs) return;

        const applied = bridgeReply && typeof bridgeReply.dapai === 'string'
            ? bridgeReply.dapai.replace(/[*_]+$/, '')
            : null;

        const a = concealed(mine, applied);
        const b = concealed(theirs, null);
        if (a !== b) {
            this.onDivergence({
                kind: 'hand',
                message: describe(msg),
                bridge: a + (applied ? ` (+${applied} just discarded)` : ''),
                reference: b,
                trace: this.tracing ? this.trace.slice(-18) : undefined,
            });
        }

        const ma = melds(mine);
        const mb = melds(theirs);
        if (ma !== mb) {
            this.onDivergence({
                kind: 'meld',
                message: describe(msg),
                bridge: ma,
                reference: mb,
                trace: this.tracing ? this.trace.slice(-18) : undefined,
            });
        }

        // Tiles left in the live wall, checked against the ENGINE's counter.
        //
        // This is the quantity that scales every availability estimate the AI
        // makes (`Paishu.val()` multiplies by it), so a drift here silently
        // degrades play without ever producing an illegal move.
        //
        // `exactWallCount` rather than `wallCount`: the latter floors at 1 because
        // `SuanPai._n_zimo` is a scale factor, while the library's `paishu` is a
        // tile count that legitimately reaches 0 on the last draw.
        if (!wallToo) return;
        const shan = this.engine._model.shan;
        const wb = shan && typeof shan.paishu === 'number' ? shan.paishu : null;
        const wa = Math.max(0, this.driver.exactWallCount);
        if (wb !== null && wa !== wb) {
            this.onDivergence({
                kind: 'wall',
                message: describe(msg),
                bridge: wa,
                reference: wb,
                trace: this.tracing ? this.trace.slice(-18) : undefined,
            });
        }
    }

    /** The engine's own hand for our seat (its board holds all four). */
    engineHand() {
        const model = this.engine._model;
        if (!model.shoupai || !model.player_id) return null;
        const l = model.player_id.indexOf(this.seat);
        return l < 0 ? null : model.shoupai[l];
    }
}

/**
 * A comparable view of a hand's CONCEALED tiles.
 *
 * `_bingpai` is the honest source: the counts include the drawn tile and exclude
 * melds, and they compare directly between the two models without either one's
 * `_zimo` spelling getting in the way. The blank counter is included, so a model
 * that ate a tile through `Shoupai.decrease`'s blank path shows up instead of
 * hiding.
 *
 * @param {object} shoupai
 * @param {string|null} plus  a tile to add back (the discard the engine has not
 *                            applied yet)
 */
function concealed(shoupai, plus) {
    const counts = {};
    for (const s of ['m', 'p', 's', 'z']) {
        const b = shoupai._bingpai[s];
        for (let n = 1; n < b.length; n++) {
            if (b[n]) counts[s + n] = (counts[s + n] || 0) + b[n];
        }
    }
    // The added tile goes through `canonical` because a red five is counted in
    // `_bingpai[5]` too: adding the literal `m0` would report a red five where the
    // other side reports a five, which is a spelling difference, not a state one.
    if (plus) {
        const t = T.canonical(plus);
        counts[t] = (counts[t] || 0) + 1;
    }
    const text = Object.keys(counts).sort().map((k) => k + 'x' + counts[k]);
    if (shoupai._bingpai._) text.push('blankx' + shoupai._bingpai._);
    return text.join(' ');
}

/**
 * A comparable view of a hand's melds: their tiles as a multiset, red-five
 * insensitively. The marker position and the written order are deliberately
 * ignored — those legitimately differ between spellings of the same meld — while
 * a missing or duplicated meld (the `m222+,,` class of bug) cannot hide.
 */
function melds(shoupai) {
    const tiles = [];
    for (const m of shoupai._fulou || []) {
        const parts = T.mianziParts(m);
        if (!parts) { tiles.push('?' + m); continue; }
        for (const t of [parts.called, ...parts.fromHand]) tiles.push(T.canonical(t));
    }
    return tiles.sort().join(',');
}

function describe(msg) {
    const key = Object.keys(msg)[0];
    const body = msg[key];
    if (key === 'zimo') return `zimo l=${body.l} p=${JSON.stringify(body.p)}`;
    if (key === 'gangzimo') return `gangzimo l=${body.l} p=${JSON.stringify(body.p)}`;
    if (key === 'dapai') return `dapai l=${body.l} p=${JSON.stringify(body.p)}`;
    if (key === 'fulou') return `fulou l=${body.l} m=${JSON.stringify(body.m)}`;
    if (key === 'gang') return `gang l=${body.l} m=${JSON.stringify(body.m)}`;
    if (key === 'qipai') return `qipai jushu=${body.jushu}`;
    return key;
}

/** Translate the bridge's mjai actions back into the engine's reply format. */
function mjaiToMajiang(actions, seat, state) {
    if (!Array.isArray(actions) || !actions.length) return {};

    let riichi = false;
    let dahai = null;
    for (const a of actions) {
        if (!a) continue;
        if (a.type === 'reach') {
            // Akagi's `Reach` names the declaring discard; the engine spells the
            // same thing with the marker on the discard itself.
            riichi = true;
            if (typeof a.pai === 'string') {
                const t = T.fromMjai(a.pai);
                if (t !== null) dahai = t + '*';
            }
        } else if (a.type === 'dahai') {
            dahai = T.fromMjai(a.pai);
            if (a.tsumogiri) dahai += '_';
            if (riichi) dahai += '*';
        } else if (a.type === 'hora') return { hule: '-' };
        else if (a.type === 'ryukyoku') return { daopai: '-' };
        else if (a.type === 'pon' || a.type === 'chi' || a.type === 'daiminkan') {
            const called = T.fromMjai(a.pai);
            return { fulou: rebuildMianzi(called, a, seat) };
        } else if (a.type === 'ankan' || a.type === 'kakan') {
            return { gang: rebuildKan(a, state) };
        }
    }
    if (dahai !== null) return { dapai: dahai };
    return {};
}

/**
 * Rebuild the mahjong mianzi string the engine expects. The engine compares
 * replies against its own candidate list by string equality, so this must match
 * `Majiang.Game`'s spelling exactly — which means re-deriving the direction
 * marker and letting `T.mianzi` place it on the called tile.
 */
function rebuildMianzi(called, action, seat) {
    const marker = directionOf(action.target, seat);
    const tiles = [called, ...(action.consumed || []).map(T.fromMjai)];
    return T.mianzi(Majiang, tiles, marker);
}

/** majiang's own direction table, indexed by (discarder - caller) mod 4. */
function directionOf(discarder, caller) {
    const idx = (((discarder - caller) % 4) + 4) % 4;
    return ['', '+', '=', '-'][idx];
}

/**
 * Rebuild a kan mianzi from the action.
 *
 * A closed kan is the four digits (`z1111`); an ADDED kan must name the pon it
 * extends (`z111+1`), because the library's `Shoupai.gang` reads four bare digits
 * as a closed kan and would take three tiles out of hand. The pon's own spelling
 * is taken from the melds the engine has already announced, so the string matches
 * the engine's candidate list exactly.
 */
function rebuildKan(action, state) {
    const three = (action.consumed || []).map(T.fromMjai);
    if (three.some((t) => t === null)) return null;

    if (action.type === 'ankan') {
        const tiles = three;
        return tiles.length === 4 ? T.mianzi(Majiang, tiles, '') : null;
    }

    const added = T.fromMjai(action.pai);
    if (added === null) return null;
    const want = T.canonical(added);
    const pon = (state && state.melds ? state.melds : []).find((m) => {
        const p = T.mianziParts(m);
        return p && p.fromHand.length === 2
            && T.canonical(p.called) === want
            && p.fromHand.every((t) => T.canonical(t) === want);
    });
    if (!pon) return null;
    const candidate = pon + added[1];
    return Majiang.Shoupai.valid_mianzi(candidate) === candidate ? candidate : null;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runGame(seat, rule, seed, opts) {
    const ref = new BridgeReferee(seat, opts);
    const players = [];
    for (let i = 0; i < 4; i++) {
        // The engine calls `action(msg, cb)`, which BridgeReferee implements with
        // the same signature a real Player has.
        players[i] = i === seat ? ref : new AI();
    }

    const game = new Majiang.Game(players, () => {}, rule, 'harness');
    ref.engine = game;

    // `opts.override`: every third plain discard, the "player" throws something
    // other than the bot's choice — manual play, which is the one scenario this
    // referee could never reproduce, because it always played the bot's own
    // answer. The engine applies whatever we return and echoes it back, so the
    // bridge is handed an echo that disagrees with what it already applied: the
    // exact shape of the "candidates do not match my hand" report.
    if (opts.override) {
        const inner = ref.replay.bind(ref);
        let n = 0;
        ref.replay = (msg) => {
            const reply = inner(msg);
            if (!reply || typeof reply.dapai !== 'string' || reply.dapai.includes('*')) {
                return reply;
            }
            if (++n % 3) return reply;
            const sp = ref.driver.player.shoupai;
            const tiles = [];
            for (const s of ['m', 'p', 's']) {
                const b = sp._bingpai[s];
                for (let i = 0; i < b[0]; i++) tiles.push(s + '0');
                for (let k = 1; k < b.length; k++) {
                    const normal = k === 5 ? b[5] - b[0] : b[k];
                    for (let i = 0; i < normal; i++) tiles.push(s + k);
                }
            }
            const bz = sp._bingpai.z;
            for (let k = 1; k < bz.length; k++) {
                for (let i = 0; i < bz[k]; i++) tiles.push('z' + k);
            }
            const current = reply.dapai.replace(/[*_]+$/, '');
            const alt = tiles.find((t) => t !== current);
            return alt ? Object.assign({}, reply, { dapai: alt }) : reply;
        };
    }

    // Seed the game: the dealer AND the wall.
    //
    // `do_sync` drives `kaiju()` itself, and `kaiju` picks a RANDOM dealer when it
    // is not handed one — so pinning the wall alone still leaves every run a
    // different game (the dealer moves every seat's view, and the hand count
    // follows). Both are pinned here, or a failure cannot be replayed.
    const origKaiju = game.kaiju;
    game.kaiju = function kaijuWithDealer(qijia) {
        return origKaiju.call(this, qijia === undefined ? (seed % 4) : qijia);
    };

    // `Majiang.Game` builds its wall inside `qipai()`, which `do_sync()` reaches
    // through `reply_kaiju`, so the method itself is the only hook. The seed moves
    // on per hand — reusing one wall for every hand of a game would deal the same
    // tiles eight times.
    const origQipai = game.qipai;
    let dealt = 0;
    game.qipai = function qipaiWithWall(shan) {
        const wall = makeWall(seed + (dealt++) * 104729, rule);
        return origQipai.call(this, shan || makeShan(rule, wall));
    };

    // `do_sync()` runs the whole game to completion synchronously: it calls
    // `kaiju()`, then loops until the status leaves the playing set. Players reply
    // inline (our referee does too), so no timers are involved.
    game.do_sync();

    const hands = game._paipu && game._paipu.log ? game._paipu.log.length : 0;
    return { messages: ref.messages, ref, hands };
}

// ---------------------------------------------------------------------------

function main() {
    const argv = process.argv.slice(2);
    const opt = (name, dflt) => {
        const i = argv.indexOf(name);
        return i === -1 ? dflt : argv[i + 1];
    };
    const verbose = argv.includes('--verbose');
    const trace = argv.includes('--trace');
    const override = argv.includes('--override');
    const games = Number.parseInt(opt('--games', opt('--hands', '1')), 10);
    const seed0 = Number.parseInt(opt('--seed', '1'), 10);
    const seatArg = opt('--seat', null);
    const rounds = opt('--rounds', 'south');

    if (!(rounds in ROUNDS)) {
        console.error(`--rounds must be one of ${Object.keys(ROUNDS).join(', ')}`);
        return 2;
    }
    const rule = Majiang.rule({ '場数': ROUNDS[rounds] });
    const seats = seatArg === null ? [0, 1, 2, 3] : [Number.parseInt(seatArg, 10)];

    console.log('kobalab bridge harness');
    console.log(`  rule:  場数 ${ROUNDS[rounds]} (${rounds}), red fives ${JSON.stringify(rule['赤牌'])}`);
    console.log(`  ${games} seeded game(s) x seat(s) ${seats.join(',')}, seed ${seed0}`
        + (override ? ', player overrides every 3rd discard' : ''));
    console.log('  comparing concealed tiles + melds + live-wall count after every message\n');

    const divergences = [];
    let totalMessages = 0;
    let totalHands = 0;
    let gamesRun = 0;

    for (const seat of seats) {
        for (let g = 0; g < games; g++) {
            const seed = seed0 + g * 1013 + seat * 7919;
            let result;
            try {
                result = runGame(seat, rule, seed, {
                    verbose,
                    trace,
                    override,
                    onDivergence: (d) => divergences.push(Object.assign({ seat, game: g }, d)),
                    rule,
                });
            } catch (e) {
                divergences.push({
                    seat,
                    game: g,
                    kind: 'threw',
                    message: e.message,
                    stack: e.stack.split('\n').slice(1, 4).join('\n'),
                });
                continue;
            }
            totalMessages += result.messages;
            totalHands += result.hands;
            gamesRun++;
            const bad = divergences.filter((d) => d.seat === seat && d.game === g).length;
            process.stdout.write(
                `  seat ${seat} game ${g}: seed ${String(seed).padStart(5)}`
                + `  ${String(result.hands).padStart(2)} hands`
                + `  ${String(result.messages).padStart(4)} messages`
                + (bad ? `  ${bad} DIVERGENCE(S)\n` : '  ok\n')
            );
        }
    }

    console.log(`\n${gamesRun} game(s), ${totalHands} hands, ${totalMessages} engine messages replayed.`);

    if (!divergences.length) {
        console.log('RESULT: bridge model matched the engine after every message.');
        return 0;
    }

    console.log(`RESULT: ${divergences.length} divergence(s):\n`);
    const byKind = {};
    for (const d of divergences) byKind[d.kind] = (byKind[d.kind] || 0) + 1;
    for (const [k, n] of Object.entries(byKind)) console.log(`  ${k}: ${n}`);

    console.log('\nfirst 12:');
    for (const d of divergences.slice(0, 12)) {
        console.log(`  [seat ${d.seat} game ${d.game}] ${d.kind} at ${d.message}`);
        console.log(`      bridge    ${JSON.stringify(d.bridge)}`);
        console.log(`      reference ${JSON.stringify(d.reference)}`);
        if (d.trace) {
            console.log('      run-up:');
            for (const t of d.trace) console.log('        ' + t);
        }
        if (d.stack) console.log(`      ${d.stack}`);
    }
    return 1;
}

module.exports = {
    makeWall, makeShan, toMjaiBatch, BridgeReferee, runGame, rng,
    concealed, melds,
};

if (require.main === module) process.exit(main());
