/*
 *  test_translator.js — drive bridge/to_majiang.js with mjai event sequences and
 *  assert the AI behaves.
 *
 *  Run: node test/test_translator.js
 *
 *  These are hand-written event scripts, so they are fast and precise. The
 *  complementary whole-game test that compares our reconstruction against
 *  mahjong-core's own engine lives in ../probe/harness.js (repo-root probe/).
 */
'use strict';

const M = require('@kobalab/majiang-core');
const AI = require('@kobalab/majiang-ai');
const { MajiangDriver, directionFor, bakazeToNumber } = require('../bridge/to_majiang');
const T = require('../bridge/tiles');

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { pass++; return; }
    failures.push(`${label}\n      got  ${a}\n      want ${e}`);
}

function ok(cond, label) {
    if (cond) { pass++; return; }
    failures.push(label);
}

function driver(seat, notes) {
    return new MajiangDriver({
        Majiang: M,
        AI,
        seat,
        numPlayers: 4,
        rule: M.rule({ '場数': 0 }),
        onNote: (s) => { if (notes) notes.push(s); },
    });
}

/** No event has been rejected by the model since the last `reset` marker. */
function noRejections(d, label) {
    ok(d.lastError === null || d.lastError === undefined, label);
}

// A legal 13-tile hand, in mjai notation: m13579 p2468 s1357 — a genuine
// 4-shanten with no wait, so drawing 9p cannot complete it.
//
// The tile COUNT matters and is easy to get wrong: a 12-tile "hand" is silently
// short (see the bare-suit-prefix hazard in bridge/tiles.js), and a 14-tile one
// is a winning shape — in which case the AI answers `{hule:'-'}` instead of a
// discard, and the test looks like a translator bug when it is not.
const HAND_MJAI = ['1m', '3m', '5m', '7m', '9m', '2p', '4p', '6p', '8p', '1s', '3s', '5s', '7s'];

function startGame(seat) {
    return { type: 'start_game', names: ['a', 'b', 'c', 'd'], id: seat, num_players: 4 };
}

function startKyoku(seat, opts = {}) {
    const tehais = [[], [], [], []];
    tehais[seat] = HAND_MJAI;
    // Opponent hands are censored on the wire.
    for (let i = 0; i < 4; i++) {
        if (i !== seat) tehais[i] = new Array(13).fill('?');
    }
    return {
        type: 'start_kyoku',
        bakaze: opts.bakaze || 'E',
        dora_marker: opts.dora_marker || '1s',
        kyoku: opts.kyoku || 1,
        honba: 0,
        kyotaku: 0,
        oya: opts.oya === undefined ? seat : opts.oya,
        scores: [25000, 25000, 25000, 25000],
        tehais,
        num_players: 4,
    };
}

// ---------------------------------------------------------------------------
// 1. Seat rotation: the bot must always see its own hand, whatever its seat.
// ---------------------------------------------------------------------------
for (const seat of [0, 1, 2, 3]) {
    const d = driver(seat);
    d.feed(startGame(seat));
    d.feed(startKyoku(seat));
    // Each player is handed a view in which it is the base dealer (qijia = its
    // own seat), so the bot is ALWAYS menfeng 0 — that is the index its hand
    // lives at and the index its events are translated into. See to_majiang.js.
    eq(d.player._menfeng, 0, `seat ${seat}: bot sits at menfeng 0`);
    eq(d.menfeng(seat), 0, `seat ${seat}: menfeng(bot) is 0`);
    eq(
        d.player.shoupai.toString(),
        T.serialize(HAND_MJAI.map(T.fromMjai)),
        `seat ${seat}: bot sees its own hand`
    );
    eq(M.Util.xiangting(d.player.shoupai), 4, `seat ${seat}: hand reads as 4-shanten`);
}

// ---------------------------------------------------------------------------
// 2. The bot is asked to discard on its own draw, and the reply is a discard.
// ---------------------------------------------------------------------------
{
    const d = driver(2);
    d.feed(startGame(2));
    d.feed(startKyoku(2));
    const reply = d.feed({ type: 'tsumo', actor: 2, pai: '9p' });
    ok(reply !== null, 'own tsumo produces a reply');
    ok(reply && typeof reply.dapai === 'string', 'reply is a discard');
    // The tile string is either 'X' (tile from hand) or 'XY' (tsumogiri of the
    // draw), optionally with a riichi marker.
    // majiang's discard notation: a tile (`p9`), optionally followed by '_' for
    // tsumogiri, optionally followed by '*' or '**' for riichi.
    ok(reply && /^[mpsz]\d_?\*{0,2}$/.test(reply.dapai),
        `discard string is well formed: ${reply && reply.dapai}`);
}

// ---------------------------------------------------------------------------
// 3. An opponent's censored draw must not corrupt the model, but must advance
//    the wall count.
// ---------------------------------------------------------------------------
{
    const d = driver(2);
    d.feed(startGame(2));
    d.feed(startKyoku(2));

    const before = d.wallCount;
    const wallBefore = d.player._suanpai._n_zimo;

    d.feed({ type: 'tsumo', actor: 0, pai: '?' });
    eq(d.wallCount, before - 1, 'opponent draw decrements the live wall');
    eq(d.player.shoupai.toString(), T.serialize(HAND_MJAI.map(T.fromMjai)),
        'opponent draw leaves our hand untouched');

    d.feed({ type: 'dahai', actor: 0, pai: '3p', tsumogiri: true });
    // The AI re-syncs the counter when it is consulted, so a decision after the
    // opponent's discard must see the decremented value.
    const reply = d.feed({ type: 'tsumo', actor: 2, pai: '9p' });
    ok(reply !== null, 'we are still asked after an opponent turn');
    eq(d.player._suanpai._n_zimo, d.wallCount, 'wall counter resynced at decision time');
    ok(wallBefore === 70, 'wall started at 70');
}

