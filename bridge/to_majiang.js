/*
 *  to_majiang.js — drive a majiang-core `Player` from an mjai event stream.
 *
 *  This is the heart of the bridge: `@kobalab/majiang-ai` is not a protocol
 *  server, it is a *Player* that majiang-core's `Game` pushes events into. Here
 *  we synthesise that push sequence from the mjai events Akagi delivers, and
 *  read the AI's answer out of its callback.
 *
 *  Everything about the seat/rotation handling below was established
 *  empirically against the installed libraries; each oddity is documented where
 *  it is relied upon. The headline facts:
 *
 *  SEAT COORDINATES — the central design decision.
 *
 *  majiang-core uses one index space for two incompatible meanings, and only
 *  works because the normal entry point (`Majiang.Game`) always has
 *  `qijia == 0`, which makes them coincide:
 *
 *    - `Player`'s getters index the model by `_menfeng`:
 *          get shoupai() { return this._model.shoupai[this._menfeng] }
 *    - `Board` reads and writes the model's arrays by the event's `l` field
 *      (its `lunban` / `dapai.l`), i.e. by the actor, and `Board.qipai` stores
 *      hands at the array index it is handed.
 *    - `Player`'s own logic compares the two: `if (zimo.l == this._menfeng)`.
 *
 *  `_menfeng` is assigned by `Player.qipai` as `Board.menfeng(this._id)` and we
 *  cannot override it, so the getter and the comparisons SHARE one value. That
 *  forces `_menfeng` and the event `l` into the same space, and there are only
 *  two self-consistent choices:
 *
 *    (a) rotate so the bot is index 0, or
 *    (b) keep event/absolute seats and let the bot's index be its absolute seat.
 *
 *  We take (b). Setting `qijia = 0` and `jushu = 0` makes
 *  `Board.menfeng(actor) === actor`, so `_menfeng === seat` and every event's
 *  `l` is just the absolute actor that mjai already gives us. Option (a) is
 *  attractive (the bot would always be 0) but it puts the bot's *hand* at index
 *  0 while `Board.zimo` writes the drawn tile to index `l` — the absolute seat —
 *  so `Player.shoupai` reads a hand that never receives its draws, and the AI
 *  answers every turn with a pass.
 *
 *  Consequences to keep in mind when reading the code below:
 *    - `qipai.shoupai` is a FULL 4-element array with the bot's hand at
 *      `shoupai[seat]`; the other three entries are empty and unused.
 *    - `qipai.defen` is passed through in absolute seat order, unrotated.
 *    - `qipai.jushu` must be 0 (it is not the game's hand number here), and it
 *      has to be re-forced before every deal because `Board.qipai` copies the
 *      value we pass into the model.
 *    - `model.he[seat]` is the bot's own river.
 *
 *  OPPONENT DRAWS. The wire censors an opponent's drawn tile to `"?"`, and
 *  `Shoupai.zimo()` throws on anything that is not a real tile — so an
 *  opponent's draw must NOT be fed to the model. It still has to count against
 *  the live wall, which we track ourselves (see `_withWall`).
 *
 *  RINSHAN. A replacement draw after a kan comes from the dead wall, so it must
 *  not decrement the live-wall count. mjai does not distinguish it, so we
 *  classify by the kan that preceded it.
 *
 *  DOUBLE RIICHI. `_diyizimo` mirrors majiang-core's own flag and decides
 *  whether a riichi is `*` (normal) or `**` (double). Majiang clears it on the
 *  player's first discard, so we do the same.
 */
'use strict';

const T = require('./tiles');

/**
 * Live-wall tiles left after the deal in a 4-player game: 136 − 13×4 − 14.
 *
 * This is the value `SuanPai` initialises its `_n_zimo` to, and it is the anchor
 * for the whole wall-count reconstruction in `wallCount`.
 */
const LIVE_WALL_4P = 70;

class MajiangDriver {
    /**
     * @param {object} opts
     * @param {object} opts.Majiang  the @kobalab/majiang-core module
     * @param {object} opts.AI       the @kobalab/majiang-ai player class
     * @param {number} opts.seat     bot's absolute seat (start_game.id)
     * @param {number} opts.numPlayers  must be 4
     * @param {object} [opts.rule]   majiang rule object
     * @param {Function} [opts.onNote]  diagnostics sink (string) => void
     */
    constructor(opts) {
        const { Majiang, AI, seat, numPlayers, rule, onNote } = opts;

        this.Majiang = Majiang;
        this.seat = seat;
        this.numPlayers = numPlayers;
        this.rule = rule || Majiang.rule();
        this.onNote = onNote || (() => {});

        if (numPlayers !== 4) {
            throw new Error(`kobalab bot supports 4-player games only (got ${numPlayers})`);
        }

        this.player = new AI();

        // Live-wall accounting, mirrored into `_suanpai._n_zimo` and
        // `shan.paishu` before every decision. Both are only ever *read* during a
        // decision, so syncing at the decision boundary is enough, and it also
        // repairs the decrement `SuanPai`/`Shan` perform for draws we never see.
        //
        // Initialised here rather than in `startKyoku`: the wall getter is
        // `70 - liveDraws`, and reading it before the first deal (an opponent's
        // draw is logged, for one) would otherwise be `70 - undefined`, i.e. NaN.
        this.liveDraws = 0;
        this.kans = 0;

        // The choice we made at the decision we are currently answering, in
        // majiang notation, or null. Set by `_applyReplyDiscard`, consumed by the
        // echo of our own discard.
        this.ourDiscard = null;

        // Set by a kan, consumed by the draw that follows it. A rinshan draw
        // comes from the dead wall and must not count against the live wall, so
        // these are how `_onTsumo` tells the two apart. `rinshanFrom` records
        // WHICH seat declared the kan: only that seat's next draw is a rinshan,
        // so a stale flag can never excuse somebody else's real draw.
        this.rinshanPending = false;
        this.rinshanFrom = null;

        // Consecutive kans awaiting their dora markers. majiang flips a kan's
        // dora with `kaigang`, which lands on the player's next draw, so markers
        // are held until that draw happens.
        this.pendingDora = [];

        // Seat mapping. `qijia` is the base dealer of this player's view (its own
        // seat), `jushu` the hand counter; together they rotate absolute seats
        // into majiang's relative `l` space. Both are set in startGame/startKyoku.
        this.qijia = seat;
        this.jushu = 0;
        this.oya = seat;

        // Whose turn the board believes it is (MENFENG, i.e. relative seat).
        this.lunban = 0;

        // majiang-core's own "player has not discarded yet in this hand" flag,
        // mirrored so double riichi is detected the same way the library does.
        this.diyizimo = false;

        // The riichi discard awaiting `reach_accepted`, so the accept can be
        // expressed as the '*' marker majiang puts on the river tile. `null`
        // means "no declaration outstanding"; the tile itself may be ''.
        this.pendingReach = [null, null, null, null];

        // Last discard by absolute seat, in MAJIANG tile notation.
        this.lastDiscard = [null, null, null, null];

        // The last call this driver APPLIED to the model, as a comparable key.
        //
        // Akagi treats a seat's own chi/pon as a decision point (the bot owes it
        // a discard), so the call comes back to us as an event after we have
        // already applied it. Applying it twice corrupts the meld list
        // (`m222+,,`) and every later event is then rejected by the model, which
        // looks exactly like "the bot hangs after a call".
        this.appliedCall = null;

        // Why the AI answered as it did at the most recent call window: the value
        // of not calling plus every call it turned down. Filled by
        // `_noteCallDecision`; cleared at the start of every decision so a stale
        // explanation can never be shown for a later one.
        this.lastCallCard = null;

        // The ranked candidate list the AI filled in on its way past, for the HUD.
        this.lastCandidates = [];

        // Whether the event currently being fed opened a decision for us, and the
        // action types the model allows for it. Reset per event in `feed()` so
        // one event's decision can never be attributed to the next one, and read
        // by `main.js` to pick the reply and to gate it.
        this.asked = false;
        this.lastLegal = null;

        // The last exception the model rejected an event with, for diagnostics.
        this.lastError = null;

        this.started = false;
        this.handIndex = 0;
    }

