/*
 *  tiles.js — mjai ⇄ majiang-core tile and hand notation.
 *
 *  Two tile encodings meet here and they are NOT interchangeable:
 *
 *    mjai   ("wire")  : the digit comes FIRST, then the suit —
 *                       "1m".."9m" | "1p".."9p" | "1s".."9s";
 *                       honors are "E" "S" "W" "N" (winds) and
 *                       "P" "F" "C" (haku / hatsu / chun);
 *                       a red five is a 3-char suffix form: "5mr"/"5pr"/"5sr";
 *                       an unknown/hidden tile is "?".
 *
 *    majiang ("model"): the suit letter comes FIRST, then one digit —
 *                       "m1", "p5", "s9". A red five is digit 0 ("m0"),
 *                       so "m5" and "m0" are different tiles.
 *                       Honors are z1..z7 in E S W N P F C order, i.e.
 *                       z5=白 z6=發 z7=中 — the same order mjai uses.
 *
 *  The honor orders agree, which is why the mapping is a plain table.
 *
 *  NOTE ON DIRECTION: `fromMjai` accepts mjai notation and returns majiang
 *  notation; `toMjai` is the inverse. Passing a majiang token to `fromMjai`
 *  yields null (and vice versa) — the two notations are deliberately not
 *  accepted interchangeably, so a mix-up surfaces as null instead of as a
 *  wrong tile.
 */
'use strict';

/** mjai honor letter → majiang honor digit. */
const MJAI_HONOR = { E: 1, S: 2, W: 3, N: 4, P: 5, F: 6, C: 7 };

/** majiang honor digit → mjai honor letter. Index 0 is unused. */
const MAJIANG_HONOR = ['', 'E', 'S', 'W', 'N', 'P', 'F', 'C'];

/** Suit letters shared by both notations, in sort order. */
const SUITS = ['m', 'p', 's', 'z'];

/** The mjai token for a hidden tile. */
const UNKNOWN = '?';

const isNumSuit = (c) => c === 'm' || c === 'p' || c === 's';

/**
 * mjai tile string → majiang tile string.
 *
 * Returns `null` for `"?"` (a hidden tile has no majiang representation, and
 * inventing one would corrupt the caller's tile pool) and for anything
 * unparseable, so callers get a single "no idea" signal.
 */
function fromMjai(t) {
    if (typeof t !== 'string') return null;
    if (t === UNKNOWN) return null;

    // Honor: a single letter.
    if (t.length === 1) {
        const n = MJAI_HONOR[t];
        return n ? 'z' + n : null;
    }

    if (t.length < 2) return null;
    // mjai puts the DIGIT first ("1m"); majiang puts the suit first ("m1").
    const digit = t[0];
    const suit = t[1];

    // Red five: "5mr" / "5pr" / "5sr".
    if (t.length === 3 && t[2] === 'r') {
        return digit === '5' && isNumSuit(suit) ? suit + '0' : null;
    }
    if (t.length !== 2) return null;

    if (!isNumSuit(suit)) return null;
    const n = +digit;
    return n >= 1 && n <= 9 ? suit + n : null;
}

/** majiang tile string → mjai tile string. `null` for unparseable input. */
function toMjai(t) {
    if (typeof t !== 'string' || t.length !== 2) return null;
    // majiang puts the suit FIRST ("m1"); mjai puts the digit first ("1m").
    const suit = t[0];
    const n = +t[1];

    if (suit === 'z') {
        return n >= 1 && n <= 7 ? MAJIANG_HONOR[n] : null;
    }
    if (!isNumSuit(suit)) return null;
    if (n === 0) return '5' + suit + 'r';
    return n >= 1 && n <= 9 ? n + suit : null;
}

/** True for a legal *majiang* tile string. */
function isTile(t) {
    return toMjai(t) !== null;
}

/**
 * The tile a red five stands in for (`p0` -> `p5`), for comparing "same tile"
 * across the 0/5 spelling. Everything else is returned unchanged.
 */
function canonical(t) {
    return t.length === 2 && t[1] === '0' ? t[0] + '5' : t;
}

/** Sort key: suit order m<p<s<z, then digit. Gives stable serialization. */
function order(t) {
    return SUITS.indexOf(t[0]) * 10 + (+t[1] || 0);
}