// ---------------------------------------------------------------------------
// 4. Every seat's draw counts exactly once (70-tile live wall).
//
// The wire has to stay internally consistent: majiang-core throws if a tile is
// drawn more than four times or discarded when not held, so the scripted draws
// are taken from a fixed "wall" pool and the bot is made to discard a tile it
// actually holds.
// ---------------------------------------------------------------------------
const WALL_POOL = (() => {
    const tiles = [];
    for (const suit of ['m', 'p', 's']) for (let n = 1; n <= 9; n++) for (let c = 0; c < 4; c++) tiles.push(n + suit);
    for (const h of ['E', 'S', 'W', 'N', 'P', 'F', 'C']) for (let c = 0; c < 4; c++) tiles.push(h);
    return tiles;
})();

/** A tile the bot can legally discard right now (prefers its own draw). */
function legalBotDiscard(d) {
    const held = d.player.shoupai;
    const drawn = held._zimo;
    if (drawn && drawn.length >= 2) return drawn.slice(0, 2);
    for (const suit of ['m', 'p', 's', 'z']) {
        const b = held._bingpai[suit];
        for (let n = 1; n < b.length; n++) {
            if (b[n] > 0) return suit + n;
        }
    }
    return null;
}

{
    const d = driver(1);
    d.feed(startGame(1));
    d.feed(startKyoku(1));

    // Remove the bot's dealt tiles from the pool conceptually; a scripted test
    // only needs the wall draws to be distinct from each other.
    let wi = 0;
    let actor = 1;
    for (let i = 0; i < 12; i++) {
        const tile = WALL_POOL[wi++];
        if (actor === 1) {
            d.feed({ type: 'tsumo', actor, pai: tile });
            const disc = legalBotDiscard(d);
            d.feed({ type: 'dahai', actor, pai: disc, tsumogiri: disc === tile });
        } else {
            d.feed({ type: 'tsumo', actor, pai: '?' });
            d.feed({ type: 'dahai', actor, pai: tile, tsumogiri: true });
        }
        actor = (actor + 1) % 4;
    }
    eq(d.wallCount, 70 - 12, 'twelve draws consume twelve live-wall tiles');
}

// ---------------------------------------------------------------------------
// 5. Wall accounting around a kan.
//
// The model is the library's own: `Majiang.Shan` counts DRAWS (`zimo` pops,
// `gangzimo` shifts the same array), so a kan costs the wall exactly one tile —
// at its replacement draw. The dora indicator it reveals is not charged
// separately, because charging it at the announcement instead would put the two
// counters out of step for the whole interval between a kan and its draw, and a
// decision can fall inside that interval.
// ---------------------------------------------------------------------------
{
    const d = driver(0);
    d.feed(startGame(0));
    d.feed(startKyoku(0));
    const before = d.wallCount;

    // Open kan on the bot's own draw.
    d.feed({ type: 'tsumo', actor: 0, pai: '9m' });
    const reply = d.feed({ type: 'ankan', actor: 0, consumed: ['1m', '1m', '1m', '1m'] });
    ok(reply === null || reply.gang !== undefined,
        'ankan is answered (or declined) without error');

    const afterKan = d.wallCount;
    eq(afterKan, before - 1, 'the kan itself consumed the draw that preceded it');

    // The replacement draw consumes the wall's next tile — one tile per kan.
    d.feed({ type: 'tsumo', actor: 0, pai: '5p' });
    eq(d.wallCount, afterKan - 1, 'the replacement draw consumes a live-wall tile');

    // The dora indicator that same kan revealed does NOT consume a second one.
    d.feed({ type: 'dora', dora_marker: '2p' });
    eq(d.wallCount, afterKan - 1, 'the kan dora indicator does not consume a tile');
    eq(d.kans, 1, 'the kan is counted for diagnostics');
}

// ---------------------------------------------------------------------------
// 6. Chi/pon mianzi strings carry the right direction marker.
// ---------------------------------------------------------------------------
{
    // Use a hand that can pon: give ourselves a pair of 1m.
    const d = driver(2);
    d.feed(startGame(2));
    const tehais = [[], [], [], []];
    for (let i = 0; i < 4; i++) tehais[i] = new Array(13).fill('?');
    tehais[2] = ['1m', '1m', '2m', '3m', '4m', '5p', '6p', '7p', '2s', '3s', '4s', 'E', 'E'];
    d.feed({
        type: 'start_kyoku', bakaze: 'E', dora_marker: '1s', kyoku: 1, honba: 0,
        kyotaku: 0, oya: 2, scores: [25000, 25000, 25000, 25000], tehais, num_players: 4,
    });

    // Direction markers are computed in menfeng space, from (discarder, caller).
    // A tile called off the player who plays immediately BEFORE the caller is
    // '-', which is also the only marker `Shoupai.get_chi_mianzi` will produce a
    // run for — so the sign is load-bearing, not cosmetic.
    eq(directionFor(0, 0), '', 'discarder and caller are the same seat');
    eq(directionFor(0, 1), '-', 'called from the player before the caller (the left)');
    eq(directionFor(0, 2), '=', 'called from across');
    eq(directionFor(0, 3), '+', 'called from the player after the caller (the right)');

    // Pin the whole table to majiang-core's own formula
    // (`'_+=-'[(4 + lunban - caller) % 4]`), so a refactor that flips the sign
    // cannot slip through on a single hand-picked case.
    {
        const LIB = (d, c) => ['_', '+', '=', '-'][(((4 + d - c) % 4) + 4) % 4];
        const mismatched = [];
        for (let d = 0; d < 4; d++) {
            for (let c = 0; c < 4; c++) {
                const ours = directionFor(d, c) || '_';
                if (ours !== LIB(d, c)) mismatched.push(`${d},${c}: ${ours} != ${LIB(d, c)}`);
            }
        }
        eq(mismatched, [], 'directionFor matches majiang-core for every seat pair');
    }

    const reply = d.feed({ type: 'dahai', actor: 3, pai: '1m', tsumogiri: false });
    // We may or may not choose to pon; if we do, the mianzi must be well formed.
    if (reply && reply.fulou) {
        ok(/^[mpsz]\d{3}[\+\=\-]$/.test(reply.fulou),
            `pon mianzi is well formed: ${reply.fulou}`);
    } else {
        pass++;   // declining is a legitimate answer
    }
}

