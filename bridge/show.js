/*
 *  show.js — build Akagi's structured HUD card (`meta.show`) from the AI's
 *  candidate evaluation.
 *
 *  Akagi renders `meta.show` as a titled list of rows and treats the rest of
 *  `meta` as opaque debug data. The rule that matters, taken from Akagi's own bot
 *  documentation, is:
 *
 *      the card changes exactly when the bot chose something, and never
 *      otherwise.
 *
 *  So this module only produces a card for a decision the bot actually made.
 *  Attaching one to a filler `none` — an opponent's discard we cannot call, a
 *  draw that is not ours — makes the HUD flicker through the whole hand and,
 *  worse, leaves stale advice on screen that reads as live.
 *
 *  `@kobalab/majiang-ai` supplies the raw material for free: its
 *  `select_dapai(info)` and `select_fulou(dapai, info)` push entries of
 *  `{p, n_xiangting, ev, n_tingpai, weixian}` (discards) or `{m, n_xiangting, ev}`
 *  (calls). Two things about that array are easy to get wrong:
 *
 *   1. It is NOT in `ev` order, even though `select_dapai` returns the highest
 *      `ev` candidate. The rows are sorted here, or the recommendation would not
 *      be the first line on screen.
 *   2. `ev` is an expected-VALUE estimate — the same quantity the AI compares
 *      against thresholds like 350 (riichi) and 750 (calling) — not a
 *      probability. It is shown as a number rather than dressed up as a
 *      percentage.
 */
'use strict';

const T = require('./tiles');

const MAX_ITEMS = 5;

/** Colour a row by how dangerous the discard is. */
function dangerColor(weixian) {
    if (typeof weixian !== 'number') return undefined;
    if (weixian >= 8) return '#ff5555';
    if (weixian >= 3.2) return '#ffaa00';
    return '#00ff80';
}

/** The AI's own evaluation, rendered compactly. */
function score(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return String(Math.round(value));
}

/** Order rows the way the AI ranks them: highest expected value first. */
function byEv(rows) {
    return rows.slice().sort((a, b) => (b.ev || 0) - (a.ev || 0));
}

/**
 * Build a `meta.show` card for a discard decision.
 *
 * @param {object[]} info        the `info` array the AI filled in
 * @param {object} [opts]
 * @param {string} [opts.chosen] the discard the AI picked, for the title
 * @returns {object|null} the card, or null when there is nothing worth showing
 */
function discardCard(info, opts = {}) {
    if (!Array.isArray(info) || !info.length) return null;

    const rows = info.filter((i) => i && typeof i.p === 'string');
    if (!rows.length) return null;

    const items = [];
    for (const r of byEv(rows).slice(0, MAX_ITEMS)) {
        const tile = T.toMjai(r.p.slice(0, 2));
        const note = [];
        if (typeof r.n_xiangting === 'number') {
            note.push(r.n_xiangting === 0 ? '听牌' : `向听 ${r.n_xiangting}`);
        }
        if (typeof r.n_tingpai === 'number' && r.n_tingpai > 0) {
            note.push(`进张 ${r.n_tingpai}`);
        }
        if (typeof r.weixian === 'number') {
            note.push(`危险度 ${r.weixian.toFixed(2)}`);
        }

        items.push({
            label: `打 ${tile === null ? r.p : tile}`,
            pais: tile === null ? undefined : [tile],
            value: score(r.ev),
            color: dangerColor(r.weixian),
            note: note.join(' · ') || undefined,
        });
    }

    if (!items.length) return null;
    return {
        title: titleFor('discard', opts.chosen, {
            riichi: opts.riichi,
            riichiTile: opts.chosen ? T.toMjai(opts.chosen.replace(/[*_]+$/, '')) : null,
        }),
        items,
    };
}

/**
 * Build a `meta.show` card for a call decision (pon/chi/kan or pass).
 *
 * The AI includes a pass row (`m: ''`) alongside the calls, so this list is
 * already a straight comparison of "call" against "decline" — the most useful
 * thing on screen during a call window.
 */
function callCard(info, opts = {}) {
    if (!Array.isArray(info) || !info.length) return null;

    const rows = info.filter((i) => i && typeof i === 'object');
    if (!rows.length) return null;

    const items = [];
    for (const r of byEv(rows).slice(0, MAX_ITEMS)) {
        const isPass = !r.m;
        const parts = isPass ? null : T.mianziParts(r.m);
        const pais = parts
            ? [parts.called, ...parts.fromHand].map(T.toMjai).filter((t) => t !== null)
            : undefined;

        items.push({
            label: isPass ? '不鸣 (Pass)' : labelForMianzi(r.m),
            pais: pais && pais.length ? pais : undefined,
            value: score(r.ev),
            note: typeof r.n_xiangting === 'number'
                ? (r.n_xiangting === 0 ? '听牌' : `向听 ${r.n_xiangting}`)
                : undefined,
        });
    }

    if (!items.length) return null;
    return { title: titleFor('call', opts.chosen), items };
}