/**
 * Serialize majiang tiles into majiang's hand notation: one suit prefix per
 * suit, followed by that suit's digits — `m123456p123s4567`.
 *
 * This is the easiest thing in the whole bridge to get subtly wrong: writing a
 * bare `z` with no digits (`m123p123s456z`) is *accepted* by
 * `Shoupai.fromString` but silently drops the group, so a malformed hand looks
 * merely short rather than throwing. Emitting one prefix per non-empty suit
 * means we cannot produce that shape.
 *
 * Duplicate digits repeat for copies (`m111` = three 1m); a red five is `0`.
 */
function serialize(tiles) {
    const buckets = { m: [], p: [], s: [], z: [] };
    for (const t of tiles) {
        if (!isTile(t)) throw new Error('serialize: bad tile ' + JSON.stringify(t));
        buckets[t[0]].push(t);
    }
    let out = '';
    for (const suit of SUITS) {
        const list = buckets[suit];
        if (!list.length) continue;
        list.sort((a, b) => order(a) - order(b));
        out += suit + list.map((t) => t[1]).join('');
    }
    return out;
}

/**
 * The direction marker majiang appends to a called tile, from the *caller's*
 * point of view: `+` the tile came from the player to the caller's left, `=`
 * from across, `-` from the right, and `''` for a closed kan (self).
 *
 * `lunban` and `menfeng` are majiang seats (0 = self).
 */
function direction(lunban, menfeng) {
    return ['', '+', '=', '-'][(4 + lunban - menfeng) % 4];
}

/**
 * Build a mianzi (meld) string from its tiles, normalised by majiang-core.
 *
 * A mianzi is `<suit><digits>` with ONE direction marker, e.g. `z111+` (pon),
 * `m123-` (chi), `z1111+` (open kan), `z1111` (closed kan), `z111+1` (added
 * kan). Where the marker sits is not decoration: it identifies the CALLED tile,
 * and majiang-core reads it that way in both directions —
 *
 *   `Shoupai.fulou/gang` consumes every digit NOT followed by a marker
 *   (`m.match(/\d(?![\+\=\-])/g)`), and `He.fulou` reads the called tile as
 *   `m.match(/\d(?=[\+\=\-])/)`.
 *
 * So the marker MUST be attached to the tile the caller took, whatever position
 * that tile ends up in. For a pon/kan all digits are the same tile and only the
 * position of the marker differs; for a RUN the called tile can be the lowest,
 * middle or highest digit (see `Shoupai.get_chi_mianzi`), and it is the marker
 * that says which — `m123-` and `m12-3` are the same three tiles with DIFFERENT
 * called tiles. Appending the marker at the end (the obvious thing to do) is
 * therefore only correct for a chi on the highest tile; for the other two the
 * model would consume the wrong tiles out of hand.
 *
 * Red fives make the string form non-obvious as well: the library's own spelling
 * puts the `0` wherever the red five sits in the run (`p34-0`, `p067-`), and
 * `valid_mianzi` only accepts its own canonical spelling. Rather than model all
 * of that, this offers `valid_mianzi()` the candidate this function builds and
 * returns it only if the library agrees with it (`valid_mianzi(x) === x`), which
 * is exactly the test `Shoupai.fulou/gang` apply later.
 *
 * @param {object} Majiang  the @kobalab/majiang-core module
 * @param {string[]} tiles  majiang tiles; for a call, the CALLED tile first
 * @param {string} marker   '', '+', '=' or '-'
 * @returns {string|null}
 */