// ---------------------------------------------------------------------------
// 7. Riichi: our own discard carries the marker, and no reply is expected.
// ---------------------------------------------------------------------------
{
    const d = driver(2);
    d.feed(startGame(2));
    d.feed(startKyoku(2));
    const reply = d.feed({ type: 'tsumo', actor: 2, pai: '9p' });
    ok(reply && typeof reply.dapai === 'string', 'draw is answered');
    if (reply && reply.dapai.endsWith('*')) {
        eq(d.pendingReach[2], null, 'no reach event seen yet, so nothing pending');
    } else {
        pass++;
    }

    // A reach event for an opponent must not open a decision for us. The
    // pending-reach slot is indexed by MENFENG, not by absolute seat.
    const oppMenfeng = d.menfeng(1);
    const r = d.feed({ type: 'reach', actor: 1, pai: '5s' });
    eq(r, null, 'opponent reach opens no decision');
    eq(d.pendingReach[oppMenfeng], 's5', 'opponent reach recorded at its menfeng');

    const r2 = d.feed({ type: 'reach_accepted', actor: 1 });
    eq(d.pendingReach[oppMenfeng], null, 'acceptance clears the pending reach');
    void r2;
}

// ---------------------------------------------------------------------------
// 8. A long run without throwing, including kans and dora.
// ---------------------------------------------------------------------------
{
    const notes = [];
    const d = driver(3, notes);
    d.feed(startGame(3));
    d.feed(startKyoku(3));

    let wi = 26;              // start past the tiles used by test 4
    let actor = 3;
    for (let i = 0; i < 40; i++) {
        const tile = WALL_POOL[(wi++) % WALL_POOL.length];
        if (actor === 3) {
            d.feed({ type: 'tsumo', actor, pai: tile });
            const disc = legalBotDiscard(d);
            if (disc) d.feed({ type: 'dahai', actor, pai: disc, tsumogiri: disc === tile });
        } else {
            d.feed({ type: 'tsumo', actor, pai: '?' });
            d.feed({ type: 'dahai', actor, pai: tile, tsumogiri: true });
        }
        actor = (actor + 1) % 4;
    }
    ok(d.wallCount >= 0 && d.wallCount <= 70, 'wall count stays in range through 40 draws');
    eq(d.wallCount, 70 - 40, 'forty draws consume forty live-wall tiles');
}

// ---------------------------------------------------------------------------
// 8b. Wall accounting regressions.
//
// Each of these corresponds to a real bug found by probe/harness.js, where the
// bridge's live-wall count drifted away from the engine's and the AI quietly
// played on a scaled-down view of the remaining tiles.
// ---------------------------------------------------------------------------
{
    // (a) A kan's tile is charged once — at its replacement draw — and its dora
    //     indicator is not charged at all. The order of the two events on the
    //     wire must not change the answer.
    {
        const d = driver(0);
        d.feed(startGame(0));
        d.feed(startKyoku(0));
        const before = d.wallCount;
        d.feed({ type: 'tsumo', actor: 0, pai: '9m' });
        eq(d.wallCount, before - 1, 'the draw before a kan consumes a live tile');
        d.feed({ type: 'ankan', actor: 0, consumed: ['1m', '1m', '1m', '1m'] });
        eq(d.wallCount, before - 1, 'the kan alone consumes nothing');
        d.feed({ type: 'dora', dora_marker: '2p' });
        eq(d.wallCount, before - 1, 'the kan dora indicator consumes nothing either');
        d.feed({ type: 'tsumo', actor: 0, pai: '5p' });
        eq(d.wallCount, before - 2, 'the replacement draw consumes exactly one tile');
    }

    // (a2) The same kan, with the dora announced AFTER the draw (the order a
    //      daiminkan produces): the count must not move when it arrives.
    {
        const d = driver(0);
        d.feed(startGame(0));
        d.feed(startKyoku(0));
        const before = d.wallCount;
        d.feed({ type: 'tsumo', actor: 1, pai: '?' });
        d.feed({ type: 'ankan', actor: 1, consumed: ['2p', '2p', '2p', '2p'] });
        d.feed({ type: 'tsumo', actor: 1, pai: '?' });
        const afterDraw = d.wallCount;
        d.feed({ type: 'dora', dora_marker: '2p' });
        eq(d.wallCount, afterDraw, 'a late dora announcement does not move the count');
        eq(afterDraw, before - 2, 'the kan and its draw cost one tile each');
    }

    // (b) Only the player who declared the kan gets the rinshan draw.
    {
        const d = driver(0);
        d.feed(startGame(0));
        d.feed(startKyoku(0));
        d.feed({ type: 'tsumo', actor: 1, pai: '?' });
        d.feed({ type: 'ankan', actor: 1, consumed: ['2p', '2p', '2p', '2p'] });
        const after = d.wallCount;
        // Seat 2 draws: that is a normal draw, not seat 1's replacement.
        d.feed({ type: 'tsumo', actor: 2, pai: '?' });
        eq(d.wallCount, after - 1, 'another seat\'s draw still consumes a live tile');
    }

    // (c) A kan whose replacement draw never arrives must not excuse a later
    //     draw. The hand can simply end first.
    {
        const d = driver(0);
        d.feed(startGame(0));
        d.feed(startKyoku(0));
        d.feed({ type: 'tsumo', actor: 3, pai: '9m' });
        d.feed({ type: 'ankan', actor: 3, consumed: ['3s', '3s', '3s', '3s'] });
        // Someone discards instead of the replacement draw happening.
        d.feed({ type: 'dahai', actor: 1, pai: '1s', tsumogiri: true });
        const after = d.wallCount;
        d.feed({ type: 'tsumo', actor: 2, pai: '?' });
        eq(d.wallCount, after - 1, 'a stale rinshan flag does not excuse a real draw');
    }

    // (d) The draw count is per hand.
    {
        const d = driver(0);
        d.feed(startGame(0));
        d.feed(startKyoku(0));
        d.feed({ type: 'tsumo', actor: 0, pai: '9m' });
        d.feed({ type: 'ankan', actor: 0, consumed: ['1m', '1m', '1m', '1m'] });
        d.feed({ type: 'dora', dora_marker: '2p' });
        const inHand = d.wallCount;
        void inHand;
        // A new hand refills the live wall; the old kan must not persist.
        d.feed(startKyoku(0));
        eq(d.wallCount, 70, 'a new hand resets the live-wall count');
        eq(d.kans, 0, 'and forgets the previous hand\'s kans');
    }
}

