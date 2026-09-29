/*
 *  test_bridge.js — end-to-end tests for bridge/main.js.
 *
 *  Run: node test/test_bridge.js
 *
 *  These drive the whole bridge the way Akagi does — batches of mjai events in,
 *  one JSON action out — and assert the properties that keep the protocol alive:
 *  exactly one reply per batch, always valid JSON, and a `none` rather than a
 *  crash when something goes wrong.
 */
'use strict';

const { Bridge, ruleFor } = require('../bridge/main');

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

/** A bridge whose output is collected instead of printed. */
function makeBridge(seat) {
    const out = [];
    const bridge = new Bridge({ seat, emit: (line) => out.push(line) });
    return { bridge, out };
}

const START_GAME = { type: 'start_game', names: ['a', 'b', 'c', 'd'], id: 2, num_players: 4 };

function startKyoku(seat, hand) {
    const tehais = [[], [], [], []];
    for (let i = 0; i < 4; i++) tehais[i] = new Array(13).fill('?');
    tehais[seat] = hand;
    return {
        type: 'start_kyoku',
        bakaze: 'E',
        dora_marker: '1s',
        kyoku: 1,
        honba: 0,
        kyotaku: 0,
        oya: seat,
        scores: [25000, 25000, 25000, 25000],
        tehais,
        num_players: 4,
    };
}

// m13579 p2468 s1357 — a genuine 4-shanten, so a draw cannot complete it.
const HAND = ['1m', '3m', '5m', '7m', '9m', '2p', '4p', '6p', '8p', '1s', '3s', '5s', '7s'];

// ---------------------------------------------------------------------------
// 1. Every batch yields exactly one valid action.
// ---------------------------------------------------------------------------
{
    const { bridge } = makeBridge(2);
    const batches = [
        [START_GAME],
        [startKyoku(2, HAND)],
        [{ type: 'tsumo', actor: 3, pai: '?' }, { type: 'dahai', actor: 3, pai: '2s', tsumogiri: true }],
        [{ type: 'tsumo', actor: 0, pai: '?' }, { type: 'dahai', actor: 0, pai: '6p', tsumogiri: true }],
        [{ type: 'tsumo', actor: 1, pai: '?' }, { type: 'dahai', actor: 1, pai: '9s', tsumogiri: true }],
        [{ type: 'tsumo', actor: 2, pai: '4m' }],
    ];
    let n = 0;
    for (const b of batches) {
        const reaction = bridge.handleBatch(b);
        n++;
        ok(reaction && typeof reaction.type === 'string',
            `batch ${n} produced an action with a type`);
        // Must be JSON-serialisable: that is what goes on the wire.
        const line = JSON.stringify(reaction);
        ok(line.startsWith('{'), `batch ${n} serialises to an object`);
    }
    eq(bridge.decisions > 0, true, 'at least one decision was made');
}

// ---------------------------------------------------------------------------
// 2. Our own draw produces a discard, and the reply is a legal action.
// ---------------------------------------------------------------------------
{
    const { bridge } = makeBridge(2);
    bridge.handleBatch([START_GAME]);
    bridge.handleBatch([startKyoku(2, HAND)]);
    const r = bridge.handleBatch([{ type: 'tsumo', actor: 2, pai: '4m' }]);
    eq(r.type, 'dahai', 'own draw yields a discard');
    ok(/^[1-9][mps]$/.test(r.pai), `discard names a real tile (${r.pai})`);
    eq(typeof r.tsumogiri, 'boolean', 'tsumogiri is an explicit boolean');
    eq(r.actor, 2, 'actor is the bot');
}

// ---------------------------------------------------------------------------
// 3. An opponent turn with no call available yields `none`, and does so without
//    leaving the bridge in a bad state.
// ---------------------------------------------------------------------------
{
    const { bridge } = makeBridge(2);
    bridge.handleBatch([START_GAME]);
    bridge.handleBatch([startKyoku(2, HAND)]);
    const r = bridge.handleBatch([
        { type: 'tsumo', actor: 0, pai: '?' },
        { type: 'dahai', actor: 0, pai: '3p', tsumogiri: true },
    ]);
    eq(r.type, 'none', 'an uncallable opponent discard yields none');

    // Still healthy afterwards.
    const r2 = bridge.handleBatch([{ type: 'tsumo', actor: 2, pai: '4m' }]);
    eq(r2.type, 'dahai', 'the bridge still answers its own turn');
}