    // -----------------------------------------------------------------------
    // Seat mapping
    // -----------------------------------------------------------------------

    /**
     * Absolute mjai seat → majiang menfeng, i.e. the index majiang-core uses for
     * event `l` fields, `Board.shoupai`, `Board.he` and `Board.defen`.
     *
     * Must equal `Board.menfeng()` exactly. The library computes
     * `(id + 4 - qijia + 4 - jushu) % 4` and needs BOTH fours to keep the
     * expression non-negative: JavaScript's `%` keeps the sign of the dividend,
     * so a negative index would be returned as a negative index, and that is how
     * a legal-looking hand ends up stored at a slot `Player.shoupai` never reads.
     * With `jushu` restricted to 0..3 (see `startKyoku`) the library's form is
     * always positive, but the normalisation here costs nothing and makes this
     * function right for any input.
     */
    menfeng(actor) {
        return (((actor - this.qijia + 4 - this.jushu) % 4) + 4) % 4;
    }

    /** The bot's own menfeng — the index its hand lives at. */
    get ownSeat() {
        return this.menfeng(this.seat);
    }

    // -----------------------------------------------------------------------
    // Player lifecycle
    // -----------------------------------------------------------------------

    /** `start_game` — set the bot's seat and the base dealer. */
    startGame(ev) {
        // `id` is authoritative; argv/env are fallbacks the shim already used.
        if (typeof ev.id === 'number') this.seat = ev.id;

        // `kaiju.id` is an ABSOLUTE seat and is what Board.menfeng() consumes, so
        // it is passed through unchanged. `qijia` is the base dealer of the game
        // — the anchor of the absolute<->menfeng rotation — and majiang's own
        // `kaiju` message carries it, so it is passed through too.
        //
        // Akagi's mjai `start_game` has no `qijia` field (the riichi engine keeps
        // that private; only per-hand `oya` is on the wire). The fallback treats
        // the bot's own seat as the base dealer, which is exactly right when the
        // bot sits in the first dealer's seat and merely shifts every index by a
        // constant otherwise — harmless, because all of the bot's own comparisons
        // are made in menfeng space either way.
        this.qijia = Number.isInteger(ev.qijia) ? ((ev.qijia % 4) + 4) % 4 : this.seat;

        this.player.action({
            kaiju: {
                id: this.seat,
                rule: this.rule,
                title: '',
                player: ['', '', '', ''],
                qijia: this.qijia,
            },
        }, () => {});
        this.started = true;
    }

    /**
     * `start_kyoku` — deal a hand.
     *
     * This is where the two seat spaces are reconciled. mjai gives absolute
     * seats; majiang-core's event `l` fields are *relative* (menfeng), the
     * rotation being `(actor - qijia - jushu) % 4`. The bot's own hand is stored
     * at its menfeng index, which is the single index `Player.shoupai` reads and
     * `Board.zimo` later writes our draws to.
     */
    startKyoku(ev) {
        this.handIndex++;
        this.diyizimo = true;
        this.rinshanPending = false;
        this.pendingDora = [];

        // The live wall is refilled every hand, so the per-hand draw count must
        // restart here. `SuanPai` is rebuilt by `Player.qipai` with a fresh 70,
        // so leaving this cumulative would force every availability estimate in
        // a later hand down to zero.
        this.liveDraws = 0;
        this.kans = 0;
        this.ourDiscard = null;
        this.appliedCall = null;
        this.rinshanFrom = null;

        // `jushu` is majiang's hand counter, and it counts the hands WITHIN the
        // round — 0..3 — because the round itself is carried separately by
        // `zhuangfeng`. That restriction is load-bearing, not cosmetic: both
        // `Board.menfeng` and `majiang-ai`'s `SuanPai.qipai` rotate seats with
        // `(id + 8 - qijia - jushu) % 4`, which only stays non-negative while
        // `jushu` is 0..3. Handing them a game-wide index (bakaze * 4 + kyoku - 1,
        // i.e. up to 7 in a hanchan) makes that expression negative from South 2
        // on, and the modulo keeps the sign: `SuanPai.qipai` then indexes
        // `qipai.shoupai[-1]`, throws on the undefined hand, and every later event
        // of the hand is rejected.
        //
        // The seat rotation is unaffected by the choice — (jushu + 4) ≡ jushu
        // (mod 4) — so the round only ever needed `zhuangfeng`.
        this.jushu = (ev.kyoku || 1) - 1;
        this.oya = (this.qijia + this.jushu) % 4;
        this.lunban = this.menfeng(this.oya);

        const bakaze = bakazeToNumber(ev.bakaze);
        const ourHand = this._ourHandString(ev.tehais);
        const ownIndex = this.menfeng(this.seat);
        const shoupai = ['', '', '', ''];
        shoupai[ownIndex] = ourHand;

        this.player.action({
            qipai: {
                zhuangfeng: bakaze,
                jushu: this.jushu,
                changbang: ev.honba || 0,
                lizhibang: ev.kyotaku || 0,
                defen: this._scores(ev.scores),
                baopai: T.fromMjai(ev.dora_marker) || 'z1',
                shoupai,
            },
        }, () => {});
    }

    /**
     * `end_kyoku` / `hora` / `ryukyoku` — a hand has finished.
     *
     * Deliberately does NOT reset the wall counter: the engine can still spend a
     * live-wall tile after `hora` (a win on a rinshan draw flips a final dora
     * indicator), so zeroing it here would under-count the wall for the rest of
     * the comparison. Everything is reset in `startKyoku`, which is the only point
     * at which the wall is genuinely refilled.
     */
    endKyoku() {
        this.pendingReach = [null, null, null, null];
        this.lastDiscard = [null, null, null, null];
        this._clearStaleRinshan();
        // Any dora still pending belongs to the hand just ended.
        this.pendingDora = [];
    }

    // -----------------------------------------------------------------------
    // Events that can produce a decision
    // -----------------------------------------------------------------------

    /**
     * Feed one event to the AI.
     *
     * `asked` is reset here, at the start of EVERY event, so it means "this
     * event opened a decision for us" rather than "a decision has happened at
     * some point". It used to be reset only inside `_withWall`, which made it
     * sticky: once one decision had been taken, `main.js` attributed every later
     * event of the same batch to the AI's reply and answered `none`, dropping the
     * decision it had already applied to the model.
     *
     * @returns {object|null} the AI's raw majiang reply object, or null when the
     *                        event opened no decision for us.
     */
    feed(ev) {
        this.asked = false;
        this.lastLegal = null;
        this.trigger = null;
        try {
            return this._feed(ev);
        } catch (e) {
            // majiang-core throws on states it considers impossible — a discard
            // of a tile we do not hold, a fifth copy of a tile, and so on. That
            // means the wire and our model have diverged, and it must cost us
            // this decision rather than the process: Akagi kills a bot that
            // stops answering, and a desync is recoverable at the next hand.
            this.onNote(`event ${ev && ev.type} rejected by the model: ${e.message}`);
            this.lastError = e;
            return null;
        }
    }

