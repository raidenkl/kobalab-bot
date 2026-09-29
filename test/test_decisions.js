/*
 *  test_decisions.js — unit tests for bridge/from_majiang.js.
 *
 *  Run: node test/test_decisions.js
 *
 *  This layer is pure translation, so it is cheap to pin down exactly — and it
 *  is worth pinning down, because the two mjai/majiang mismatches it bridges
 *  (called-tile ordering, and ron-vs-tsumo) are silent when wrong.
 */
'use strict';

const M = require('@kobalab/majiang-core');
const { DecisionTranslator, mianziTiles, canonical } = require('../bridge/from_majiang');
const T = require('../bridge/tiles');

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { pass++; return; }
    failures.push(`${label}\n      got  ${a}\n      want ${e}`);
}

function translator(seat, notes) {
    return new DecisionTranslator({ seat, onNote: (s) => { if (notes) notes.push(s); } });
}

const SEAT = 1;

// ---------------------------------------------------------------------------
// mianzi parsing helpers
// ---------------------------------------------------------------------------
eq(mianziTiles('z111+'), ['z1', 'z1', 'z1'], 'mianziTiles pon');
eq(mianziTiles('m123-'), ['m1', 'm2', 'm3'], 'mianziTiles chi');
eq(mianziTiles('p505='), ['p5', 'p0', 'p5'], 'mianziTiles chi with red five');
eq(mianziTiles('z1111+'), ['z1', 'z1', 'z1', 'z1'], 'mianziTiles open kan');
eq(mianziTiles('bogus'), null, 'mianziTiles rejects garbage');
eq(canonical('p0'), 'p5', 'canonical maps red five to five');
eq(canonical('p5'), 'p5', 'canonical leaves normal five');

// ---------------------------------------------------------------------------
// passes
// ---------------------------------------------------------------------------
{
    const t = translator(SEAT);
    const trigger = { type: 'tsumo', actor: SEAT, pai: '9p' };
    eq(t.translate(null, { trigger }), [{ type: 'none' }], 'null reply is none');
    eq(t.translate({}, { trigger }), [{ type: 'none' }], 'empty reply is none');
    eq(t.translate(undefined, { trigger }), [{ type: 'none' }], 'undefined reply is none');
}

// ---------------------------------------------------------------------------
// discards
// ---------------------------------------------------------------------------
{
    const t = translator(SEAT);
    const trigger = { type: 'tsumo', actor: SEAT, pai: '9p' };

    eq(t.translate({ dapai: 'p9_' }, { trigger }),
        [{ type: 'dahai', actor: SEAT, pai: '9p', tsumogiri: true }],
        'tsumogiri discard');

    eq(t.translate({ dapai: 'p9' }, { trigger }),
        [{ type: 'dahai', actor: SEAT, pai: '9p', tsumogiri: false }],
        'discard from hand');

    eq(t.translate({ dapai: 'm0_' }, { trigger }),
        [{ type: 'dahai', actor: SEAT, pai: '5mr', tsumogiri: true }],
        'red five discard maps to the mjai suffix form');

    eq(t.translate({ dapai: 'z3*' }, { trigger }),
        [{ type: 'reach', actor: SEAT, pai: 'W' }],
        'riichi is ONE action: the declaration carries the declaring discard');

    eq(t.translate({ dapai: 'z3**_' }, { trigger }),
        [{ type: 'reach', actor: SEAT, pai: 'W' }],
        'double riichi tsumogiri names the same tile');

    // Akagi's autoplay stalls on a `reach` that does not name the discard, so a
    // riichi the model cannot justify must not be sent at all.
    eq(t.translate({ dapai: 'z3*' }, { trigger, legal: ['dahai'] }),
        [{ type: 'none' }],
        'a riichi the model does not allow is refused outright');
}