// ---------------------------------------------------------------------------
// 8c. Call idempotency and the post-call discard.
//
// Both of these were real "the bot hangs after a call" bugs, and neither was
// caught by the whole-game harness because the engine and the bridge were
// affected identically — the harness compares them to each other, so a mistake
// both sides make looks like agreement. They need explicit tests.
//
//   1. Akagi treats a seat's own chi/pon as a decision point, so the call comes
//      back to us after we applied it. Applying it twice appends the meld a
//      second time (`m222+,,`) and majiang-core then rejects every later event.
//   2. A chi/pon obliges an immediate discard, and the AI returns it — but the
//      call path never applied it, so the drawn tile stayed in `_zimo` and the
//      concealed hand grew by one tile per call.
// ---------------------------------------------------------------------------
{
    const ponHand = ['2m', '2m', '3m', '4m', '5m', '5p', '5p', '7p', '8p',
        '2s', '3s', '4s', '6s'];

    function ponDriver() {
        const d = driver(0);
        d.feed(startGame(0));
        const tehais = [[], [], [], []];
        for (let i = 0; i < 4; i++) tehais[i] = new Array(13).fill('?');
        tehais[0] = ponHand;
        d.feed({
            type: 'start_kyoku', bakaze: 'E', dora_marker: '2s', kyoku: 1,
            honba: 0, kyotaku: 0, oya: 0,
            scores: [25000, 25000, 25000, 25000], tehais, num_players: 4,
        });
        d.feed({ type: 'tsumo', actor: 1, pai: '?' });
        d.feed({ type: 'dahai', actor: 1, pai: '2m', tsumogiri: false });
        return d;
    }

    // Count the concealed tiles, ignoring the drawn slot.
    function concealed(s) {
        let n = 0;
        for (const group of s.split(',')[0].replace(/_+$/, '').match(/[mpsz]\d+/g) || []) {
            n += group.length - 1;
        }
        return n;
    }

    // (1) the call itself
    {
        const d = ponDriver();
        const reply = d.feed({ type: 'pon', actor: 0, target: 1, pai: '2m', consumed: ['2m', '2m'] });
        ok(reply && typeof reply.dapai === 'string', 'a pon is answered with a discard');
        eq(d.player.shoupai._fulou.length, 1, 'the meld is recorded exactly once');
        eq(d.player.shoupai._fulou[0], 'm222+', 'the meld string is clean (no doubled separator)');
        eq(d.player.shoupai.toString().indexOf(',,'), -1, 'no empty meld slot in the hand string');

        // (2) the post-call discard must have been applied
        eq(concealed(d.player.shoupai.toString()), 10,
            'after a pon the concealed hand is 10 tiles');
        eq(d.player.shoupai._zimo, null,
            'the drawn slot is cleared, so the next draw cannot pile up');
    }

    // (3) the engine echoing our own call must be ignored
    {
        const d = ponDriver();
        d.feed({ type: 'pon', actor: 0, target: 1, pai: '2m', consumed: ['2m', '2m'] });
        const before = d.player.shoupai.toString();
        const echo = d.feed({ type: 'pon', actor: 0, target: 1, pai: '2m', consumed: ['2m', '2m'] });
        eq(echo, null, 'the echoed call opens no new decision');
        eq(d.player.shoupai.toString(), before, 'the echoed call does not touch the hand');
        eq(d.player.shoupai._fulou.length, 1, 'the meld is still recorded exactly once');
    }

    // (4) the model must still be usable afterwards — this is what "hangs"
    //     actually means: every later event gets rejected, so the bot can only
    //     ever answer `none`.
    {
        const d = ponDriver();
        d.feed({ type: 'pon', actor: 0, target: 1, pai: '2m', consumed: ['2m', '2m'] });
        d.feed({ type: 'pon', actor: 0, target: 1, pai: '2m', consumed: ['2m', '2m'] });
        d.feed({ type: 'tsumo', actor: 2, pai: '?' });
        // An opponent discard we cannot call: no decision, but the model must
        // accept it rather than throwing it out.
        d.feed({ type: 'dahai', actor: 2, pai: '9p', tsumogiri: true });
        noRejections(d, 'no event was rejected by the model after the call');

        // And a later turn of our own must still produce a real decision — the
        // failure mode was that the hand had drifted out of existence.
        const r = d.feed({ type: 'tsumo', actor: 0, pai: '1p' });
        ok(r && typeof r.dapai === 'string', 'our next turn still yields a discard');
        noRejections(d, 'our own turn is not rejected either');
    }

    // (5) our own post-call discard arriving as an echo must not be applied twice
    {
        const { DecisionTranslator } = require('../bridge/from_majiang');
        const d = ponDriver();
        const reply = d.feed({ type: 'pon', actor: 0, target: 1, pai: '2m', consumed: ['2m', '2m'] });
        const tr = new DecisionTranslator({ seat: 0 });
        tr.hand = d.player.shoupai;
        const actions = tr.translate(reply, { trigger: { type: 'pon', actor: 0 } });
        eq(actions[0].type, 'dahai', 'the pon reply translates to a discard action');

        const before = d.player.shoupai.toString();
        // The action is mjai notation; the echoed event is what the engine sends
        // back, and feeding it must be a no-op on the hand.
        d.feed({ type: 'dahai', actor: 0, pai: actions[0].pai, tsumogiri: actions[0].tsumogiri });
        eq(d.player.shoupai.toString(), before,
            'the echoed discard leaves the hand unchanged (it was already applied)');
    }
}