    _feed(ev) {
        switch (ev.type) {
        case 'start_game':    this.startGame(ev);    return null;
        case 'start_kyoku':   this.startKyoku(ev);   return null;
        case 'end_kyoku':     this.endKyoku();       return null;
        case 'tsumo':         return this._onTsumo(ev);
        case 'dahai':         return this._onDahai(ev);
        case 'chi':
        case 'pon':           return this._onFulou(ev);
        case 'daiminkan':     return this._onDaiminkan(ev);
        case 'kakan':
        case 'ankan':         return this._onAnkanOrKakan(ev);
        case 'dora':          this.noteDora(ev);             return null;
        case 'reach':         this._onReach(ev);             return null;
        case 'reach_accepted':return this._onReachAccepted(ev);
        case 'hora':
        case 'ryukyoku':      this.endKyoku();               return null;
        case 'kita':
            // 3-player only; the constructor already refused sanma.
            return null;
        case 'none':
        default:
            return null;
        }
    }

    _onTsumo(ev) {
        const actor = ev.actor;          // absolute
        const m = this.menfeng(actor);   // majiang's index space

        // A rinshan draw is the FIRST draw after a kan, and only from the player
        // who declared it. Anything else means the kan's replacement draw is not
        // coming (the hand ended first, say), so the pending flag is stale and
        // must not be allowed to excuse a real draw from the wall.
        const claimant = this.rinshanFrom;
        const rinshan = this.rinshanPending && claimant !== null && claimant === actor;
        this.rinshanFrom = null;
        this.rinshanPending = false;

        // Every draw takes a tile off the wall, replacement draws included. That
        // is what `Majiang.Shan` counts (its `gangzimo` shifts the same array
        // `zimo` pops from), and the wall only needs to agree with the library,
        // not with a particular theory of where the dead wall is replenished
        // from: a kan costs it exactly one tile either way, and charging it here
        // — where the engine charges it — keeps the two counters equal at every
        // moment instead of only after the dora indicator has been announced.
        this.liveDraws++;

        this.lunban = m;

        if (actor === this.seat) {
            const tile = T.fromMjai(ev.pai);
            if (tile === null) {
                // Our own draw should never be censored; if it is, we cannot
                // safely advance the model. Skip rather than corrupt it.
                this.onNote(`own tsumo with unreadable tile ${JSON.stringify(ev.pai)}`);
                return null;
            }
            // Apply the kan's new dora indicator together with this draw, which
            // is where majiang-core's own flow puts it.
            //
            // A replacement draw is announced as `gangzimo`, not `zimo`: the
            // library increments the kan counter off it (which is what limits a
            // hand to four kans) and the AI's `action_zimo(zimo, gangzimo)` uses
            // it to allow 嶺上開花 as a yaku. mjai has no separate event for it,
            // so the distinction is ours to make — it was already computed above.
            let reply = null;
            const draw = rinshan
                ? { gangzimo: { l: m, p: tile } }
                : { zimo: { l: m, p: tile } };
            this._withWall(ev, () => {
                reply = this._call(draw);
            });
            for (const marker of this._takePendingDora()) this._commitDora(marker);

            // Apply our own discard NOW rather than waiting for the engine to
            // echo it back. The echo does normally arrive (`Majiang.Game`'s
            // `call_players` notifies all four seats, including the discarder),
            // but a bot must not depend on it: the decision is answered here and
            // Akagi's own stream can drop or reorder the echo. `_onDahai` absorbs
            // the echo by noticing that `_zimo` is already clear.
            //
            // `reply.dapai` is majiang's notation (`p9`, `p9_` tsumogiri, `z3*`
            // riichi), which is exactly what `Player.dapai` expects: it removes
            // the tile, clears the drawn slot, records the river and sets the
            // lizhi flag when the '*' marker is present.
            this._applyReplyDiscard(reply, m);
            return reply;
        }

        // An opponent's draw. The tile is censored, so the tile itself cannot
        // reach the model — but the DRAW must, and skipping it is what used to
        // corrupt everything downstream.
        //
        // The model keeps a hand for all four seats, and for the three we cannot
        // see it is a placeholder: `Board.qipai` builds it from `'_'.repeat(13)`
        // when the wire gives it no hand, and `_bingpai._` counts those blanks.
        // Every event from that seat SPENDS from it — `Shoupai.decrease` charges a
        // tile it does not hold to the blanks one for one, so a discard costs 1,
        // a chi 2, a pon 2 and a closed kan 4 — and only a draw puts one back.
        // Feed the draws and the placeholder tracks the seat's real concealed
        // count exactly; skip them and it empties after that seat's thirteenth
        // discard, at which point `decrease` throws.
        //
        // The throw is not local. `Board.dapai` spends the blank BEFORE it records
        // the tile in the discarder's river, so the river silently loses that
        // discard — and the NEXT call on that tile then fails its own check
        // (`He.fulou`: "the last tile is not the one being called"), so a pon or
        // chi is dropped as well. Each rejected event also costs that event's
        // decision, because `Player.action` never gets as far as asking us. One
        // omission here therefore degrades the rest of the hand: decisions vanish,
        // `SuanPai`'s danger model loses tiles, and the AI keeps evaluating a hand
        // state that no longer matches the table.
        //
        // `'_'` is the library's own word for "a tile I cannot see": `Shan.zimo`
        // substitutes it when handed nothing, and `Shoupai.zimo` counts it in
        // `_bingpai._` without adding it to any tile count. (`SuanPai.zimo` only
        // decrements for our own draws, so it is not touched either.)
        //
        // The callback is suppressed: this is bookkeeping, not a question, and
        // `Player.zimo` would otherwise call `action_zimo` and leave the driver
        // marked as having been asked. `gangzimo` is deliberately false — it
        // increments `_n_gang`, the AI's count of its OWN kans, and an opponent's
        // kan must not restrict ours.
        const player = this.player;
        const saved = player._callback;
        player._callback = null;
        try {
            player.zimo({ l: m }, false);
        } finally {
            player._callback = saved;
        }
        // `Board.zimo` sets `lunban` from the same message, so it needs no help.
        this.onNote(`opponent ${actor} drew (censored); live wall now ${this.wallCount}`);
        return null;
    }