// ---------------------------------------------------------------------------
// 4. A HUD card is attached to a real decision, and only to a real decision.
// ---------------------------------------------------------------------------
{
    const { bridge } = makeBridge(2);
    bridge.handleBatch([START_GAME]);
    bridge.handleBatch([startKyoku(2, HAND)]);
    const r = bridge.handleBatch([{ type: 'tsumo', actor: 2, pai: '4m' }]);
    ok(r.meta && r.meta.show && Array.isArray(r.meta.show.items),
        'a discard decision carries a meta.show card');
    ok(r.meta.show.items.length > 0, 'the card has rows');
    ok(r.meta.show.items.length <= 5, 'the card is capped at 5 rows');
    // The chosen tile must be the first row: the rows are ranked, and the AI
    // returns the highest-ranked candidate.
    const chosen = r.pai;
    eq(r.meta.show.items[0].pais[0], chosen, 'the chosen tile heads the card');

    const none = bridge.handleBatch([
        { type: 'tsumo', actor: 1, pai: '?' },
        { type: 'dahai', actor: 1, pai: '9s', tsumogiri: true },
    ]);
    eq(none.type, 'none', 'a non-decision is none');
    eq(none.meta, undefined, 'a non-decision carries NO card');
}

// ---------------------------------------------------------------------------
// 5. Malformed input never kills the bridge and never skips a reply.
// ---------------------------------------------------------------------------
{
    const { bridge } = makeBridge(2);

    const junk = [
        null,
        undefined,
        'not an array',
        42,
        [null, undefined, 7],
        [{ noType: true }],
        [{ type: 'unknown_event_type' }],
        [{ type: 'dahai', actor: 'nonsense', pai: 'zzz' }],
        [{ type: 'tsumo', actor: 2, pai: '???' }],
    ];
    for (const j of junk) {
        let r;
        try {
            r = bridge.handleBatch(j);
        } catch (e) {
            failures.push(`handleBatch threw on ${JSON.stringify(j)}: ${e.message}`);
            continue;
        }
        ok(r && typeof r.type === 'string',
            `malformed input ${JSON.stringify(j)} still yields an action`);
    }
}

// ---------------------------------------------------------------------------
// 6. A 3-player game is refused, with `none` rather than a crash.
// ---------------------------------------------------------------------------
{
    const { bridge } = makeBridge(0);
    const r = bridge.handleBatch([
        { type: 'start_game', names: ['a', 'b', 'c'], id: 0, num_players: 3 },
    ]);
    eq(r.type, 'none', 'sanma yields none');
    // And it keeps answering.
    const r2 = bridge.handleBatch([{ type: 'tsumo', actor: 0, pai: '1m' }]);
    eq(r2.type, 'none', 'a refused game keeps replying none');
}

// ---------------------------------------------------------------------------
// 7. end_game is tolerated.
// ---------------------------------------------------------------------------
{
    const { bridge } = makeBridge(2);
    bridge.handleBatch([START_GAME]);
    bridge.handleBatch([startKyoku(2, HAND)]);
    const r = bridge.handleBatch([{ type: 'end_game' }]);
    eq(r.type, 'none', 'end_game yields none');
    eq(bridge.ended, true, 'end_game is recorded');
}

// ---------------------------------------------------------------------------
// 8. Lots of turns in a row: the bridge must not desynchronise.
//
// The scripted game has to be internally consistent or majiang-core rejects
// events as impossible (four copies of a tile, a discard of a tile the player
// does not hold). So the bot's own draws come from a pool that opponents never
// touch, and opponents only ever discard tiles the bot cannot be holding.
// ---------------------------------------------------------------------------
{
    const { bridge } = makeBridge(2);
    bridge.handleBatch([START_GAME]);
    bridge.handleBatch([startKyoku(2, HAND)]);

    // Tiles the bot cannot hold, so an opponent discarding them is always legal.
    const oppPool = ['9m', '9p', '9s', 'E', 'S', 'W', 'N', 'P', 'F', 'C',
        '1p', '4s', '6m', '2s', '8m'];
    // The bot draws from its own list; repeats are fine because a tile it has
    // already discarded can be drawn again only if copies remain, and this only
    // needs to stay plausible, not exhaustive.
    const ownPool = ['2m', '5m', '8m', '3p', '7p', '1s', '4s', '7s', '2m', '2m'];

    let actor = 2;
    let bad = 0;
    let oi = 0;
    let bi = 0;

    for (let turn = 0; turn < 40; turn++) {
        if (actor === 2) {
            const tile = ownPool[bi++ % ownPool.length];
            const r = bridge.handleBatch([{ type: 'tsumo', actor: 2, pai: tile }]);
            if (!r || typeof r.type !== 'string') bad++;
            if (r.type === 'dahai') {
                // Echo our own discard, as Akagi does.
                const echo = bridge.handleBatch([
                    { type: 'dahai', actor: 2, pai: r.pai, tsumogiri: r.tsumogiri },
                ]);
                if (!echo || typeof echo.type !== 'string') bad++;
            }
        } else {
            const tile = oppPool[oi++ % oppPool.length];
            const r = bridge.handleBatch([
                { type: 'tsumo', actor, pai: '?' },
                { type: 'dahai', actor, pai: tile, tsumogiri: true },
            ]);
            if (!r || typeof r.type !== 'string') bad++;
        }
        actor = (actor + 1) % 4;
    }
    eq(bad, 0, 'forty turns of alternating play stayed consistent');
}

