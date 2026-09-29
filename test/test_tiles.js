/*
 *  test_tiles.js — unit tests for bridge/tiles.js.
 *
 *  Run: node test/test_tiles.js
 *
 *  Every assertion here exists because the corresponding mistake was either
 *  made during development or is a documented hazard of the two encodings.
 */
'use strict';

const T = require('../bridge/tiles');
const M = require('@kobalab/majiang-core');

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { pass++; return; }
    failures.push(`${label}: got ${a}, want ${e}`);
}

// ---------------------------------------------------------------------------
// mjai → majiang.  Input is "1m" / "5mr" / "E" style.
// ---------------------------------------------------------------------------
eq(T.fromMjai('1m'), 'm1', 'fromMjai 1m');
eq(T.fromMjai('9m'), 'm9', 'fromMjai 9m');
eq(T.fromMjai('9s'), 's9', 'fromMjai 9s');
eq(T.fromMjai('5m'), 'm5', 'fromMjai 5m is the NORMAL five');
eq(T.fromMjai('5mr'), 'm0', 'fromMjai 5mr is the red five');
eq(T.fromMjai('5pr'), 'p0', 'fromMjai 5pr');
eq(T.fromMjai('5sr'), 's0', 'fromMjai 5sr');
eq(T.fromMjai('E'), 'z1', 'fromMjai E');
eq(T.fromMjai('S'), 'z2', 'fromMjai S');
eq(T.fromMjai('W'), 'z3', 'fromMjai W');
eq(T.fromMjai('N'), 'z4', 'fromMjai N');
eq(T.fromMjai('P'), 'z5', 'fromMjai P (haku)');
eq(T.fromMjai('F'), 'z6', 'fromMjai F (hatsu)');
eq(T.fromMjai('C'), 'z7', 'fromMjai C (chun)');

// The two notations must NOT be interchangeable: a majiang token handed to
// fromMjai is rejected rather than reinterpreted.
eq(T.fromMjai('m1'), null, 'fromMjai rejects majiang notation');
eq(T.fromMjai('z5'), null, 'fromMjai rejects majiang honor');
eq(T.fromMjai('1x'), null, 'fromMjai bad suit');
eq(T.fromMjai('0m'), null, 'fromMjai 0 is not mjai notation');
eq(T.fromMjai('5xr'), null, 'fromMjai red five bad suit');
eq(T.fromMjai('5mrX'), null, 'fromMjai overlong');
eq(T.fromMjai(''), null, 'fromMjai empty');
eq(T.fromMjai(undefined), null, 'fromMjai undefined');
eq(T.fromMjai(null), null, 'fromMjai null');
eq(T.fromMjai(5), null, 'fromMjai number');
eq(T.fromMjai('X'), null, 'fromMjai unknown honor');
eq(T.fromMjai('?'), null, 'fromMjai hidden tile has no majiang form');

// ---------------------------------------------------------------------------
// majiang → mjai.  Input is "m1" / "m0" / "z5" style.
// ---------------------------------------------------------------------------
eq(T.toMjai('m1'), '1m', 'toMjai m1');
eq(T.toMjai('m5'), '5m', 'toMjai m5');
eq(T.toMjai('m0'), '5mr', 'toMjai m0 is a red five');
eq(T.toMjai('s9'), '9s', 'toMjai s9');
eq(T.toMjai('z1'), 'E', 'toMjai z1');
eq(T.toMjai('z5'), 'P', 'toMjai z5');
eq(T.toMjai('z7'), 'C', 'toMjai z7');
eq(T.toMjai('1m'), null, 'toMjai rejects mjai notation');
eq(T.toMjai('z8'), null, 'toMjai z8 out of range');
eq(T.toMjai('m0'), '5mr', 'toMjai m0');
eq(T.toMjai('0m'), null, 'toMjai suit must lead');
eq(T.toMjai(''), null, 'toMjai empty');
eq(T.toMjai('m'), null, 'toMjai bare suit');