    _onDahai(ev) {
        const actor = ev.actor;
        const m = this.menfeng(actor);
        this.lunban = m;
        this._clearStaleRinshan();

        if (actor === this.seat) {
            // Our own discard arriving as an echo.
            //
            // Whether this still needs applying is answered by the MODEL, not by
            // bookkeeping: an applied discard has cleared `_zimo`, because every
            // discard — the one after a draw and the one a chi/pon obliges —
            // goes through `Shoupai.dapai`. So `_zimo` still being set means the
            // discard has not reached the model yet.
            //
            // `ourDiscard` (the choice the AI returned and we already applied) is
            // checked first. Re-applying it removes a tile that is already gone,
            // pushes the tile onto the river twice (which used to be this code's
            // fallback branch) and throws — and a throwing event rejects all the
            // later ones, which is the "hang after a call".
            //
            // And when the echo names a DIFFERENT tile from the one the bot chose,
            // the difference is information, not noise: the player is playing by
            // hand and overrode the suggestion. The game is the authority — the
            // tile they threw is gone from their hand and the bot's choice is
            // still sitting in it — so the model is put back in step below.
            // Swallowing the difference, which is what this used to do, leaves a
            // phantom tile in the model: from then on every candidate list is
            // computed for a hand the player does not have, until the AI happens
            // to discard the phantom and heals it by luck.
            const chosen = this.ourDiscard;
            const model = this.player.shoupai;
            const echoTile = T.fromMjai(ev.pai);
            const same = chosen !== null && echoTile !== null
                && chosen.replace(/[*_]+$/, '') === echoTile;

            if (echoTile === null) {
                this.onNote(`our own discard ${JSON.stringify(ev.pai)} is unreadable; ignored`);
            } else if (same) {
                // Already applied when the reply was computed.
            } else if (chosen === null && model && model._zimo) {
                // Not applied yet (a replay, or a discard the engine made for
                // us). Let majiang do the whole job: remove the tile, clear the
                // drawn slot, set the riichi marker, and keep the river and the
                // score in step.
                this._applyOwnDiscard(m, ev.tsumogiri ? echoTile + '_' : echoTile);
            } else if (chosen !== null) {
                this._reconcileOwnDiscard(m, chosen, echoTile, ev.tsumogiri);
            } else {
                this.onNote('own discard echoed with nothing pending and no drawn tile');
            }
            this.ourDiscard = null;
            this.appliedCall = null;
            this.diyizimo = false;
        }

        // The model speaks MAJIANG tiles; `ev.pai` is mjai notation. Feeding the
        // raw wire tile here crashed `SuanPai.decrease` with
        // "reading 'undefined'", because it does `this._paishu[p[0]]` and `E` is
        // not a majiang slot.
        const tile = T.fromMjai(ev.pai);
        if (tile === null) {
            this.onNote(`discard from ${actor} has no majiang form: ${JSON.stringify(ev.pai)}`);
            return null;
        }
        this.lastDiscard[m] = tile;

        // Our own discard is not a question. The AI already chose this tile (we
        // applied it above), and `Player.dapai` would apply it to the model a
        // SECOND time — majiang removes the tile from the hand again, finds it
        // gone, and throws. Every later event is then rejected, which is the
        // hang. `Majiang.Game` does echo our own discard back to us, so this is
        // the ordinary path, not an edge case.
        if (actor === this.seat) return null;

        let reply = null;
        this._withWall(ev, () => {
            reply = this._call({ dapai: { l: m, p: tile } });
            this._noteCallDecision(m, tile, reply);
        });
        return reply;
    }

    /**
     * Record why the AI answered as it did at an opponent's discard, for the HUD.
     *
     * This exists because the AI is *conservative* and most call windows end in a
     * pass. `select_fulou` accepts a call only when its own evaluation strictly
     * beats not calling, and it does not even record the calls it rejects — so a
     * player watching the overlay sees nothing at all and reasonably concludes
     * the bot is not looking at all. It is looking; this makes that visible by
     * comparing not-calling against each call that was turned down.
     *
     * The comparison is made with the AI's OWN evaluator (`eval_shoupai`) and its
     * own `get_paishu()`, so the numbers are directly comparable to the pass value
     * instead of being a parallel estimate invented here. Only throwaway clones
     * are evaluated, so the AI's actual decision is untouched.
     */
    _noteCallDecision(m, tile, reply) {
        // No "was the AI asked?" guard is needed here, and trying to add one is a
        // mistake worth recording: `_noteCallDecision` runs inside the decision
        // itself, before `_withWall` has marked `asked`, and a *pass* comes back
        // as `undefined` — the same value an unasked decision would produce.
        // Since `_onDahai` only reaches this point after calling the AI (an
        // unreadable tile returns earlier, and an opponent's `tsumo` never gets
        // here), reaching this method *is* the signal. A pass is exactly the case
        // this explains.
        //
        // If it chose something, `main.js` renders the richer card from
        // `lastCandidates` (which lists the ranked calls), so there is nothing to
        // add here.
        if (reply && (reply.fulou !== undefined || reply.gang !== undefined
            || reply.hule !== undefined || reply.daopai !== undefined)) {
            return;
        }

        const p = this.player;
        const called = tile + T.direction(m, p._menfeng);

        // `get_*_mianzi` return null when the shape does not apply to this hand
        // (a drawn tile in the slot, no such pair), so each is normalised before
        // it is concatenated — `null.concat` would otherwise throw inside the
        // `try` and silently cost us the whole card.
        const options = []
            .concat(this._mianziOrEmpty(() => p.get_gang_mianzi(p.shoupai, called)))
            .concat(this._mianziOrEmpty(() => p.get_peng_mianzi(p.shoupai, called)))
            .concat(this._mianziOrEmpty(() => p.get_chi_mianzi(p.shoupai, called)));

        // No legal call at all: there is no decision to explain, so no card.
        if (!options.length) return;

        const suanpai = p._suanpai;
        if (!suanpai) return;

        let paishu;
        try {
            paishu = suanpai.get_paishu();
        } catch (e) {
            this.onNote(`could not read the AI's tile counts: ${e.message}`);
        }

        let passEv;
        let passShanten;
        try {
            passEv = p.eval_shoupai(p.shoupai, paishu, '');
            passShanten = this.Majiang.Util.xiangting(p.shoupai);
        } catch (e) {
            this.onNote(`could not evaluate the pass option: ${e.message}`);
        }

        const candidates = [];
        for (const meld of options) {
            try {
                const after = p.shoupai.clone().fulou(meld);
                candidates.push({
                    meld,
                    shanten: this.Majiang.Util.xiangting(after),
                    ev: p.eval_shoupai(after, paishu),
                });
            } catch (e) {
                // A meld the AI offered that we cannot apply here is not
                // explainable; skip it rather than invent a number.
                this.onNote(`could not evaluate ${meld}: ${e.message}`);
            }
        }
        if (!candidates.length) return;

        candidates.sort((a, b) => b.ev - a.ev);
        this.lastCallCard = { passEv, passShanten, candidates, called: tile };
    }

    /** `fn()` when it returns a mianzi list, `[]` when it returns null/false. */
    _mianziOrEmpty(fn) {
        try {
            const list = fn();
            return Array.isArray(list) ? list : [];
        } catch (e) {
            this.onNote(`mianzi lookup failed: ${e.message}`);
            return [];
        }
    }

    /**
     * Recognise the engine handing our own call back to us, and skip re-applying it.
     *
     * Akagi treats a seat's own chi/pon as a *decision point* (`opens_a_window`
     * in its `src/bot/manager.rs` lists `Chi | Pon { actor == me }`), because the
     * bot owes a discard after calling. So the call reaches us twice: once as the
     * engine's announcement, and again as the action we emitted coming back in
     * the next batch.
     *
     * Applying it twice appends the meld a second time — the hand string becomes
     * `m222+,,` — and from then on majiang-core rejects every event as impossible,
     * so the bot answers `none` forever. That is what a "hang after a call" is.
     *
     * Only an *exact, consecutive* repeat counts, which is the shape an echo has.
     * A genuine re-call cannot be byte-identical to the one just applied (it would
     * need the same player calling the same tile with the same tiles in hand, and
     * that hand no longer holds them).
     *
     * @returns {boolean} true when this event was already applied and must be skipped
     */
    _isEchoedCall(ev, key) {
        if (this.appliedCall === null) return false;
        const same = this.appliedCall.type === ev.type
            && this.appliedCall.actor === ev.actor
            && this.appliedCall.target === ev.target
            && this.appliedCall.mianzi === key;
        if (!same) return false;
        // Consume it: a third identical event would be something else entirely.
        this.appliedCall = null;
        this.onNote(`ignoring echoed ${ev.type} (already applied to the model)`);
        return true;
    }