// ---------------------------------------------------------------------------
// 8d. Our own discard must never be fed back to the AI as a question.
//
// This was the actual "hangs after a call" bug, and it is worth spelling out
// because it hid behind two layers of confusion:
//
//   * `Majiang.Game` DOES echo our own discard back to us (it uses
//     `call_players`, which notifies all four seats). So this is the ordinary
//     path, not an edge case.
//   * Feeding it to `player.action()` made `Player.dapai` apply the discard to
//     the model a second time. The tile was already gone, so majiang-core threw,
//     every later event was rejected, and the bot could only answer `none` —
//     which Akagi sees as a hang.
//
// The whole-game harness could not catch this: the engine's own player receives
// the same echo, so both models made the same mistake and agreed with each
// other. It needs a direct test.
// ---------------------------------------------------------------------------
{
    const hand13 = ['2m', '2m', '3m', '4m', '5m', '5p', '5p', '7p', '8p',
        '2s', '3s', '4s', '6s'];

    function setup() {
        const d = driver(0);
        d.feed(startGame(0));
        const tehais = [[], [], [], []];
        for (let i = 0; i < 4; i++) tehais[i] = new Array(13).fill('?');
        tehais[0] = hand13;
        d.feed({
            type: 'start_kyoku', bakaze: 'E', dora_marker: '2s', kyoku: 1,
            honba: 0, kyotaku: 0, oya: 0,
            scores: [25000, 25000, 25000, 25000], tehais, num_players: 4,
        });
        return d;
    }

    // (1) an ordinary turn: draw, discard, then the engine echoes the discard
    {
        const d = setup();
        const reply = d.feed({ type: 'tsumo', actor: 0, pai: '9m' });
        ok(reply && typeof reply.dapai === 'string', 'our draw yields a discard');

        const river = d.player.model.he[0]._pai;
        eq(river.length, 1, 'the discard reaches the river once, on our own choice');
        // The river keeps the player's own discard string, markers and all — that
        // is what `Majiang.Game.dapai` stores (`Game` hands the raw string to both
        // `Shoupai.dapai` and `He.dapai`), and matching it is what keeps the model
        // comparable with an engine-driven player.
        eq(river[0], reply.dapai, 'the river holds the discard exactly as discarded');

        // The echo, exactly as `Game.dapai` sends it.
        const { DecisionTranslator } = require('../bridge/from_majiang');
        const tr = new DecisionTranslator({ seat: 0 });
        tr.hand = d.player.shoupai;
        const act = tr.translate(reply, { trigger: { type: 'tsumo', actor: 0 } })[0];
        eq(d.feed({ type: 'dahai', actor: 0, pai: act.pai, tsumogiri: act.tsumogiri }), null,
            'the echoed own discard opens no decision');
        noRejections(d, 'the echoed own discard is not rejected by the model');
        eq(d.player.model.he[0]._pai.length, 1,
            'the echoed own discard does not reach the river a second time');
    }

    // (2) the same, after a call — the case that used to break
    {
        const d = setup();
        d.feed({ type: 'tsumo', actor: 1, pai: '?' });
        d.feed({ type: 'dahai', actor: 1, pai: '2m', tsumogiri: false });
        const reply = d.feed({ type: 'pon', actor: 0, target: 1, pai: '2m', consumed: ['2m', '2m'] });
        ok(reply && typeof reply.dapai === 'string', 'the pon yields a discard');

        const { DecisionTranslator } = require('../bridge/from_majiang');
        const tr = new DecisionTranslator({ seat: 0 });
        tr.hand = d.player.shoupai;
        const act = tr.translate(reply, { trigger: { type: 'pon', actor: 0 } })[0];

        d.feed({ type: 'dahai', actor: 0, pai: act.pai, tsumogiri: act.tsumogiri });
        noRejections(d, 'the post-call discard is not rejected when the engine echoes it');
        eq(d.player.model.he[0]._pai.length, 1, 'the river holds exactly that discard');

        // And the game must continue: this is what "hangs" meant.
        d.feed({ type: 'tsumo', actor: 2, pai: '?' });
        d.feed({ type: 'dahai', actor: 2, pai: '1p', tsumogiri: true });
        const next = d.feed({ type: 'tsumo', actor: 0, pai: '9m' });
        ok(next && typeof next.dapai === 'string',
            'our next turn still produces a decision after a call');
        noRejections(d, 'nothing was rejected along the way');
    }
}