// ---------------------------------------------------------------------------
// wins: ron vs tsumo is decided by the trigger, not by the reply
// ---------------------------------------------------------------------------
{
    const t = translator(SEAT);

    eq(t.translate({ hule: '-' }, { trigger: { type: 'tsumo', actor: SEAT, pai: '5p' } }),
        [{ type: 'hora', actor: SEAT, target: SEAT }],
        'tsumo wins on our own draw, target is our own seat');

    eq(t.translate({ hule: '-' }, { trigger: { type: 'dahai', actor: 2, pai: '5p' } }),
        [{ type: 'hora', actor: SEAT, target: 2 }],
        'ron wins off the discarder');

    eq(t.translate({ hule: '-' }, { trigger: { type: 'kakan', actor: 3, pai: '7s' } }),
        [{ type: 'hora', actor: SEAT, target: 3 }],
        'chankan wins off the kan player');

    // With no usable trigger the win is attributed to ourselves rather than
    // throwing: a mislabelled target is Recoverable, a crash is not.
    const r = t.translate({ hule: '-' }, { trigger: null });
    eq(r[0].type, 'hora', 'hora without a trigger still translates');
    eq(r[0].target, SEAT, 'hora without a trigger defaults to our own seat');

    eq(t.translate({ daopai: '-' }, { trigger: { type: 'tsumo', actor: SEAT, pai: '1m' } }),
        [{ type: 'ryukyoku' }],
        'abortive draw');
}

// ---------------------------------------------------------------------------
// calls
//
// The CALLED tile is the one the direction marker sits on, not the first digit:
// `m123-` is a chi on the 3, `m12-3` is a chi on the 2. mjai's `pai` is the
// discarded tile, so these two must come out differently.
// ---------------------------------------------------------------------------
{
    const t = translator(SEAT);

    eq(t.translate({ fulou: 'z111+' }, { trigger: { type: 'dahai', actor: 0, pai: 'E' } }),
        [{ type: 'pon', actor: SEAT, target: 0, pai: 'E', consumed: ['E', 'E'] }],
        'pon off the left player');

    eq(t.translate({ fulou: 'm123-' }, { trigger: { type: 'dahai', actor: 2, pai: '3m' } }),
        [{ type: 'chi', actor: SEAT, target: 2, pai: '3m', consumed: ['1m', '2m'] }],
        'chi on the highest tile names the discarded tile');

    eq(t.translate({ fulou: 'm12-3' }, { trigger: { type: 'dahai', actor: 2, pai: '2m' } }),
        [{ type: 'chi', actor: SEAT, target: 2, pai: '2m', consumed: ['1m', '3m'] }],
        'chi on the MIDDLE tile names the discarded tile');

    eq(t.translate({ fulou: 'm1-23' }, { trigger: { type: 'dahai', actor: 2, pai: '1m' } }),
        [{ type: 'chi', actor: SEAT, target: 2, pai: '1m', consumed: ['2m', '3m'] }],
        'chi on the lowest tile names the discarded tile');

    // A chi is only legal off the left-hand player, i.e. marker '-'.
    eq(t.translate({ fulou: 'm12-3' }, { trigger: { type: 'dahai', actor: 2, pai: '2m' } }),
        [{ type: 'chi', actor: SEAT, target: 2, pai: '2m', consumed: ['1m', '3m'] }],
        'chi target follows the trigger actor');

    const pon5 = t.translate({ fulou: 'p505=' }, { trigger: { type: 'dahai', actor: 3, pai: '5p' } });
    eq(pon5[0].type, 'pon', 'a pon is distinguished from a chi by tile equality');
    eq(pon5[0].pai, '5p', 'the called tile of a red-five pon is named');
    eq(pon5[0].consumed.slice().sort(), ['5p', '5pr'],
        'a red-five pon carries the red five in `consumed` (order is not meaningful)');

    eq(t.translate({ fulou: 'z1111+' }, { trigger: { type: 'dahai', actor: 0, pai: 'E' } }),
        [{ type: 'daiminkan', actor: SEAT, target: 0, pai: 'E', consumed: ['E', 'E', 'E'] }],
        'four tiles is an open kan');

    // No triggering discard means we cannot name a target, so the call is
    // dropped rather than sent with a guessed target.
    const notes = [];
    const t2 = translator(SEAT, notes);
    eq(t2.translate({ fulou: 'z111+' }, { trigger: null }), [{ type: 'none' }],
        'fulou without a trigger is refused');
    eq(notes.length > 0, true, 'the refusal is reported');
}