    _onFulou(ev) {
        const actor = ev.actor;
        this._clearStaleRinshan();
        const mianzi = this._fulouString(ev);
        if (mianzi === null) {
            this.onNote(`unreadable ${ev.type} from ${actor}`);
            return null;
        }
        // Our own call comes back to us; see `_isEchoedCall`.
        if (this._isEchoedCall(ev, mianzi)) return null;
        this.appliedCall = {
            type: ev.type, actor: ev.actor, target: ev.target, mianzi,
        };

        this.lunban = this.menfeng(actor);
        this.diyizimo = false;

        let reply = null;
        this._withWall(ev, () => {
            reply = this._call({ fulou: { l: this.lunban, m: mianzi } });
            // A chi/pon obliges us to discard immediately, and the AI returns
            // that discard here. It has to reach the model now, not when the
            // engine echoes it (the echo may not come).
            this._applyReplyDiscard(reply, this.lunban);
        });
        return reply;
    }

    _onDaiminkan(ev) {
        // An open kan in mjai arrives during the discarder's turn, and majiang
        // models it as a `fulou` with a 4-tile mianzi plus a direction marker.
        const actor = ev.actor;
        this._clearStaleRinshan();
        const consumed = (ev.consumed || []).map(T.fromMjai);
        const called = T.fromMjai(ev.pai);
        if (called === null || consumed.some((t) => t === null)) {
            this.onNote('unreadable daiminkan');
            return null;
        }
        // The marker is relative to the CALLER, so it is computed in menfeng
        // space: `T.direction(target, caller)` gives the caller's view of which
        // side the tile came from.
        const caller = this.menfeng(actor);
        const target = this.menfeng(ev.target);
        const dir = directionFor(target, caller);
        const m = T.mianzi(this.Majiang, [called, called, called, called], dir);
        if (m === null) {
            this.onNote(`daiminkan does not form a legal mianzi: ${called}${dir}`);
            return null;
        }

        if (this._isEchoedCall(ev, m)) return null;
        this.appliedCall = {
            type: ev.type, actor: ev.actor, target: ev.target, mianzi: m,
        };

        this.lunban = caller;
        this.diyizimo = false;
        this.rinshanPending = true;
        this.rinshanFrom = actor;

        let reply = null;
        this._withWall(ev, () => {
            reply = this._call({ fulou: { l: caller, m } });
            // An open kan is followed by a replacement draw, not a discard, so
            // the AI should not have returned one — but apply it if it did.
            this._applyReplyDiscard(reply, caller);
        });
        return reply;
    }

    _onAnkanOrKakan(ev) {
        const actor = ev.actor;
        this._clearStaleRinshan();
        const m = this._kanEventMianzi(ev, this.menfeng(actor));
        if (m === null) {
            this.onNote(`unreadable ${ev.type} from ${actor}`);
            return null;
        }

        if (this._isEchoedCall(ev, m)) return null;
        this.appliedCall = {
            type: ev.type, actor: ev.actor, target: ev.target, mianzi: m,
        };

        this.lunban = this.menfeng(actor);
        this.rinshanPending = true;
        this.rinshanFrom = actor;

        let reply = null;
        this._withWall(ev, () => {
            reply = this._call({ gang: { l: this.lunban, m } });
        });
        // A kan also opens a fresh discard window for the kan player, which
        // matters because the kan decision itself produced no discard.
        return reply;
    }

    /**
     * Build the majiang mianzi for a kan EVENT (`ankan` or `kakan`).
     *
     * The two arrive in different shapes on the wire, and majiang spells them
     * differently in the model — neither of which is guessable from the other:
     *
     *   ankan : mjai gives all four tiles in `consumed`, majiang wants the four
     *           digits with no marker (`z1111`).
     *   kakan : mjai gives the ADDED tile in `pai` plus the three from the pon in
     *           `consumed`, and majiang wants the pon's own string with the added
     *           digit appended (`z111+1`). Feeding four digits instead would be
     *           read as a CLOSED kan and would take three tiles out of hand that
     *           are not there.
     *
     * @returns {string|null}
     */
    _kanEventMianzi(ev, menfeng) {
        const consumed = (ev.consumed || []).map(T.fromMjai);
        if (consumed.some((t) => t === null)) return null;
        const added = ev.pai === undefined ? null : T.fromMjai(ev.pai);
        if (ev.pai !== undefined && added === null) return null;

        const tiles = added ? [added, ...consumed] : consumed;
        if (tiles.length !== 4) return null;
        const want = T.canonical(tiles[0]);
        if (!tiles.every((t) => T.canonical(t) === want)) return null;

        if (!added) return T.mianzi(this.Majiang, tiles, '');

        // Added kan: extend the pon the model already holds for that seat.
        const pon = this._ponOf(menfeng, tiles[0]);
        if (pon === null) return null;
        const candidate = pon + tiles[0][1];
        return this.Majiang.Shoupai.valid_mianzi(candidate) === candidate
            ? candidate
            : null;
    }

    /**
     * The pon mianzi a seat holds for `tile`, or null.
     *
     * `Shoupai._fulou` records melds for every seat (opponents' hands are blanks,
     * but their melds are real), so this works for an opponent's added kan too.
     */
    _ponOf(menfeng, tile) {
        const shoupai = this.player.model.shoupai[menfeng];
        if (!shoupai || !shoupai._fulou) return null;
        const want = T.canonical(tile);
        for (const m of shoupai._fulou) {
            const parts = T.mianziParts(m);
            if (!parts || parts.fromHand.length !== 2) continue;
            if (T.canonical(parts.called) === want
                && parts.fromHand.every((t) => T.canonical(t) === want)) {
                return m;
            }
        }
        return null;
    }

    _onReach(ev) {
        // The riichi is carried by the '*' suffix on the discard, which
        // majiang-core applies when that discard is processed. Remember which
        // tile it was so `reach_accepted` can re-state it with the marker, the
        // way majiang's own flow does.
        const tile = T.fromMjai(ev.pai);
        this.pendingReach[this.menfeng(ev.actor)] = tile === null ? '' : tile;
        this.onNote(`reach declared by ${ev.actor}${tile ? ' (' + tile + ')' : ''}`);
    }

    _onReachAccepted(ev) {
        const actor = ev.actor;
        const m = this.menfeng(actor);
        const tile = this.pendingReach[m];
        if (tile === null) {
            this.onNote(`reach_accepted for ${actor} with no declaration`);
            return null;
        }
        this.pendingReach[m] = null;

        if (actor === this.seat) {
            // Our own riichi. When the bot chose it, the '*' on our own discard
            // already set both lizhi flags (the discard went through
            // `Player.dapai`), and re-feeding the tile would deduct the 1000
            // points twice. When the PLAYER declared it instead — manual play,
            // where the echo never carries a marker — nothing has set them yet,
            // and `Board.lizhi` deducts the 1000 points and raises the pot on the
            // next draw, which is what `allow_lizhi` reads.
            const model = this.player.model;
            const ours = this.player.shoupai;
            if (ours && !ours._lizhi) {
                ours._lizhi = true;
                model._lizhi = true;
                this.onNote('our own riichi accepted (marked on reach_accepted)');
            }
            return null;
        }

        if (!tile) return null;

        // An opponent's riichi: re-state their discard with the '*' marker so
        // majiang records them as lizhi (which is what makes the AI treat their
        // discards as dangerous).
        //
        // This is deliberately NOT routed through `Player.dapai` (which is what
        // the wire suggests, since mjai splits a riichi into two events):
        //   * `Board.dapai` would decrease the tile from the riichi player's hand
        //     again — it is already gone, so it would silently eat one of the 13
        //     blanks their censored hand stands in for;
        //   * it would push a second copy of the tile into their river;
        //   * and `Player.dapai` would re-offer us a decision on a discard whose
        //     window is long closed, which can produce a spurious ron.
        // Only the two lizhi flags need setting.
        const model = this.player.model;
        const theirs = model.shoupai[m];
        if (theirs) theirs._lizhi = true;
        model._lizhi = true;
        this.onNote(`reach accepted for ${actor} (${tile}* recorded)`);
        return null;
    }