/** The tile a red five stands in for, for "are these the same tile" tests. */
function faceValue(t) {
    return t.length === 2 && t[1] === '0' ? t[0] + '5' : t;
}

/** Human label for a mianzi: the kind of call plus the tile called on. */
function labelForMianzi(mianzi) {
    const parts = T.mianziParts(mianzi);
    if (!parts) return '鸣牌';
    const tile = T.toMjai(parts.called);
    const shown = tile === null ? parts.called : tile;
    if (parts.fromHand.length === 3) return `杠 ${shown}`;
    // Red-five-insensitive: a pon may hold the red five while the called tile is
    // the normal one, and comparing raw strings would label it a chi.
    const want = faceValue(parts.called);
    const isSet = parts.fromHand.every((t) => faceValue(t) === want);
    return `${isSet ? '碰' : '吃'} ${shown}`;
}

/**
 * Card heading. `kind` is 'discard' or 'call'; a discard that the AI marked
 * with a riichi '*' says so, because "declaring riichi" is the decision the
 * player actually cares about being shown.
 */
/**
 * Build a card explaining why the AI turned down a call.
 *
 * The AI is deliberately conservative: `select_fulou` accepts a call only when
 * its own evaluation strictly beats not calling, and it does not even record the
 * calls it rejects. Without this card a declined call is completely silent — the
 * overlay shows nothing, which reads as "the bot is not looking" when in fact it
 * looked and chose to pass. So this compares not-calling against every call that
 * was available, using the AI's own numbers.
 *
 * @param {object|null} call   the driver's `lastCallCard`
 * @returns {object|null} the card, or null when there is nothing to show
 */
function declineCard(call) {
    if (!call || !Array.isArray(call.candidates) || !call.candidates.length) return null;

    const passEv = typeof call.passEv === 'number' ? call.passEv : null;
    const items = [{
        label: '不鸣 (Pass)',
        value: score(passEv),
        color: '#8a8a8a',
        note: typeof call.passShanten === 'number'
            ? (call.passShanten === 0 ? '听牌' : `向听 ${call.passShanten}`)
            : undefined,
    }];

    for (const c of call.candidates.slice(0, MAX_ITEMS - 1)) {
        const parts = T.mianziParts(c.meld);
        const pais = parts
            ? [parts.called, ...parts.fromHand].map(T.toMjai).filter((t) => t !== null)
            : undefined;

        const note = [];
        if (typeof c.shanten === 'number') {
            note.push(c.shanten === 0 ? '听牌' : `向听 ${c.shanten}`);
        }
        if (typeof call.passShanten === 'number' && typeof c.shanten === 'number') {
            const delta = call.passShanten - c.shanten;
            if (delta > 0) note.push(`听牌前进 ${delta}`);
            else if (delta === 0) note.push('向听未变');
        }
        if (passEv !== null && typeof c.ev === 'number') {
            note.push(`差 ${Math.round(c.ev - passEv)}`);
        }

        items.push({
            label: labelForMianzi(c.meld),
            pais: pais && pais.length ? pais : undefined,
            value: score(c.ev),
            // Green when the call would actually have been better — so the rare
            // case where the AI passes on a good call is visible rather than
            // hidden — red when it would have been worse.
            color: (passEv !== null && typeof c.ev === 'number')
                ? (c.ev > passEv ? '#00ff80' : '#ff5555')
                : undefined,
            note: note.join(' · ') || undefined,
        });
    }

    const tile = T.toMjai(call.called);
    // "对方打" and not "打". The tile named on a call window is the OPPONENT's
    // discard — the one we could have called — and a heading that said "打 2s"
    // read as advice to throw 2s, which is a different card entirely (see
    // `discardCard`). It is at its most confusing exactly when the hand does not
    // hold that tile at all, which is the common case: 2s was discarded *at* us.
    return {
        title: `鸣牌判断（不鸣${tile ? '，对方打 ' + tile : ''}）`,
        items,
    };
}

function titleFor(kind, chosen, opts = {}) {
    const verb = kind === 'call' ? '鸣牌' : '打牌';
    if (!chosen) return `${verb}候选`;
    if (opts.riichi) return `立直（打 ${opts.riichiTile || ''}）· ${verb}候选`.trim();
    const parts = T.mianziParts(chosen);
    const tile = parts ? T.toMjai(parts.called) : null;
    return tile ? `${verb}候选（选 ${tile}）` : `${verb}候选`;
}

/**
 * Attach a card to a reaction, following Akagi's "only when it chose" rule.
 *
 * @param {object} reaction  the mjai action about to be emitted
 * @param {object|null} card the card, or null
 */
function attach(reaction, card) {
    if (!card) return reaction;
    return Object.assign({}, reaction, { meta: { show: card } });
}

module.exports = {
    discardCard,
    callCard,
    declineCard,
    attach,
    score,
    dangerColor,
    labelForMianzi,
    byEv,
    MAX_ITEMS,
};