// ---------------------------------------------------------------------------
// 8b. A declined call must still be explained.
//
// The AI is conservative: most call windows end in a pass, and `select_fulou`
// does not record the calls it rejects — so before this, the overlay showed
// nothing at all and a player reasonably concluded the bot never considered the
// call. These tests pin down both halves: that a pass on a callable tile is
// explained, and that an ordinary uncallable discard stays silent.
// ---------------------------------------------------------------------------
{
    // Two 3s in hand, and the opponent discards the third: a legal pon exists.
    // The AI weighs it and declines (calling would strip the pair it needs).
    const callableHand = ['3s', '3s', '1m', '2m', '3m', '5p', '6p', '7p',
        '2s', '4s', '6s', '9p', '9p'];
    const { bridge } = makeBridge(0);
    bridge.handleBatch([{ type: 'start_game', names: ['a', 'b', 'c', 'd'], id: 0, num_players: 4 }]);
    bridge.handleBatch([startKyoku(0, callableHand, '2s')]);
    // Seat 2 discards 3s: we hold two of them, so pon is available.
    const r = bridge.handleBatch([{ type: 'dahai', actor: 2, pai: '3s', tsumogiri: false }]);

    eq(r.type, 'none', 'the AI declines this pon (its own evaluation prefers passing)');
    ok(r.meta && r.meta.show, 'a declined call still carries a card');
    ok(Array.isArray(r.meta.show.items) && r.meta.show.items.length >= 2,
        'the card compares passing against at least one call');
    eq(r.meta.show.items[0].label, '不鸣 (Pass)', 'the pass row comes first');
    ok(r.meta.show.items.some((i) => i.label && i.label.indexOf('碰') === 0),
        'the declined pon is listed');
    ok(String(r.meta.show.title).indexOf('鸣牌判断') === 0,
        'the card is titled as a call judgement');
    // The tile named in the heading is the OPPONENT's discard — the one we were
    // offered — not a discard of ours. The two cards must not read alike, and
    // they did: "打 3s" on a call window reads as advice to throw 3s, which is
    // most misleading exactly when the hand does not hold that tile at all.
    ok(String(r.meta.show.title).indexOf('对方打 3s') > 0,
        'the heading says whose discard the named tile is');
    eq(/（不鸣，打 /.test(String(r.meta.show.title)), false,
        'the heading never presents the opponent\'s discard as a discard of ours');
    // The declined call must be shown as WORSE than passing here, so the colour
    // is the "not worth it" one rather than the "you missed one" one.
    const ponRow = r.meta.show.items.find((i) => i.label && i.label.indexOf('碰') === 0);
    eq(ponRow.color, '#ff5555', 'a strictly worse call is marked red');
}

{
    // An uncallable discard: 7z / "C" (chun, the red dragon) when we hold none of
    // it, so there is no decision to explain and the overlay must stay silent.
    // NB the wire spelling is mjai's ("C"); "7z" would be mahjong notation and the
    // bridge would reject it as unreadable before reaching the call logic.
    const { bridge } = makeBridge(0);
    bridge.handleBatch([{ type: 'start_game', names: ['a', 'b', 'c', 'd'], id: 0, num_players: 4 }]);
    bridge.handleBatch([startKyoku(0, HAND, '2s')]);
    const r = bridge.handleBatch([{ type: 'dahai', actor: 2, pai: 'C', tsumogiri: false }]);
    eq(r.type, 'none', 'an uncallable discard is none');
    eq(r.meta, undefined, 'an uncallable discard carries NO card');
}

