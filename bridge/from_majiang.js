/*
 *  from_majiang.js — turn a majiang-core reply into an mjai action.
 *
 *  The AI answers with a majiang decision object; Akagi wants an mjai action.
 *  The mapping is mostly mechanical, but four details are easy to get wrong and
 *  are handled explicitly here:
 *
 *   RON vs TSUMO. majiang says only `{hule:'-'}` — it does not distinguish
 *   winning off your own draw from winning off someone's discard. mjai needs
 *   `{type:'hora', actor, target}`, and the bridge's own seat knowledge is what
 *   tells the two apart: if the decision was triggered by our own draw then
 *   target === actor (tsumo), otherwise target is whoever discarded.
 *
 *   CALLED-TILE ORDER. majiang's marker identifies the called tile, and it is
 *   not always the first digit (`m12-3` is a chi on the middle tile, `z111+1` is
 *   an added kan). majiang's `consumed` is what came out of our hand and does NOT
 *   include the tile we called on; mjai's does. So the called tile is lifted out
 *   by marker position and placed first, and the sizes are checked against
 *   Akagi's schema (`Chi/Pon` take 2, `Daiminkan/Kakan` take 3, `Ankan` — which
 *   has no separate `pai` — takes all 4).
 *
 *   TSUMOGIRI. mjai wants an explicit `tsumogiri` boolean. majiang signals it by
 *   returning the drawn tile as a two-character string. We recompute the flag
 *   from the hand rather than trusting the string length, because a one-character
 *   tile is a legal (if unusual) way to discard the tile you just drew when the
 *   draw is the only copy in hand.
 *
 *   RIICHI. A riichi is the declaration AND the tile it is declared on. mjai
 *   spells it as two actions, but Akagi's schema puts the tile on the declaration
 *   itself (`Reach { actor, pai }`, a documented non-spec extension) and its
 *   autoplay stalls on a `reach` that does not name the discard. So it is emitted
 *   as ONE action carrying `pai`, not as a `reach` plus a trailing `dahai`.
 *
 *  LEGALITY GATING. Akagi runs each bot alongside a riichi engine that already
 *  knows our legal set, and Akagi's own bundled bot uses that set to gate its
 *  output ("legal-action gate", see Akagi's src/bot/README.md). The mjai stream
 *  does not carry the set, so the bridge derives an equivalent one from its own
 *  model (`MajiangDriver.lastLegal`, built with the same library predicates the
 *  AI decided with) and passes it in: an action the model does not permit is
 *  downgraded to `none` rather than sent, because a bot that proposes an illegal
 *  action desynchronises the game.
 */
'use strict';

const T = require('./tiles');

/** The mjai action meaning "nothing to do this turn". */
const NONE = Object.freeze({ type: 'none' });

/**
 * Strip a mahjong mianzi's direction marker and return its tiles in the order
 * they are written — which is NOT the order of importance: the marker, not the
 * position, says which tile was called (see `T.mianziParts`).
 * `m222+` -> ['m2','m2','m2']; `p055=` -> ['p0','p5','p5'].
 */
function mianziTiles(mianzi) {
    const body = mianzi.replace(/[\+\=\-]/g, '');
    if (!/^[mpsz]\d+$/.test(body)) return null;
    const suit = body[0];
    const tiles = [];
    for (const d of body.slice(1)) tiles.push(suit + d);
    return tiles;
}

/** The dora slot notation `p0` (red five) counts as a `p5` for matching. */
const canonical = T.canonical;

class DecisionTranslator {
    /**
     * @param {object} opts
     * @param {number} opts.seat   bot's absolute seat
     * @param {object} [opts.onNote]
     */
    constructor(opts) {
        this.seat = opts.seat;
        this.onNote = opts.onNote || (() => {});
    }

    /**
     * Translate one AI reply into the mjai action that answers it.
     *
     * @param {object|null} reply      the AI's raw majiang reply
     * @param {object} ctx
     * @param {object} ctx.trigger     the mjai event that opened the decision
     * @param {string[]} [ctx.legal]   the action types the model permits for this
     *                                 decision (`MajiangDriver.lastLegal`). When
     *                                 present, a proposed action outside it is
     *                                 refused.
     * @returns {object[]} the action(s) to emit; `[{type:'none'}]` when the AI
     *                     passed or its answer was refused. A riichi is ONE
     *                     action, not two — see the header note.
     */
    translate(reply, ctx) {
        const { trigger, legal } = ctx || {};

        if (!reply) return [NONE];

        // --- a win -----------------------------------------------------------
        // Akagi's `Hora` carries no tile (its schema is `{actor, target, deltas,
        // ura_markers}`), and an extra field would be dropped on the floor at
        // best, so the winning tile is not sent.
        if (reply.hule !== undefined) {
            const action = {
                type: 'hora',
                actor: this.seat,
                target: this._winTarget(trigger),
            };
            return this._gate(action, legal, 'hora');
        }

        // --- an abortive draw (nine terminals/honours) ------------------------
        // Likewise `Ryukyoku` is `{deltas}` only: no actor.
        if (reply.daopai !== undefined) {
            return this._gate({ type: 'ryukyoku' }, legal, 'ryukyoku');
        }

        // --- a call ----------------------------------------------------------
        if (reply.fulou !== undefined) {
            const out = this._fulou(reply.fulou, trigger);
            if (out === null) return [NONE];
            return this._gate(out, legal, out.type);
        }

        // --- a kan (closed or added) -----------------------------------------
        if (reply.gang !== undefined) {
            const out = this._kan(reply.gang);
            if (out === null) return [NONE];
            return this._gate(out, legal, out.type);
        }

        // --- a discard, possibly with riichi ---------------------------------
        if (reply.dapai !== undefined) {
            return this._dahai(reply.dapai, legal);
        }

        // An empty reply `{}` is majiang's "pass", which is `none` on the wire.
        return [NONE];
    }