    // -----------------------------------------------------------------------
    // Dora
    // -----------------------------------------------------------------------

    noteDora(ev) {
        const marker = T.fromMjai(ev.dora_marker);
        if (marker === null) return;
        this.pendingDora.push(marker);
        // Diagnostics only. The wall count does NOT charge for an indicator: the
        // kan's tile is charged by its replacement draw, which is what the library
        // counts (see `wallCount`).
        this.kans++;
    }

    _takePendingDora() {
        const out = this.pendingDora;
        this.pendingDora = [];
        return out;
    }

    /**
     * Hand a held dora marker to the model.
     *
     * Through the PLAYER, not the board: `majiang-ai`'s `kaigang` override also
     * feeds the new indicator to its tile counters (`SuanPai.kaigang` marks that
     * copy of the tile as visible) and drops its cached evaluations. Going
     * straight to `model.shan` did neither, so a decision taken after a kan could
     * be scored from a cache built before the indicator existed.
     */
    _commitDora(marker) {
        this.player.kaigang({ baopai: marker });
    }

    // -----------------------------------------------------------------------
    // Plumbing
    // -----------------------------------------------------------------------

    /**
     * Tiles left in the live wall.
     *
     * `LIVE_WALL_4P` is the 70 tiles that remain after the deal, so the count is
     * `70 - draws`. Every draw counts exactly once, replacement draws included:
     * that is the model `Majiang.Shan` itself keeps (a kan's `gangzimo` shifts the
     * same array `zimo` pops from, so a kan costs the wall one tile, at its
     * replacement draw), and this counter is asserted into the library at every
     * decision — `SuanPai._n_zimo` (a scale factor on every availability estimate
     * the AI makes) and `Board.shan.paishu` (which the library's own last-tile
     * legality rules read). Counting the dead wall or the dora indicators here
     * instead would put the two out of step for the whole interval between a kan
     * and its draw, which is a window a decision can fall inside.
     *
     * KNOWN RESIDUAL: none by construction, except for a draw the wire never
     * reports. The engine can resolve a kan's replacement draw inside
     * `reply_gang`/`reply_dapai` without emitting a message for it, and mjai has no
     * event type of its own for a replacement draw (it arrives as a plain `tsumo`),
     * so a flow that loses that draw would leave this one high. `probe/harness.js`
     * sweeps whole games against the engine's own counter and reports any drift.
     *
     * The floor of 1 is for `SuanPai._n_zimo`, which is a scale FACTOR: setting it
     * to 0 zeroes out every availability estimate the AI makes. The library's own
     * `Board.shan.paishu`, by contrast, is a tile COUNT whose legal value really
     * is 0 on the last draw, and `Player.get_chi_mianzi`/`get_peng_mianzi` read it
     * to forbid calls on that last tile — so the exact count is synced there (see
     * `_withWall`) rather than this floored one.
     */
    get wallCount() {
        return Math.max(1, this.exactWallCount);
    }

    /**
     * Tiles left in the live wall, without the floor `wallCount` applies. This is
     * the honest reconstruction and is what `Board.shan.paishu` is set to.
     */
    get exactWallCount() {
        return LIVE_WALL_4P - this.liveDraws;
    }

    /**
     * Run `fn` with the AI's wall counters set to ours, and collect the candidate
     * list it evaluates along the way.
     *
     * TWO counters need re-asserting, and they are read by different halves of
     * the library:
     *
     *  - `SuanPai._n_zimo` is the global scale factor on every tile-availability
     *    estimate the AI makes.
     *  - `Board.shan.paishu` is what the AI's own legality checks read through
     *    `Player.get_chi_mianzi` / `get_peng_mianzi` / `get_gang_mianzi` /
     *    `allow_lizhi` / `allow_hule` / `allow_no_daopai`. Only our own draws
     *    ever reach `Player.zimo`, so without this it sat near 70 for the whole
     *    hand while the real wall ran down to 0 — which disabled the "no calls on
     *    the last tile" rule, let a riichi be declared with fewer than four tiles
     *    left, and mislabelled the last-tile tsumo.
     *
     * The candidate list is gathered by temporarily wrapping `select_dapai` /
     * `select_fulou`: the AI pushes `{p|m, n_xiangting, ev, ...}` rows into the
     * `info` array it is passed, and that array is the raw material for the HUD
     * card (see show.js). The wrappers are restored in `finally` so a throwing
     * decision cannot leave the player patched.
     *
     * @param {object} trigger  the mjai event that opened the decision, used to
     *                          work out what the model permits us to answer
     */
    _withWall(trigger, fn) {
        const suanpai = this.player._suanpai;
        if (suanpai) suanpai._n_zimo = this.wallCount;
        const shan = this.player.shan;
        // Clamped at 0, not at 1: the count is allowed to reach zero and the
        // library's own last-tile rules key off exactly that.
        if (shan) shan.paishu = Math.max(0, this.exactWallCount);

        // Remember which decision is being answered. `_call` reads the legal set
        // off it (see the note there) — it is NOT computed here, because at this
        // point the model has not been advanced yet: a draw decision has not
        // drawn, so nothing but a discard would look legal.
        this.trigger = trigger;

        const p = this.player;
        const origDapai = p.select_dapai;
        const origFulou = p.select_fulou;
        const info = [];

        p.select_dapai = function patched(arg) {
            return origDapai.call(this, arg === undefined ? info : arg);
        };
        p.select_fulou = function patchedFulou(dapai, arg) {
            return arg === undefined
                ? origFulou.call(this, dapai, info)
                : origFulou.call(this, dapai, arg);
        };

        try {
            const reply = fn();
            this.lastCandidates = info;
            // A decision happened this call. The callback fires even when the AI
            // passes (with `{}`), so `asked` — not the null-ness of the reply —
            // is what distinguishes "we were consulted and declined" from "this
            // event opened nothing for us". Losing that distinction makes the
            // bridge stay silent on an explicit pass, which desyncs Akagi.
            //
            // Set inside the `try`, not in `finally`: a decision that threw did
            // not happen, and `main.js` must not attribute the reply (or the
            // trigger) of a failed decision to the next event.
            this.asked = true;
            return reply;
        } finally {
            p.select_dapai = origDapai;
            p.select_fulou = origFulou;
            if (suanpai) suanpai._n_zimo = this.wallCount;
            if (shan) shan.paishu = Math.max(0, this.exactWallCount);
        }
    }

    // -----------------------------------------------------------------------
    // Legality
    // -----------------------------------------------------------------------

    /**
     * The tile an opponent just offered us, in majiang notation, plus the
     * direction marker as WE see it — i.e. exactly the argument the library's
     * `get_*_mianzi` / `allow_hule` want.
     *
     * @returns {{tile: string, called: string}|null}
     */
    _offeredTile(trigger) {
        if (!trigger) return null;
        let tile = null;
        if (trigger.type === 'dahai') {
            tile = T.fromMjai(trigger.pai);
        } else if (trigger.type === 'kakan' || trigger.type === 'daiminkan'
            || trigger.type === 'ankan') {
            // A kan exposes a tile to chankan (and an ankan only to a kokushi
            // ron); mjai names it in `consumed`, since the mianzi is not on the
            // wire.
            const consumed = Array.isArray(trigger.consumed) ? trigger.consumed : [];
            tile = consumed.length ? T.fromMjai(consumed[0]) : null;
        }
        if (tile === null) return null;
        return { tile, called: tile + T.direction(this.menfeng(trigger.actor), this.player._menfeng) };
    }