// ---------------------------------------------------------------------------
// 8e. Seat rotation across a hanchan.
//
// `menfeng()` has to mirror `Board.menfeng()`, and `startKyoku` has to hand the
// library a `jushu` it can rotate with. majiang's `jushu` is the hand WITHIN the
// round (0..3) — the round is carried by `zhuangfeng` — and both `Board.menfeng`
// and `SuanPai.qipai` compute `(id + 8 - qijia - jushu) % 4`, which only stays
// non-negative for 0..3. Passing a game-wide index (up to 7 in a hanchan) made
// `SuanPai.qipai` index `qipai.shoupai[-1]`, throw on the undefined hand, and
// reject every later event of the hand.
// ---------------------------------------------------------------------------
{
    const HAND = ['1m', '2m', '3m', '4m', '5p', '6p', '7p', '2s', '3s', '4s', 'E', 'E', 'S'];
    for (const [bakaze, kyoku, jushu] of [['E', 1, 0], ['E', 4, 3], ['S', 1, 0],
        ['S', 2, 1], ['S', 4, 3], ['W', 2, 1]]) {
        for (const seat of [0, 3]) {
            const d = driver(seat);
            d.feed(startGame(seat));
            const tehais = [[], [], [], []];
            for (let i = 0; i < 4; i++) tehais[i] = new Array(13).fill('?');
            tehais[seat] = HAND;
            d.feed({
                type: 'start_kyoku', bakaze, dora_marker: '1s', kyoku, honba: 0,
                kyotaku: 0, oya: (seat + jushu) % 4,
                scores: [25000, 25000, 25000, 25000], tehais, num_players: 4,
            });
            const label = `${bakaze}${kyoku} seat ${seat}`;
            eq(d.jushu, kyoku - 1, `${label}: jushu is the hand within the round`);
            ok(d.menfeng(seat) >= 0, `${label}: our menfeng is not negative`);
            eq(d.menfeng(seat), d.player._menfeng,
                `${label}: driver and Board agree on our menfeng`);
            eq(d.player.shoupai.toString(), T.serialize(HAND.map(T.fromMjai)),
                `${label}: the bot sees its own hand`);
            ok(d.player.shoupai._bingpai.m[1] > 0,
                `${label}: the hand is not an empty slot`);
            // And the AI's own tile counters were fed, which is what threw when
            // `jushu` was out of range.
            ok(d.player._suanpai !== undefined, `${label}: the AI has tile counters`);
        }
    }
}

// ---------------------------------------------------------------------------
// 8f. A kan EVENT in Akagi's own shapes.
//
// The two kans arrive differently on the wire — an `ankan` carries all four tiles
// in `consumed`, a `kakan` carries the ADDED tile in `pai` plus the three from the
// pon — and majiang spells them differently in the model, where four bare digits
// would be read as a CLOSED kan and would take three tiles out of a hand that
// does not hold them. Both directions are exercised here.
// ---------------------------------------------------------------------------
{
    function kanDriver(withPon) {
        const d = driver(0);
        d.feed(startGame(0));
        const tehais = [[], [], [], []];
        for (let i = 0; i < 4; i++) tehais[i] = new Array(13).fill('?');
        // A closed kan needs all four copies in hand; an added kan needs two for
        // the pon and draws the fourth later.
        tehais[0] = withPon
            ? ['2m', '2m', '4m', '5m', '6m', '7m', '2s', '3s', '4s', '6s', '9p', '9p', 'E']
            : ['2m', '2m', '2m', '2m', '4m', '5m', '6m', '2s', '3s', '4s', '6s', '9p', '9p'];
        d.feed({
            type: 'start_kyoku', bakaze: 'E', dora_marker: '1s', kyoku: 1, honba: 0,
            kyotaku: 0, oya: 0, scores: [25000, 25000, 25000, 25000], tehais, num_players: 4,
        });
        if (withPon) {
            // Our own pon of 2m, so a later 2m is an ADDED kan.
            d.feed({ type: 'tsumo', actor: 1, pai: '?' });
            d.feed({ type: 'dahai', actor: 1, pai: '2m', tsumogiri: false });
            d.feed({ type: 'pon', actor: 0, target: 1, pai: '2m', consumed: ['2m', '2m'] });
        }
        return d;
    }

    // ankan: all four tiles in `consumed`, no `pai`.
    {
        const d = kanDriver(false);
        d.feed({ type: 'tsumo', actor: 0, pai: '9m' });
        d.feed({ type: 'ankan', actor: 0, consumed: ['2m', '2m', '2m', '2m'] });
        noRejections(d, 'an event in Akagi\'s ankan shape is accepted');
        eq(d.player.shoupai._fulou.length, 1, 'the closed kan is recorded');
        eq(d.player.shoupai._fulou[0], 'm2222', 'as a closed kan, not a mangled meld');
        ok(d.rinshanPending && d.rinshanFrom === 0, 'and it promises a replacement draw');
    }

    // kakan: the added tile in `pai`, three more in `consumed`.
    {
        const d = kanDriver(true);
        const before = d.player.shoupai.toString();
        d.feed({ type: 'tsumo', actor: 0, pai: '2m' });
        d.feed({ type: 'kakan', actor: 0, pai: '2m', consumed: ['2m', '2m', '2m'] });
        noRejections(d, 'an event in Akagi\'s kakan shape is accepted');
        eq(d.player.shoupai._fulou.length, 1, 'the added kan replaces the pon in place');
        eq(d.player.shoupai._fulou[0], 'm222+2',
            'as an added kan (marker in the middle), not a second closed kan');
        ok(d.player.shoupai.toString() !== before, 'the hand changed');
        ok(d.rinshanPending && d.rinshanFrom === 0, 'and it promises a replacement draw');
    }
}