    // -----------------------------------------------------------------------
    // Discards
    // -----------------------------------------------------------------------

    _dahai(dapai, legal) {
        // majiang's discard notation is `<tile>` followed by any combination of
        // '_' (tsumogiri) and '*' (riichi; '**' for double). They appear in
        // whatever order the library emits — `z3**_` is a real form — so strip
        // the whole suffix run instead of matching a fixed pattern.
        const riichi = dapai.includes('*');
        const tsumogiri = dapai.includes('_');
        const tile = dapai.replace(/[*_]+$/, '');
        const mjai = T.toMjai(tile);
        if (mjai === null) {
            this.onNote(`discard reply has no mjai form: ${JSON.stringify(dapai)}`);
            return [NONE];
        }

        // The riichi is a property of the DECLARATION, so the declaration's own
        // legality is checked first: a model that offers no legal riichi at all
        // must not produce one, and the discard cannot be sent on its own here
        // because the model has already applied the marked form of it.
        if (riichi && !this._allowed('reach', legal)) {
            this.onNote('refused reach: the model has no legal riichi discard');
            return [NONE];
        }

        const action = { type: 'dahai', actor: this.seat, pai: mjai, tsumogiri };
        const gated = this._gate(action, legal, 'dahai');
        if (gated[0].type === 'none' && riichi) {
            // The discard was refused, so the riichi that rode on it must be too.
            return gated;
        }

        if (!riichi) return gated;
        // One action, not two: Akagi's `Reach` has an optional `pai` naming the
        // declaring discard, and its autoplay stalls on a bare reach. Sending
        // the discard as a trailing action is not an option either — Akagi reads
        // one action per batch and ignores anything smuggled into `meta`.
        return [{ type: 'reach', actor: this.seat, pai: mjai }];
    }

    // -----------------------------------------------------------------------
    // Calls
    // -----------------------------------------------------------------------

    _fulou(mianzi, trigger) {
        // The marker says which tile was called, so `mianziParts` — not the first
        // digit — gives us both lists. For a chi the called tile can be the
        // lowest, middle or highest digit of the run.
        const parts = T.mianziParts(mianzi);
        if (parts === null) {
            this.onNote(`unreadable fulou: ${JSON.stringify(mianzi)}`);
            return null;
        }

        const tiles = [parts.called, ...parts.fromHand];
        const mjaiCalled = T.toMjai(parts.called);
        const mjaiConsumed = parts.fromHand.map(T.toMjai);
        if (mjaiCalled === null || mjaiConsumed.some((t) => t === null)) {
            this.onNote(`fulou has no mjai form: ${JSON.stringify(mianzi)}`);
            return null;
        }

        const target = trigger && typeof trigger.actor === 'number' ? trigger.actor : null;
        if (target === null) {
            this.onNote('fulou without a triggering discard');
            return null;
        }

        // Four tiles is an open kan; three identical tiles is a pon; anything
        // else is a chi.
        if (tiles.length === 4) {
            return {
                type: 'daiminkan', actor: this.seat, target,
                pai: mjaiCalled, consumed: mjaiConsumed,
            };
        }

        const allSame = tiles.every((t) => canonical(t) === canonical(parts.called));
        if (allSame) {
            return {
                type: 'pon', actor: this.seat, target,
                pai: mjaiCalled, consumed: mjaiConsumed,
            };
        }
        return {
            type: 'chi', actor: this.seat, target,
            pai: mjaiCalled, consumed: mjaiConsumed,
        };
    }