// ---------------------------------------------------------------------------
// kans
//
// Akagi's two kan actions have different shapes, and the lengths are fixed:
//   Kakan { pai, consumed: [3] }   Ankan { consumed: [4] }   (no `pai`)
// ---------------------------------------------------------------------------
{
    const t = translator(SEAT);

    eq(t.translate({ gang: 'z1111' }, { trigger: { type: 'tsumo', actor: SEAT, pai: '9p' } }),
        [{ type: 'ankan', actor: SEAT, consumed: ['E', 'E', 'E', 'E'] }],
        'closed kan lists all four tiles and names no called tile');

    // A kan of a tile we already hold a pon of is an ADDED kan — and majiang
    // spells that with its marker in the MIDDLE (`z111+1`), which used to be
    // unparseable.
    const t2 = translator(SEAT);
    t2.hand = M.Shoupai.fromString('m123p456s789z11,z111+');
    eq(t2.translate({ gang: 'z111+1' }, { trigger: { type: 'tsumo', actor: SEAT, pai: '9p' } }),
        [{ type: 'kakan', actor: SEAT, pai: 'E', consumed: ['E', 'E', 'E'] }],
        'added kan (mid-marker form) is detected from our own melds');

    // The same reply in the four-bare-digits spelling is the same kan.
    const t3 = translator(SEAT);
    t3.hand = M.Shoupai.fromString('m123p456s789z11,z111+');
    eq(t3.translate({ gang: 'z1111' }, { trigger: { type: 'tsumo', actor: SEAT, pai: '9p' } }),
        [{ type: 'kakan', actor: SEAT, pai: 'E', consumed: ['E', 'E', 'E'] }],
        'added kan (four-digit form) is detected from our own melds');

    // Without the pon it is a closed kan, whatever the digits look like.
    const t4 = translator(SEAT);
    t4.hand = M.Shoupai.fromString('m123p456s789z112z1');
    eq(t4.translate({ gang: 'z1111' }, { trigger: { type: 'tsumo', actor: SEAT, pai: '9p' } }),
        [{ type: 'ankan', actor: SEAT, consumed: ['E', 'E', 'E', 'E'] }],
        'no pon means a closed kan');
}

// ---------------------------------------------------------------------------
// legality gate
// ---------------------------------------------------------------------------
{
    const notes = [];
    const t = translator(SEAT, notes);
    const trigger = { type: 'tsumo', actor: SEAT, pai: '9p' };

    // Legal set that permits the discard: passed through.
    eq(t.translate({ dapai: 'p9_' }, { trigger, legal: ['dahai', 'reach'] }),
        [{ type: 'dahai', actor: SEAT, pai: '9p', tsumogiri: true }],
        'discard allowed by the legal set');

    // Legal set that does not: downgraded to none.
    const notes2 = [];
    const t2 = translator(SEAT, notes2);
    eq(t2.translate({ dapai: 'p9_' }, { trigger, legal: ['reach'] }),
        [{ type: 'none' }],
        'discard refused by the legal set');
    eq(notes2.some((n) => n.includes('refused')), true, 'the refusal is reported');

    // A refused discard must take its riichi down with it rather than emitting a
    // reach followed by nothing.
    const notes3 = [];
    const t3 = translator(SEAT, notes3);
    eq(t3.translate({ dapai: 'z3*' }, { trigger, legal: ['reach'] }),
        [{ type: 'none' }],
        'a refused riichi discard emits no reach');

    // Accepts objects as well as bare type strings.
    const t4 = translator(SEAT);
    eq(t4.translate({ dapai: 'p9_' }, { trigger, legal: [{ type: 'dahai' }] }),
        [{ type: 'dahai', actor: SEAT, pai: '9p', tsumogiri: true }],
        'legal set given as action objects');
}

// ---------------------------------------------------------------------------
// tile mapping sanity: every discard the AI can name must have a mjai form
// ---------------------------------------------------------------------------
{
    const t = translator(SEAT);
    const trigger = { type: 'tsumo', actor: SEAT, pai: '9p' };
    let bad = 0;
    for (const suit of ['m', 'p', 's']) {
        for (let n = 0; n <= 9; n++) {
            const r = t.translate({ dapai: suit + n }, { trigger });
            if (r[0].type !== 'dahai') bad++;
            else if (T.fromMjai(r[0].pai) !== suit + n) bad++;
        }
    }
    for (let n = 1; n <= 7; n++) {
        const r = t.translate({ dapai: 'z' + n }, { trigger });
        if (r[0].type !== 'dahai') bad++;
    }
    eq(bad, 0, 'every majiang tile round-trips through a discard');
}