// ---------------------------------------------------------------------------
// Round trip, driven from the mjai side (the direction the wire uses).
// ---------------------------------------------------------------------------
const WIRE_TILES = [
    '1m', '5m', '5mr', '9p', '5pr', '3s', '5sr',
    'E', 'S', 'W', 'N', 'P', 'F', 'C',
];
for (const t of WIRE_TILES) {
    const m = T.fromMjai(t);
    eq(T.toMjai(m), t, `round trip ${t}`);
}

// Round trip from the majiang side, over every legal tile.
for (const suit of ['m', 'p', 's']) {
    for (let n = 0; n <= 9; n++) {
        const t = suit + n;
        eq(T.fromMjai(T.toMjai(t)), t, `round trip ${t}`);
    }
}
for (let n = 1; n <= 7; n++) {
    eq(T.fromMjai(T.toMjai('z' + n)), 'z' + n, `round trip z${n}`);
}

// ---------------------------------------------------------------------------
// isTile is about the MAJIANG form.
// ---------------------------------------------------------------------------
eq(T.isTile('m1'), true, 'isTile m1');
eq(T.isTile('m0'), true, 'isTile m0');
eq(T.isTile('z7'), true, 'isTile z7');
eq(T.isTile('1m'), false, 'isTile rejects mjai form');
eq(T.isTile('?'), false, 'isTile rejects hidden');

// ---------------------------------------------------------------------------
// Serialization.
// ---------------------------------------------------------------------------
eq(T.serialize(['m1', 'm2', 'm3']), 'm123', 'serialize run');
eq(T.serialize(['m0', 'm5', 'm5']), 'm055', 'serialize red five sorts as 0');
eq(T.serialize(['z1', 's9', 'm1']), 'm1s9z1', 'serialize groups by suit');
eq(T.serialize(['m9', 'm1', 'm5']), 'm159', 'serialize sorts within suit');
eq(T.serialize(['m1', 'm1', 'm1', 'm1']), 'm1111', 'serialize quad repeats digit');
eq(T.serialize([]), '', 'serialize empty');