    /**
     * The action types the model permits for the decision `trigger` opened.
     *
     * This is what makes the "legal-action gate" real: Akagi's mjai stream
     * carries no legal set, so the bridge derives one from its own model with the
     * same library predicates the AI used to decide. A reply whose type is absent
     * here is downgraded to `none` by `from_majiang._gate`, because an action the
     * engine rejects costs the game, while silence only costs the turn.
     *
     * It is a TYPE-level gate: it catches "nothing of this kind is legal at all"
     * — an abortive draw mid-hand, a riichi with no legal discard, a call with no
     * mianzi, a ron while furiten. Which exact tile or mianzi to use is the AI's
     * business, and it picks from the same lists.
     *
     * @param {object} trigger
     * @returns {string[]}
     */
    _legalTypes(trigger) {
        const type = trigger ? trigger.type : null;
        const mine = !!trigger && trigger.actor === this.seat;
        const p = this.player;
        const shoupai = p.shoupai;
        if (!type || !shoupai) return [];

        const attempt = (fn, dflt) => {
            try {
                const v = fn();
                return v === undefined || v === null ? dflt : v;
            } catch (e) {
                return dflt;
            }
        };

        // Our own draw: the discard, plus whatever that drawn hand allows.
        if (type === 'tsumo' && mine) {
            const types = ['dahai'];
            const dapai = attempt(() => p.get_dapai(shoupai), []);
            const canReach = dapai.some((d) => attempt(
                () => p.allow_lizhi(shoupai, d.replace(/[*_]+$/, '')), false));
            if (canReach) types.push('reach');
            for (const m of attempt(() => p.get_gang_mianzi(shoupai), [])) {
                types.push(/\d{4}/.test(m) ? 'ankan' : 'kakan');
            }
            if (attempt(() => p.allow_hule(shoupai, null), false)) types.push('hora');
            if (attempt(() => p.allow_pingju(shoupai), false)) types.push('ryukyoku');
            return types;
        }

        // Our own chi/pon opens the discard the call obliges.
        if (mine && (type === 'chi' || type === 'pon' || type === 'daiminkan')) {
            return ['dahai'];
        }

        // A kan of our own is answered with nothing: the replacement draw comes
        // next, and it opens its own decision.
        if (mine && (type === 'ankan' || type === 'kakan')) return [];

        // Somebody else's discard or kan: what we may claim from it.
        if (type === 'dahai' || type === 'kakan' || type === 'daiminkan'
            || type === 'ankan') {
            const offered = this._offeredTile(trigger);
            if (!offered) return [];
            const types = [];
            if (attempt(() => p.allow_hule(shoupai, offered.called), false)) {
                types.push('hora');
            }
            if (type === 'dahai') {
                if (attempt(() => p.get_gang_mianzi(shoupai, offered.called), []).length) {
                    types.push('daiminkan');
                }
                if (attempt(() => p.get_peng_mianzi(shoupai, offered.called), []).length) {
                    types.push('pon');
                }
                if (attempt(() => p.get_chi_mianzi(shoupai, offered.called), []).length) {
                    types.push('chi');
                }
            }
            return types;
        }

        return [];
    }

    /**
     * Apply our own chosen discard to the model.
     *
     * `dapai` is majiang's notation — a tile plus optional `_` (tsumogiri) and
     * `*` (riichi) — and it goes through the library's own entry point rather
     * than poking `model.he` / `shoupai` directly, because `Player.dapai` is what
     * maintains three pieces of state the AI reads back:
     *
     *  - `Board.dapai` sets `_lizhi` from the '*' marker, and that is what makes
     *    `Board.lizhi()` deduct the riichi's 1000 points (and raise the pot) on
     *    our next draw. Setting only `shoupai._lizhi` left the model's score
     *    1000 too high, and `allow_lizhi` reads that score through
     *    `defen[this._id]` to decide whether the riichi is affordable.
     *  - `Player.dapai` clears `_diyizimo`, without which `allow_pingju` keeps
     *    seeing "my first uninterrupted turn" and can offer a nine-terminals
     *    abort in the middle of the hand.
     *  - It re-arms `_neng_rong` (and re-derives permanent furiten from our own
     *    river). This is the ONLY place that clears temporary furiten, so
     *    skipping it made a single missed ron permanent for the rest of the hand.
     *
     * The callback is suppressed: this is us answering a question, not being
     * asked a new one, and `Player.dapai` would otherwise offer the discard back
     * to the AI as a decision. The river therefore keeps the marker exactly as
     * the engine stores it (see `Game.dapai`).
     */
    _applyOwnDiscard(menfeng, dapai) {
        if (typeof dapai !== 'string' || dapai === '') return;
        const p = this.player;
        const saved = p._callback;
        p._callback = null;
        try {
            p.dapai({ l: menfeng, p: dapai });
        } finally {
            p._callback = saved;
        }
        this.lastDiscard[menfeng] = dapai.replace(/[*_]+$/, '');
    }

    /**
     * The player threw something other than the bot's choice.
     *
     * The model applied the bot's choice the moment it answered, so the two hands
     * are now one tile apart: the model is missing the tile the player really
     * threw and still holds the one the bot wanted gone. Every later candidate
     * list is computed from that wrong hand — which is the "candidates do not
     * match my hand" report — until the AI happens to discard the phantom and
     * heals the model by luck.
     *
     * The game is the authority, so the model is put back in step: the bot's tile
     * goes back into the hand and the player's tile comes out through the
     * ordinary discard path, which also records the right tile in the river and
     * re-runs the furiten bookkeeping against what was really thrown.
     *
     * Three other pieces of state were written by the discard that never happened
     * and are undone here:
     *
     *   the river      the bot's tile is in it, and it is what `Player.dapai`
     *                  reads for furiten ("did we already throw this winning
     *                  tile?") — a phantom entry can silence a real win;
     *   `_suanpai`     its danger table marked the tile as ours, and a riichi it
     *                  never declared would be recorded as one;
     *   the lizhi flags  a bot-chosen riichi the player did not take must not
     *                  cost the 1000 points, which `Board.lizhi` deducts on the
     *                  next draw.
     *
     * `_neng_rong` needs no undo: the replacement discard below re-arms it and
     * then re-derives furiten from the river as it now stands.
     *
     * `chosen` is majiang notation and may carry the tsumogiri/riichi markers;
     * only the tile part goes back into the hand. The echo never carries a riichi
     * marker (mjai splits a riichi into a separate `reach`), and a
     * player-declared riichi is picked up by `_onReachAccepted`.
     */
    _reconcileOwnDiscard(menfeng, chosen, echoTile, tsumogiri) {
        const player = this.player;
        const shoupai = player.shoupai;
        const bare = chosen.replace(/[*_]+$/, '');
        const thrown = T.toMjai(echoTile);
        const wanted = T.toMjai(bare);
        this.onNote(`player discarded ${thrown} instead of the bot's ${wanted}; reconciling`);

        // 1. Undo the discard that never happened.
        const he = player.model.he[menfeng];
        const key = bare[0] + (+bare[1] || 5);
        const last = he._pai[he._pai.length - 1];
        if (last !== undefined && last.replace(/[*_]+$/, '') === bare) {
            he._pai.pop();
            const stillThere = () => he._pai.some((p) => p[0] + (+p[1] || 5) === key);
            if (!stillThere()) delete he._find[key];
            const suanpai = player._suanpai;
            if (suanpai && suanpai._dapai && suanpai._dapai[menfeng] && !stillThere()) {
                delete suanpai._dapai[menfeng][key];
            }
            if (chosen.includes('*')) {
                if (suanpai && suanpai._lizhi) suanpai._lizhi[menfeng] = false;
                shoupai._lizhi = false;
                player.model._lizhi = false;
            }
        } else {
            this.onNote(`the river does not end with ${wanted}; leaving it alone`);
        }

        // 2. Put the bot's tile back ...
        try {
            // `check = false`: the hand is not being drawn into, and a stale
            // `_zimo` here is exactly the state this method exists to repair.
            shoupai.zimo(bare, false);
        } catch (e) {
            this.onNote(`could not restore ${wanted}: ${e.message}`);
            return;
        }

        // 3. ... and take the player's out, through the ordinary path so the
        //    river, the score and the furiten bookkeeping all follow it.
        this._applyOwnDiscard(menfeng, tsumogiri ? echoTile + '_' : echoTile);
    }