{
    // A call the AI DOES take must be unaffected by the new path: the action is
    // the call itself, and the card comes from the ranked-candidates list.
    const ponHand = ['2m', '2m', '3m', '4m', '5m', '5p', '5p', '7p', '8p',
        '2s', '3s', '4s', '6s'];
    const { bridge } = makeBridge(0);
    bridge.handleBatch([{ type: 'start_game', names: ['a', 'b', 'c', 'd'], id: 0, num_players: 4 }]);
    bridge.handleBatch([startKyoku(0, ponHand, '2s')]);
    const r = bridge.handleBatch([{ type: 'dahai', actor: 1, pai: '2m', tsumogiri: false }]);
    eq(r.type, 'pon', 'a call the AI likes is still emitted as a call');
    eq(r.pai, '2m', 'the called tile is named');
    ok(r.meta && r.meta.show && String(r.meta.show.title).indexOf('鸣牌候选') === 0,
        'a taken call shows the ranked-candidates card, not the decline card');
}

// ---------------------------------------------------------------------------
// 8c. A decision must survive a batch that carries events after it.
//
// `driver.asked` marks the event that opened a decision. It used to be reset only
// inside the driver's decision machinery, which made it sticky: once one decision
// had been taken, every later event of the same batch was attributed to that
// reply and the batch answered `none` — dropping a decision the model had ALREADY
// applied (the hand, the river and the riichi flag were all updated), so the
// engine and the bridge disagreed from that point on.
// ---------------------------------------------------------------------------
{
    const { bridge } = makeBridge(2);
    bridge.handleBatch([START_GAME]);
    bridge.handleBatch([startKyoku(2, HAND)]);

    const only = bridge.handleBatch([{ type: 'tsumo', actor: 2, pai: '4m' }]);
    eq(only.type, 'dahai', 'a batch ending at the decision yields the discard');

    const withDora = bridge.handleBatch([
        { type: 'tsumo', actor: 2, pai: '4m' },
        { type: 'dora', dora_marker: '2s' },
    ]);
    eq(withDora.type, 'dahai', 'a trailing dora event does not swallow the decision');

    const withBoundary = bridge.handleBatch([
        { type: 'tsumo', actor: 2, pai: '4m' },
        { type: 'end_kyoku' },
    ]);
    eq(withBoundary.type, 'dahai', 'a trailing hand boundary does not swallow it either');

    // A batch with no decision at all is still `none`, not a stale trigger.
    const none = bridge.handleBatch([{ type: 'dora', dora_marker: '3s' }]);
    eq(none.type, 'none', 'a batch with no decision answers none');
    eq(none.meta, undefined, 'and carries no card');
}

// ---------------------------------------------------------------------------
// 9. ruleFor
// ---------------------------------------------------------------------------
{
    const tenhou = ruleFor('tenhou');
    const majsoul = ruleFor('majsoul');
    // Both floors use head-bump. The library's own default is 2 (double ron),
    // which is neither Tenhou's rule nor Majsoul's, so the presets have to say
    // so explicitly.
    eq(tenhou['最大同時和了数'], 1, 'tenhou presumes head-bump (no double ron)');
    eq(majsoul['最大同時和了数'], 1, 'majsoul presumes head-bump too');
    eq(majsoul['喰い替え許可レベル'], 2, 'majsoul allows kuikae');
    eq(tenhou['喰い替え許可レベル'], 0, 'tenhou forbids kuikae (the library default)');
    // The axes that do NOT differ — kept explicit so the presets stop being
    // described as differing where they do not.
    eq(tenhou['クイタンあり'], majsoul['クイタンあり'], 'kuitan is the same on both');
    eq(JSON.stringify(tenhou['赤牌']), JSON.stringify(majsoul['赤牌']),
        'red fives are the same on both');
    eq(ruleFor(undefined)['最大同時和了数'], tenhou['最大同時和了数'],
        'an unknown preset falls back to tenhou');
}

// ---------------------------------------------------------------------------

if (failures.length) {
    console.error('bridge: ' + failures.length + ' FAILED, ' + pass + ' passed\n');
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
}
console.log('bridge: all ' + pass + ' assertions passed');