// THE critical property: whatever we serialize, majiang-core parses back to
// exactly the same string. A missing suit prefix would show up here.
const HANDS = [
    ['m1', 'm1', 'm1'],
    ['m0', 'm5'],
    ['z1', 'z2', 'z3', 'z4', 'z5', 'z6', 'z7'],
    ['m1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'z1', 'z1', 'z2', 'z2'],
    ['m1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'p1', 'p1', 'p1'],
];
for (const hand of HANDS) {
    const s = T.serialize(hand);
    eq(M.Shoupai.fromString(s).toString(), s, `majiang-core agrees with serialize(${hand.join(',')})`);
}

// A bare trailing suit letter is the documented silent-drop hazard. Prove the
// serialized form never has it: every suit letter must be followed by a digit.
for (const hand of HANDS) {
    const s = T.serialize(hand);
    const ok = /^([mpsz]\d+)*$/.test(s);
    eq(ok, true, `serialize emits well-formed groups for ${hand.join(',')}`);
}

// ---------------------------------------------------------------------------
// direction(): the marker majiang appends to a called tile, from (discarder,
// caller). A tile called off the player who plays immediately BEFORE the caller
// is '-'; that is the only marker a run can be called with.
// ---------------------------------------------------------------------------
eq(T.direction(0, 0), '', 'direction self (closed kan)');
eq(T.direction(1, 0), '+', 'from the caller\'s right (下家, plays after it)');
eq(T.direction(2, 0), '=', 'from across');
eq(T.direction(3, 0), '-', 'from the caller\'s left (上家, plays before it) — the chi side');

// ---------------------------------------------------------------------------
// mianziParts(): the marker identifies the CALLED tile, so position matters.
// ---------------------------------------------------------------------------
eq(T.mianziParts('z111+'), { called: 'z1', fromHand: ['z1', 'z1'], marker: '+' },
    'pon: the called tile heads the string');
eq(T.mianziParts('m123-'), { called: 'm3', fromHand: ['m1', 'm2'], marker: '-' },
    'chi on the highest tile: the called tile is last');
eq(T.mianziParts('m12-3'), { called: 'm2', fromHand: ['m1', 'm3'], marker: '-' },
    'chi on the middle tile: the marker is in the middle');
eq(T.mianziParts('m1-23'), { called: 'm1', fromHand: ['m2', 'm3'], marker: '-' },
    'chi on the lowest tile');
eq(T.mianziParts('z1111'), { called: 'z1', fromHand: ['z1', 'z1', 'z1'], marker: '' },
    'closed kan: no marker, all four tiles');
eq(T.mianziParts('z1111+'), { called: 'z1', fromHand: ['z1', 'z1', 'z1'], marker: '+' },
    'open kan');
eq(T.mianziParts('z111+1'), { called: 'z1', fromHand: ['z1', 'z1', 'z1'], marker: '+' },
    'ADDED kan: the marker is in the middle and the added tile is last');
eq(T.mianziParts('p505='), { called: 'p5', fromHand: ['p5', 'p0'], marker: '=' },
    'a pon holding the red five');
eq(T.mianziParts('bogus'), null, 'garbage is rejected');
eq(T.mianziParts('z111++'), null, 'two markers are rejected');
eq(T.mianziParts('+111'), null, 'a leading marker is rejected');
eq(T.mianziParts('z'), null, 'a bare suit is rejected');
eq(T.mianziParts(undefined), null, 'undefined is rejected');

// The same helper is asked about a DISCARD, because a card's heading names the
// tile that was thrown — and a discard is spelled with the tsumogiri and riichi
// suffixes. Those are not part of the tile; leaving them on failed the parse, so
// a tsumogiri's heading came out with no tile in it at all.
eq(T.mianziParts('p9_'), { called: 'p9', fromHand: [], marker: '' },
    'a tsumogiri discard');
eq(T.mianziParts('z3*'), { called: 'z3', fromHand: [], marker: '' },
    'a riichi discard (no tsumogiri)');
eq(T.mianziParts('m5_*'), { called: 'm5', fromHand: [], marker: '' },
    'a riichi tsumogiri discard');
eq(T.mianziParts('p0_'), { called: 'p0', fromHand: [], marker: '' },
    'a red five discarded off the draw');
eq(T.mianziParts('z1_**'), { called: 'z1', fromHand: [], marker: '' },
    'the whole suffix run is stripped');
// ... and a meld must be unaffected by that stripping.
eq(T.mianziParts('m123-'), { called: 'm3', fromHand: ['m1', 'm2'], marker: '-' },
    'a meld still parses after the discard suffixes are stripped');
eq(T.mianziParts('z111+1'), { called: 'z1', fromHand: ['z1', 'z1', 'z1'], marker: '+' },
    'so does an added kan');

// ---------------------------------------------------------------------------
// mianzi(): the marker must land on the CALLED tile, and the result must be the
// spelling `Shoupai.fulou`/`gang` accept (four digits in the wrong place would
// take the wrong tiles out of hand).
// ---------------------------------------------------------------------------
for (const [tiles, marker, want] of [
    [['m3', 'm1', 'm2'], '-', 'm123-'],
    [['m2', 'm1', 'm3'], '-', 'm12-3'],
    [['m1', 'm2', 'm3'], '-', 'm1-23'],
    [['z1', 'z1', 'z1'], '+', 'z111+'],
    [['z1', 'z1', 'z1', 'z1'], '', 'z1111'],
    // Red fives: the `0` keeps the place its value earns in the run, which is
    // how the library's own `get_chi_mianzi` spells these two.
    [['p0', 'p4', 'p6'], '-', 'p40-6'],
    [['p3', 'p4', 'p0'], '-', 'p3-40'],
    [['p7', 'p0', 'p6'], '-', 'p067-'],
]) {
    const m = T.mianzi(M, tiles, marker);
    eq(m, want, `mianzi(${tiles.join(',')}, '${marker}')`);
    eq(M.Shoupai.valid_mianzi(m), m, `... is a spelling the library accepts`);
}

// The called tile is whichever one is passed FIRST, whatever its rank.
eq(T.mianzi(M, ['m3', 'm4', 'm5'], '-'), 'm3-45', 'a run called on its lowest tile');
eq(T.mianzi(M, ['m5', 'm3', 'm4'], '-'), 'm345-', 'a run called on its highest tile');
eq(T.mianzi(M, ['z1', 'z2', 'z3'], '-'), null, 'honours cannot form a run');
eq(T.mianzi(M, ['m1', 'm2', 'm4'], '-'), null, 'a non-consecutive set is refused');
eq(T.mianzi(M, ['p0', 'p3', 'p5'], '-'), null, 'a duplicate five value is refused');

// A PON of a five: the marker must land on the copy that was CALLED, because
// `He.fulou` recovers the called tile from the marker's position and compares it
// against the discarder's river — `p5` and `p0` are different tiles to it. These
// are the library's own spellings (`Shoupai.get_peng_mianzi` writes the two from
// hand first and the called copy last).
eq(T.mianzi(M, ['p5', 'p5', 'p0'], '='), 'p505=',
    'pon of an ordinary 5p by a hand holding the red one: the marker stays on the 5');
eq(T.mianzi(M, ['p0', 'p5', 'p5'], '='), 'p550=',
    'pon of the RED 5p: the marker is on the 0, which is the tile that was called');
eq(T.mianzi(M, ['p0', 'p0', 'p5'], '='), 'p500=', 'pon of the red 5p, holding one of each');
eq(T.mianzi(M, ['p0', 'p0', 'p0'], '='), 'p000=', 'pon of the red 5p, holding three of them');
eq(T.mianzi(M, ['p5', 'p0', 'p5'], '='), 'p505=',
    'the from-hand copies are canonicalised, not kept in the caller\'s order');
for (const [tiles, want] of [
    [['p5', 'p5', 'p0'], ['p505=']],
    [['p0', 'p5', 'p5'], ['p550=']],
]) {
    const m = T.mianzi(M, tiles, '=');
    eq(want[0], m, `pon spelling for ${tiles.join(',')}`);
    // The proof that matters: the library must recover the called tile we meant.
    eq(T.mianziParts(m).called, tiles[0],
        '... and the marker identifies the tile that was called');
}
// A KAN keeps the library's own four-digit form (`valid_mianzi` re-sorts all four
// of them), so the marker's position among four identical spellings is free.
eq(T.mianzi(M, ['p5', 'p5', 'p5', 'p5'], '+'), 'p5555+', 'an open kan');
eq(T.mianzi(M, ['p0', 'p0', 'p0', 'p0'], '+'), 'p0000+', 'an open kan of the red five');
eq(T.mianzi(M, ['p5', 'p5', 'p5', 'p0'], ''), 'p5550',
    'a closed kan holding the red five (four digits, no marker)');

// ---------------------------------------------------------------------------
// canonical(): red fives compare as fives.
// ---------------------------------------------------------------------------
eq(T.canonical('p0'), 'p5', 'canonical maps a red five to five');
eq(T.canonical('p5'), 'p5', 'canonical leaves a normal five alone');
eq(T.canonical('m1'), 'm1', 'canonical leaves other tiles alone');

// ---------------------------------------------------------------------------
// order(): stable sort key.
// ---------------------------------------------------------------------------
eq(T.order('m1') < T.order('p1'), true, 'order m before p');
eq(T.order('p1') < T.order('s1'), true, 'order p before s');
eq(T.order('s1') < T.order('z1'), true, 'order s before z');
eq(T.order('m1') < T.order('m2'), true, 'order within suit');

// ---------------------------------------------------------------------------
// serialize rejects garbage loudly (it is a programming error, not wire data).
// ---------------------------------------------------------------------------
let threw = false;
try { T.serialize(['m1', 'bogus']); } catch (e) { threw = true; }
eq(threw, true, 'serialize throws on a bad tile');

// ---------------------------------------------------------------------------

if (failures.length) {
    console.error('tiles.js: ' + failures.length + ' FAILED, ' + pass + ' passed\n');
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
}
console.log('tiles.js: all ' + pass + ' assertions passed');