    /**
     * Drop a rinshan flag whose replacement draw is never going to arrive.
     *
     * A kan promises a replacement draw, but the hand can end before it happens
     * (a win on the kan itself, an abortive draw). Left set, the flag would
     * excuse the *next* real draw from the wall and make the live-wall count
     * drift upwards by one per occurrence, which quietly skews every
     * tile-availability estimate the AI makes afterwards.
     *
     * Any event OTHER than the expected draw is the signal: once anyone
     * discards, calls, kans again, or the hand ends, the kan's draw window has
     * passed.
     */
    _clearStaleRinshan() {
        this.rinshanPending = false;
        this.rinshanFrom = null;
    }

    /**
     * Apply a discard the AI chose in reply to a request, if it chose one.
     *
     * Both request shapes need this. After our own draw the discard arrives as
     * `{dapai}`, and after our own chi/pon/kan it *also* arrives as `{dapai}` —
     * but the call path used to skip it, which left the drawn tile sitting in
     * `_zimo` (majiang sets `_zimo` to the meld when a call is applied) and the
     * concealed hand one tile too long for the rest of the hand. majiang-core
     * then rejected every later event, which reads as the bot hanging.
     *
     * @param {object|null} reply  the AI's reply
     * @param {number} menfeng     our own seat, in majiang space (always 0 here)
     */
    _applyReplyDiscard(reply, menfeng) {
        if (!reply || typeof reply.dapai !== 'string') return;
        this._applyOwnDiscard(menfeng, reply.dapai);
        // Remember the choice so the echoed event can put the right tile on the
        // river without re-applying the discard itself.
        this.ourDiscard = reply.dapai;
    }

    /** Push an event and capture the AI's synchronous callback reply. */
    _call(msg) {
        // Any explanation left over from a previous decision is stale the moment
        // a new question is asked.
        this.lastCallCard = null;
        let reply = null;
        this.player.action(msg, (r) => {
            reply = r;
            // The legal set has to be read HERE, and this is the only moment that
            // works. By now the library has advanced the model to the decision
            // (it has drawn, or applied the discard we are claiming on) and the
            // AI has answered, but our own reply has NOT been applied yet — once
            // it is, the model describes the position after the move and every
            // alternative looks illegal. Reading it before the question is asked
            // is just as wrong: a draw decision has not drawn yet, so nothing but
            // a plain discard is visible and every riichi, kan, tsumo and abortive
            // draw gets refused.
            this.lastLegal = this.trigger ? this._legalTypes(this.trigger) : null;
        });
        return reply;
    }

    /** Build the bot's own hand string from `tehais[seat]`. */
    _ourHandString(tehais) {
        const raw = (tehais && tehais[this.seat]) || [];
        const tiles = [];
        for (const t of raw) {
            const m = T.fromMjai(t);
            // Our own hand is never censored; if it ever is, deal an empty hand
            // rather than throwing mid-game.
            if (m !== null) tiles.push(m);
        }
        return T.serialize(tiles);
    }

    /**
     * Scores in MAJIANG seat order (menfeng `i` = absolute seat
     * `(qijia + jushu + i) % 4`), which is the order `qipai.defen` must be in.
     *
     * The menfeng index is NOT always the bot's own: the view makes the bot its
     * own base dealer, so `menfeng(seat)` is `(4 - jushu) % 4` and rotates with
     * the hand counter (0, 3, 2, 1, …), not 0.
     *
     * `Board.qipai` then re-indexes the array by `player_id[l]`, so what the AI
     * finally reads through `defen[this._id]` is the bot's own score, which is
     * what `allow_lizhi` checks against 1000.
     */
    _scores(scores) {
        const out = [];
        for (let i = 0; i < 4; i++) {
            const abs = (this.qijia + this.jushu + i) % 4;
            out.push(Array.isArray(scores) && typeof scores[abs] === 'number'
                ? scores[abs]
                : 25000);
        }
        return out;
    }

    /**
     * Assemble a majiang mianzi string for a chi or pon.
     *
     * `T.mianzi` normalises the ordering (and the red-five placement) through
     * majiang-core itself, and — because the marker identifies the called tile —
     * it is the called tile that has to be passed FIRST, whatever its rank in the
     * run.
     */
    _fulouString(ev) {
        const called = T.fromMjai(ev.pai);
        const consumed = (ev.consumed || []).map(T.fromMjai);
        if (called === null || consumed.some((t) => t === null)) return null;
        // The marker is the caller's view of where the tile came from, and it is
        // computed in menfeng space. NOTE the argument order below: `directionFor`
        // takes (discarder, caller) — the mjai `target` is who discarded — despite
        // its parameter names; see the note on the function.
        const dir = directionFor(this.menfeng(ev.target), this.menfeng(ev.actor));
        // Three tiles: the called tile plus the two from hand.
        return T.mianzi(this.Majiang, [called, ...consumed], dir);
    }
}

/**
 * The direction marker majiang attaches to a called tile, from the CALLER's
 * point of view.
 *
 * ARGUMENT ORDER: the first argument is the seat that DISCARDED (mjai's
 * `target`), the second is the seat that CALLED (mjai's `actor`). Both may be in
 * absolute or menfeng space as long as they are in the SAME space, because only
 * the difference is used.
 *
 * The arithmetic is the same table majiang-core builds in `Game.get_chi_mianzi`:
 * `'_+=-'[(4 + lunban - caller) % 4]`, where `lunban` is the discarder — so a
 * tile called from the player who plays immediately BEFORE the caller (its
 * left-hand player, the only side a chi may come from) is `'-'`, and one from
 * the player after it is `'+'`. Getting this backwards is not cosmetic: `'-'` is
 * the only marker `Shoupai.get_chi_mianzi` will produce a run for.
 *
 * @param {number} discarder
 * @param {number} caller
 * @returns {string} '', '+', '=' or '-'
 */
function directionFor(discarder, caller) {
    const offset = (((caller - discarder) % 4) + 4) % 4;
    return { 0: '', 1: '-', 2: '=', 3: '+' }[offset];
}

/** mjai round wind string → majiang `zhuangfeng` index. */
function bakazeToNumber(bakaze) {
    const idx = { E: 0, S: 1, W: 2, N: 3 }[bakaze];
    return idx === undefined ? 0 : idx;
}

module.exports = {
    MajiangDriver,
    directionFor,
    bakazeToNumber,
    LIVE_WALL_4P,
};