// ---------------------------------------------------------------------------
// Every emitted action must fit Akagi's mjai schema.
//
// This is the check that was missing when the bridge emitted an `ankan` with
// three `consumed` tiles: Akagi's `Ankan { consumed: [Tile; 4] }` is a FIXED-SIZE
// array, so that reply does not deserialize and the whole turn is lost. Sizes and
// field names are asserted here, and any key Akagi's schema does not define is
// rejected — an unknown field is silently dropped by serde, which is how a wrong
// field name becomes a silently missing datum instead of an error.
// ---------------------------------------------------------------------------
{
    const SCHEMA = {
        dahai: { keys: ['type', 'actor', 'pai', 'tsumogiri'], consumed: null },
        chi: { keys: ['type', 'actor', 'target', 'pai', 'consumed'], consumed: 2 },
        pon: { keys: ['type', 'actor', 'target', 'pai', 'consumed'], consumed: 2 },
        daiminkan: { keys: ['type', 'actor', 'target', 'pai', 'consumed'], consumed: 3 },
        kakan: { keys: ['type', 'actor', 'pai', 'consumed'], consumed: 3 },
        ankan: { keys: ['type', 'actor', 'consumed'], consumed: 4 },
        reach: { keys: ['type', 'actor', 'pai'], consumed: null },
        hora: { keys: ['type', 'actor', 'target'], consumed: null },
        ryukyoku: { keys: ['type'], consumed: null },
        none: { keys: ['type'], consumed: null },
    };

    const cases = [
        [{ dapai: 'p9_' }, { type: 'tsumo', actor: SEAT, pai: '9p' }],
        [{ dapai: 'm0' }, { type: 'tsumo', actor: SEAT, pai: '9p' }],
        [{ dapai: 'z3*' }, { type: 'tsumo', actor: SEAT, pai: '9p' }],
        [{ fulou: 'z111+' }, { type: 'dahai', actor: 0, pai: 'E' }],
        [{ fulou: 'm123-' }, { type: 'dahai', actor: 2, pai: '3m' }],
        [{ fulou: 'm12-3' }, { type: 'dahai', actor: 2, pai: '2m' }],
        [{ fulou: 'p505=' }, { type: 'dahai', actor: 3, pai: '5p' }],
        [{ fulou: 'z1111+' }, { type: 'dahai', actor: 0, pai: 'E' }],
        [{ gang: 'z1111' }, { type: 'tsumo', actor: SEAT, pai: '9p' }],
        [{ hule: '-' }, { type: 'dahai', actor: 2, pai: '5p' }],
        [{ hule: '-' }, { type: 'tsumo', actor: SEAT, pai: '5p' }],
        [{ daopai: '-' }, { type: 'tsumo', actor: SEAT, pai: '1m' }],
    ];

    const t = translator(SEAT);
    t.hand = M.Shoupai.fromString('m123p456s789z11,z111+');
    const bad = [];
    for (const [reply, trigger] of cases) {
        for (const action of t.translate(reply, { trigger })) {
            const spec = SCHEMA[action.type];
            if (!spec) { bad.push(`${JSON.stringify(action)}: unknown type`); continue; }
            const extra = Object.keys(action).filter((k) => spec.keys.indexOf(k) === -1);
            if (extra.length) bad.push(`${action.type}: unexpected field(s) ${extra.join(',')}`);
            if (spec.consumed !== null
                && (!Array.isArray(action.consumed) || action.consumed.length !== spec.consumed)) {
                bad.push(`${action.type}: consumed must be ${spec.consumed} tiles, got `
                    + JSON.stringify(action.consumed));
            }
            const missing = spec.keys.filter((k) => action[k] === undefined);
            if (missing.length) bad.push(`${action.type}: missing ${missing.join(',')}`);
        }
    }
    eq(bad, [], 'every emitted action matches Akagi\'s schema');
}

// ---------------------------------------------------------------------------

if (failures.length) {
    console.error('decisions: ' + failures.length + ' FAILED, ' + pass + ' passed\n');
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
}
console.log('decisions: all ' + pass + ' assertions passed');