function mianzi(Majiang, tiles, marker) {
    if (!Array.isArray(tiles) || tiles.length < 3 || tiles.length > 4) return null;
    const suit = tiles[0][0];
    if (!tiles.every((t) => typeof t === 'string' && t.length === 2 && t[0] === suit)) {
        return null;
    }

    const digits = tiles.map((t) => t[1]);
    const h = digits.map((d) => (d === '0' ? '5' : d));
    const sorted = h.slice().sort();
    const isSet = sorted.every((d) => d === sorted[0]);

    if (isSet) {
        // A set is spelled `<the copies from hand><the CALLED tile><marker>`: the
        // called tile comes LAST and carries the marker. That is how the library
        // writes it — `Shoupai.get_peng_mianzi` emits `s50` + `5` + `=` for a pon
        // of an ordinary five by a hand that also holds the red one, and `s55` +
        // `0` + `=` when the RED five is the one being called — and the position
        // is load-bearing rather than cosmetic: `He.fulou` recovers the called tile
        // as "the digit the marker follows" and compares it against the
        // discarder's river. A pon of the ordinary 5s spelled with the marker on
        // the red one fails that check, so the call is dropped (and so is the
        // added kan that would extend it).
        //
        // The copies from hand are ordered the way the library canonicalises them:
        // ordinary fives before red ones. Without that, `valid_mianzi` rewrites the
        // string to its own order and the equality test below rejects every
        // red-five mix.
        //
        // Only for THREE tiles. A kan's four digits are re-sorted wholesale by
        // `valid_mianzi` (and all four are the same spelling when a called tile is
        // involved), so ordering them here would produce a string the library then
        // reorders again — i.e. a candidate that fails the same equality test.
        const spelled = digits.length === 3
            ? suit + digits.slice(1).sort().reverse().join('') + digits[0] + marker
            : suit + digits.join('') + marker;
        const normalized = Majiang.Shoupai.valid_mianzi(spelled);
        return normalized === spelled ? spelled : null;
    }

    // A run: three consecutive digits, which is exactly what the library would
    // check, so mirror that check and emit the tiles in the order the library
    // writes them — ascending, with a red five counted as a five.
    if (digits.length !== 3) return null;
    if (suit === 'z') return null;
    if (Number(sorted[0]) + 1 !== Number(sorted[1])
        || Number(sorted[1]) + 1 !== Number(sorted[2])) return null;

    // Ascending by tile value, carrying the marker on the CALLED tile. A run has
    // three distinct values, so a red five and a normal five can never both be
    // in it and the order is unambiguous.
    const out = digits
        .map((d, i) => ({ digit: d, value: d === '0' ? 5 : Number(d), called: i === 0 }))
        .sort((a, b) => a.value - b.value)
        .map((t) => t.digit + (t.called ? marker : ''))
        .join('');

    const candidate = suit + out;
    return Majiang.Shoupai.valid_mianzi(candidate) === candidate ? candidate : null;
}

/**
 * Split a mianzi into the tile that was called and the tiles that came from
 * hand, reading the marker to tell which digit was the called one.
 *
 * Split by MARKER POSITION, not by position in the string: `z111+` and `m123-`
 * are the familiar "called tile first" shapes, but a chi on the middle tile is
 * `m12-3` and an added kan is `z111+1` — the called tile is whichever digit the
 * marker follows. Assuming "index 0 is the called tile" mislabels two of the
 * three chi shapes and every added kan.
 *
 * @returns {{called: string, fromHand: string[], marker: string}|null}
 */
function mianziParts(mianziStr) {
    if (typeof mianziStr !== 'string') return null;
    // Strip the DISCARD suffix first. The card headings ask this helper about a
    // discard as well as about a meld (they name the tile that was thrown), and a
    // discard is spelled as a bare tile followed by any run of `_` (tsumogiri)
    // and `*` (riichi) — `p9_`, `z3*`, `z3_*`. Those markers are not part of the
    // tile, and leaving them on fails the parse below, which is how a tsumogiri
    // ended up with no tile in its heading at all. A meld never ends in `_` or
    // `*`, and never in more than one marker, so this cannot swallow a direction:
    // `m123-` and `z111+1` are untouched.
    mianziStr = mianziStr.replace(/[*_]+$/, '');
    if (mianziStr.length < 2) return null;
    const suit = mianziStr[0];
    if (SUITS.indexOf(suit) === -1) return null;

    const digits = [];
    let marker = '';
    let markedDigit = -1;
    for (const c of mianziStr.slice(1)) {
        if (c === '+' || c === '=' || c === '-') {
            // Exactly one marker, and it always follows the called digit.
            if (marker) return null;
            if (!digits.length) return null;
            marker = c;
            markedDigit = digits.length - 1;
            continue;
        }
        if (!/\d/.test(c)) return null;
        digits.push(c);
    }
    if (!digits.length) return null;

    // No marker means a closed kan, whose tiles are all the same, so the first
    // digit is as good as any.
    const calledIndex = marker ? markedDigit : 0;
    return {
        called: suit + digits[calledIndex],
        fromHand: digits.filter((_, i) => i !== calledIndex).map((d) => suit + d),
        marker,
    };
}

module.exports = {
    fromMjai,
    toMjai,
    isTile,
    canonical,
    serialize,
    direction,
    mianzi,
    mianziParts,
    order,
    UNKNOWN,
    SUITS,
};