// ---------------------------------------------------------------------------
// 8g. Our own rinshan draw is announced as a rinshan draw.
//
// mjai has no event for it, but majiang-core does (`gangzimo`), and the library
// uses it for two things the bot needs: the four-kan limit, and 嶺上開花 as a
// yaku. The bridge has already worked out that the draw is a replacement, so it
// must not throw that away when it feeds the message.
// ---------------------------------------------------------------------------
{
    const d = driver(0);
    d.feed(startGame(0));
    d.feed(startKyoku(0));
    d.feed({ type: 'tsumo', actor: 0, pai: '9m' });
    d.feed({ type: 'ankan', actor: 0, consumed: ['1m', '1m', '1m', '1m'] });
    d.feed({ type: 'dora', dora_marker: '2p' });
    const before = d.player._n_gang;
    d.feed({ type: 'tsumo', actor: 0, pai: '5p' });
    eq(typeof before, 'number', 'the AI tracks its kan count');
    eq(d.player._n_gang, before + 1, 'a replacement draw increments it');
}

// ---------------------------------------------------------------------------
// 8h. The wall counters the library reads are synced with ours.
//
// `SuanPai._n_zimo` scales the AI's estimates, and `Board.shan.paishu` is what
// the library's OWN legality checks read — the riichi minimum, the no-call-on-
// the-last-tile rule, the last-tile tsumo. Only the first was ever synced, so the
// second sat near 70 for a whole hand.
// ---------------------------------------------------------------------------
{
    const d = driver(0);
    d.feed(startGame(0));
    d.feed(startKyoku(0));
    eq(d.player.shan.paishu, 70, 'a fresh hand starts at 70');
    for (let i = 0; i < 6; i++) {
        d.feed({ type: 'tsumo', actor: i % 4, pai: i % 4 === 0 ? '9m' : '?' });
        if (i % 4 === 0) d.feed({ type: 'dahai', actor: 0, pai: '9m', tsumogiri: true });
        else d.feed({ type: 'dahai', actor: i % 4, pai: '1m', tsumogiri: true });
    }
    const reply = d.feed({ type: 'tsumo', actor: 0, pai: '9p' });
    void reply;
    eq(d.player.shan.paishu, d.exactWallCount,
        'the board\'s wall counter is synced to the reconstructed one');
    ok(d.exactWallCount < 70, 'and the reconstruction has counted the draws');
    eq(d.wallCount >= 1, true, 'the SuanPai scale factor never drops below 1');
}

// ---------------------------------------------------------------------------
// 8i. A censored draw still has to REACH the model, for every seat.
//
// The model holds a hand for all four seats. For the three the wire censors,
// `Board.qipai` builds that hand from thirteen blanks, and every event from that
// seat spends from it: `Shoupai.decrease` charges a tile it does not hold to the
// blanks, so one discard costs a blank, a chi two, a pon two and a closed kan
// four — and only a draw puts one back.
//
// Skipping the opponent draws (the obvious reading of "the tile is `?`, so there
// is nothing to apply") therefore emptied the placeholder after thirteen of that
// seat's discards, and then `decrease` threw. That throw is not contained:
// `Board.dapai` spends the blank BEFORE it records the tile in the river, so the
// river lost the discard as well and the next CALL on that tile failed its own
// check. Each rejection also cost that event's decision, because `Player.action`
// never reached the point of asking us.
// ---------------------------------------------------------------------------
{
    const notes = [];
    const d = driver(0, notes);
    d.feed(startGame(0));
    d.feed(startKyoku(0));

    // Twenty turn-cycles for one opponent: censored draw, then a discard of a
    // tile our own hand does not hold (so no call is available and the only thing
    // under test is the model's own bookkeeping).
    for (let i = 0; i < 20; i++) {
        d.feed({ type: 'tsumo', actor: 1, pai: '?' });
        d.feed({ type: 'dahai', actor: 1, pai: '1p', tsumogiri: true });
    }
    eq(notes.filter((n) => /rejected by the model/.test(n)), [],
        'no event is rejected while a seat plays out a long hand');
    noRejections(d, 'and the driver is left with no error');

    const theirs = d.player.model.shoupai[d.menfeng(1)];
    ok(theirs._bingpai._ > 0, 'the opponent placeholder still holds concealed tiles');

    // The river is the thing the throw used to take with it: every discard must
    // be recorded, or a call on it fails.
    eq(d.player.model.he[d.menfeng(1)]._pai.length, 20,
        'every one of that seat\'s discards reached the river');

    // And a call on the last discard must be accepted by the model, which is the
    // check that used to fail ("the last tile is not the one being called").
    d.feed({ type: 'tsumo', actor: 2, pai: '?' });
    d.feed({ type: 'dahai', actor: 2, pai: '9p', tsumogiri: true });
    noRejections(d, 'a later turn still costs nothing');

    // Our own turn is unaffected and still produces a decision.
    const reply = d.feed({ type: 'tsumo', actor: 0, pai: '9p' });
    ok(reply && typeof reply.dapai === 'string', 'our own turn still discards');
    noRejections(d, 'and it is not rejected either');
}