    /**
     * Translate a `{gang}` reply into an `ankan` or `kakan` action.
     *
     * The two shapes are NOT interchangeable to Akagi:
     *
     *   Kakan { actor, pai, consumed: [Tile; 3] }   — the pon plus the added tile
     *   Ankan { actor, consumed: [Tile; 4] }        — all four tiles, no `pai`
     *
     * majiang spells both with a 4-digit mianzi and never says which it is, so
     * the difference is recovered from our own melds: an added kan extends a pon
     * of the same tile. The added kan's mianzi puts its marker in the MIDDLE
     * (`z111+1`), which is why the parse has to go by marker position.
     */
    _kan(mianzi) {
        const parts = T.mianziParts(mianzi);
        if (parts === null || parts.fromHand.length !== 3) {
            this.onNote(`unreadable gang: ${JSON.stringify(mianzi)}`);
            return null;
        }

        const tiles = [parts.called, ...parts.fromHand];
        // A kan is always four of a kind, so the red-five-insensitive compare is
        // the whole legality check we need here (majiang cannot emit anything
        // else with a `gang` reply).
        if (!tiles.every((t) => canonical(t) === canonical(parts.called))) {
            this.onNote(`gang with mixed tiles: ${JSON.stringify(mianzi)}`);
            return null;
        }

        const pai = T.toMjai(parts.called);
        const consumed = parts.fromHand.map(T.toMjai);
        if (pai === null || consumed.some((t) => t === null)) return null;

        // An added kan extends an existing pon of the same tile; a closed kan
        // does not. majiang reports both as `{gang: ...}`, so that is the only
        // way to tell them apart.
        if (this._hasPonOf(parts.called)) {
            return { type: 'kakan', actor: this.seat, pai, consumed };
        }
        // A closed kan lists all four tiles and names no called tile — that is
        // Akagi's `Ankan { actor, consumed: [Tile; 4] }`, a fixed-size array, so
        // sending the three "from hand" tiles alone fails to deserialize and
        // costs the whole reply.
        return { type: 'ankan', actor: this.seat, consumed: tiles.map(T.toMjai) };
    }

    /**
     * Whether the bot already has a pon of `tile`. Used to tell `kakan` from
     * `ankan`, which majiang expresses with the same reply shape.
     *
     * The driver sets `this.hand` to the bot's majiang shoupai before each
     * decision so this can be answered.
     */
    _hasPonOf(tile) {
        const hand = this.hand;
        if (!hand || !hand._fulou) return false;
        const want = canonical(tile);
        for (const m of hand._fulou) {
            const parts = T.mianziParts(m);
            // A pon is exactly three tiles, of which the called one is first.
            if (!parts || parts.fromHand.length !== 2) continue;
            if (canonical(parts.called) === want
                && parts.fromHand.every((t) => canonical(t) === want)) {
                return true;
            }
        }
        return false;
    }

    // -----------------------------------------------------------------------
    // Wins
    // -----------------------------------------------------------------------

    /**
     * Who the win is off. Our own draw => our own seat (mjai tsumo convention);
     * otherwise the player who discarded the winning tile.
     */
    _winTarget(trigger) {
        if (!trigger) return this.seat;
        if (trigger.type === 'tsumo' && trigger.actor === this.seat) return this.seat;
        if (trigger.type === 'dahai' && typeof trigger.actor === 'number') return trigger.actor;
        if (trigger.type === 'kakan' && typeof trigger.actor === 'number') return trigger.actor;
        if (trigger.type === 'hora' && typeof trigger.target === 'number') return trigger.target;
        return this.seat;
    }

    // -----------------------------------------------------------------------
    // Legality gating
    // -----------------------------------------------------------------------

    /**
     * Whether `type` is in the legal set for this decision.
     *
     * @param {string} type
     * @param {string[]|object} [legal]  the model's legal set. An array is the
     *                                   set itself; a plain object is keyed by
     *                                   action kind. `undefined` means "no set
     *                                   was supplied" and allows everything,
     *                                   which is how the unit suites drive the
     *                                   translator in isolation.
     */
    _allowed(type, legal) {
        if (!legal) return true;
        const allowed = Array.isArray(legal) ? legal : legal[type];
        if (allowed === undefined) return true;
        const types = new Set(
            allowed.map((a) => (typeof a === 'string' ? a : a && a.type)).filter(Boolean)
        );
        return types.has(type);
    }

    /**
     * Refuse an action the model will not allow.
     *
     * `legal` comes from the driver, which derives it from the same majiang-core
     * predicates the AI decided with (`MajiangDriver.lastLegal`). An action whose
     * type is absent is downgraded to `none`: that keeps the bot honest at the
     * cost of a missed opportunity — strictly better than a desynchronised game.
     *
     * @param {object} action
     * @param {string[]|object} [legal]
     * @param {string} kind   the key to use when `legal` is an object
     */
    _gate(action, legal, kind) {
        if (this._allowed(action.type, legal)) return [action];
        const allowed = Array.isArray(legal) ? legal : legal[kind] || [];
        const types = allowed.map((a) => (typeof a === 'string' ? a : a && a.type)).filter(Boolean);
        this.onNote(`refused ${action.type}: not in the legal set ${types.join(',')}`);
        return [NONE];
    }
}

module.exports = {
    DecisionTranslator,
    mianziTiles,
    canonical,
    NONE,
};