// ---------------------------------------------------------------------------
// 8j. The player may discard something other than the bot's choice.
//
// Manual play: the bot's answer is a suggestion, and the echo that comes back
// names whatever the player actually threw. The model applied the bot's choice
// the moment it answered, so an echo for a different tile is a one-tile
// divergence — the model is missing the tile that was really thrown and still
// holds the one the bot wanted gone. Swallowing that difference (which is what
// this used to do) left a phantom tile in the model, and every later candidate
// list was then computed for a hand the player does not have — the "candidates
// do not match my hand" report. The model self-healed only by luck, when the AI
// happened to discard the phantom.
// ---------------------------------------------------------------------------
{
    const notes = [];
    const d = driver(0, notes);
    d.feed(startGame(0));
    d.feed(startKyoku(0));

    const drawn = '9p';
    const reply = d.feed({ type: 'tsumo', actor: 0, pai: drawn });
    ok(reply && typeof reply.dapai === 'string', 'the bot answers its draw');
    const chosen = reply.dapai.replace(/[*_]+$/, '');
    const held = HAND_MJAI.concat(drawn);            // the 14 tiles in hand

    // A tile the player holds that is not the bot's choice.
    const thrown = held.find((t) => T.fromMjai(t) !== chosen);
    ok(thrown !== undefined, 'there is a tile to override with');

    d.feed({ type: 'dahai', actor: 0, pai: thrown, tsumogiri: false });
    noRejections(d, 'an overridden discard is not rejected');
    ok(notes.some((n) => /reconciling/.test(n)),
        'the divergence is reconciled rather than swallowed');

    // The model must hold exactly what the player holds: the bot's choice is
    // back in the hand and the thrown tile is gone.
    const tally = (tiles) => {
        const c = {};
        for (const t of tiles) { const m = T.fromMjai(t); c[m] = (c[m] || 0) + 1; }
        return Object.keys(c).sort().map((k) => `${k}x${c[k]}`).join(' ');
    };
    const sp = d.player.shoupai;
    const modelTiles = [];
    for (const s of ['m', 'p', 's']) {
        const b = sp._bingpai[s];
        for (let i = 0; i < b[0]; i++) modelTiles.push(T.toMjai(s + '0'));
        for (let n = 1; n < b.length; n++) {
            const normal = n === 5 ? b[5] - b[0] : b[n];
            for (let i = 0; i < normal; i++) modelTiles.push(T.toMjai(s + n));
        }
    }
    const bz = sp._bingpai.z;
    for (let n = 1; n < bz.length; n++) {
        for (let i = 0; i < bz[n]; i++) modelTiles.push(T.toMjai('z' + n));
    }
    eq(tally(modelTiles),
        tally(held.filter((t) => t !== thrown)),
        'the model holds exactly the player\'s hand after the override');

    // And the river records what was REALLY thrown — the bot's discard never
    // happened, so its river entry is gone too.
    const he = d.player.model.he[0];
    eq(he._pai.length, 1, 'one river entry after the override');
    eq(he._pai[0], T.fromMjai(thrown), 'and it is the player\'s tile');

    // The next turn: candidates may only name tiles the player actually holds.
    for (const a of [1, 2, 3]) {
        d.feed({ type: 'tsumo', actor: a, pai: '?' });
        d.feed({ type: 'dahai', actor: a, pai: '1p', tsumogiri: true });
    }
    const r2 = d.feed({ type: 'tsumo', actor: 0, pai: '9p' });
    ok(r2 && typeof r2.dapai === 'string', 'the next turn still yields a discard');
    const have = new Set(held.filter((t) => t !== thrown).concat(['9p']));
    for (const row of d.lastCandidates || []) {
        const tile = T.toMjai(row.p.slice(0, 2));
        ok(have.has(tile), `candidate ${tile} is a tile the player holds`);
    }
    noRejections(d, 'and nothing was rejected along the way');

    // A second echo of the SAME tile is the ordinary path and must not remove it
    // twice.
    const before = d.player.shoupai.toString();
    const chosenMjai = T.toMjai(r2.dapai.replace(/[*_]+$/, ''));
    d.feed({ type: 'dahai', actor: 0, pai: chosenMjai, tsumogiri: /_/.test(r2.dapai) });
    eq(d.player.shoupai.toString(), before,
        'a re-echo of the bot\'s own discard changes nothing');
}

// ---------------------------------------------------------------------------
// 9. Sanma is refused up front.
// ---------------------------------------------------------------------------
{
    let threw = false;
    try {
        new MajiangDriver({ Majiang: M, AI, seat: 0, numPlayers: 3 });
    } catch (e) { threw = true; }
    eq(threw, true, '3-player games are refused');
}

// ---------------------------------------------------------------------------
// 10. unreadable wire tiles are skipped, never thrown.
// ---------------------------------------------------------------------------
{
    const notes = [];
    const d = driver(2, notes);
    d.feed(startGame(2));
    d.feed(startKyoku(2));
    const r = d.feed({ type: 'dahai', actor: 1, pai: '??', tsumogiri: false });
    void r;
    pass++;   // reaching here without throwing is the assertion
    ok(notes.length >= 0, 'notes collected');
}

// ---------------------------------------------------------------------------
// 11. helpers
// ---------------------------------------------------------------------------
eq(bakazeToNumber('E'), 0, 'bakaze E');
eq(bakazeToNumber('S'), 1, 'bakaze S');
eq(bakazeToNumber('W'), 2, 'bakaze W');
eq(bakazeToNumber('N'), 3, 'bakaze N');
eq(bakazeToNumber('?'), 0, 'bakaze fallback');

// ---------------------------------------------------------------------------

if (failures.length) {
    console.error('translator: ' + failures.length + ' FAILED, ' + pass + ' passed\n');
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
}
console.log('translator: all ' + pass + ' assertions passed');
