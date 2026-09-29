# kobalab — Akagi bot running 電脳麻将's AI

An [Akagi](https://github.com/shinkuan/Akagi) bot that plays using
[`@kobalab/majiang-ai`](https://github.com/kobalab/majiang-ai) — the thinking
routine from 電脳麻将 (Satoshi Kobayashi's mahjong app) — unmodified.

The two projects do not fit together directly, so this bot is a **bridge**:

|  | Akagi | majiang-ai |
| --- | --- | --- |
| form | Tauri/Rust desktop app | Node.js library |
| bot interface | a **subprocess** that speaks JSON lines on stdin/stdout | an in-process `Majiang.Player` subclass |
| protocol | **mjai** (`dahai`, `tsumo`, `reach`, …) | **majiang-core** events (`dapai`, `zimo`, `lizhi`, …) |
| driven by | one request → one action | the engine pushes events; the player answers in a **callback** |
| entry point Akagi looks for | `bot.py` | JavaScript |

```
Akagi (Rust)                                   mjai_bot/kobalab/
   │  spawns  venv-python bot.py <seat>          ┌────────────────────────┐
   ├────────────────────────────────────────────►│ bot.py   (thin shim)   │
   │   stdin : one JSON array per line           │  subprocess.Popen      │
   │   stdout: exactly one JSON action per line  │   ↓ stdin    ↑ stdout   │
   │   stderr: logs + @@AKAGI_NOTIFY@@ toasts    └───┬────────────────────┘
   │                                                 │ node bridge/main.js
   └─────────────────────────────────────────────────┤  mjai ⇄ majiang
                                                     └─ require('@kobalab/majiang-ai')
```

## Install

There are two ways in, and they end at the same place:

- **Akagi's installer** — *Bots* tab → install from a local `.zip` → pick
  `kobalab.zip`. Nothing needs renaming: the archive's single top-level folder is
  `kobalab`, and the installer names the bot after the zip stem, so the folder
  comes out right (see step 2 for why that matters). Install a copy under that
  name only — the same archive saved as `kobalab-bot.zip` would install to
  `mjai_bot/kobalab-bot/`, and Akagi would key the settings and the UI row off
  that instead.
- **By hand** — unzip it so that `<akagi>/mjai_bot/kobalab/bot.py` exists. A
  nested `kobalab/kobalab/` is the usual mistake.

Then:

1. **Node.js ≥ 18 must be on `PATH`.** The bridge checks at start-up and reports a
   toast if it is missing, rather than letting Akagi time out on every turn.
   `KOBALAB_NODE` overrides the lookup if you keep Node somewhere unusual.
2. The bot's folder must be named **`kobalab`** — so you end up with
   `<akagi>/mjai_bot/kobalab/bot.py`.

   The name is not cosmetic. Akagi identifies a bot by the name of the directory
   containing `bot.py`: the Bots list, `settings.toml`, and the UI row are all
   keyed by it. A mismatch shows up as *"my setting will not save"* — the panel
   writes under one name and reads under another. `doctor.js` checks for exactly
   this, and the shipped archive unpacks to a `kobalab/` folder so the correct
   name comes for free.

   Where that folder goes: Akagi resolves `bot.dir` (default `mjai_bot`)
   relative to its executable's directory first, then the working directory —
   see `util::resolve_dir` in Akagi's `src/util/mod.rs`. The Bots page prints the
   resolved path under each bot, so that is the quickest way to confirm.

   ```
   akagi-3.7.1-windows-x64/
   └── mjai_bot/
       └── kobalab/          <- the folder name must be `kobalab`
           ├── bot.py
           ├── manifest.toml
           └── ...
   ```
3. In Akagi's **Bots** tab, click **Install environment** on the `kobalab` row.

   Akagi requires a `pyproject.toml` on every subprocess bot
   (`src/bot/manager.rs`: *"bot … has no pyproject.toml — required for uv sync"*),
   so this one ships a minimal, dependency-free one and the button runs a `uv
   sync` that creates the bot's virtualenv. The bot itself imports only the
   standard library, so the sync installs nothing and is quick; `bot.py` then
   runs under the venv's interpreter.

4. Activate it in Akagi's **Bots** tab — the **4p** toggle on that row.

   The toggle stays disabled until step 3 has run once (Akagi refuses to
   activate a bot whose environment is not installed, so the first game cannot
   stall on a sync).

### If a setting will not save

Run the bundled check from inside the installed folder:

```sh
cd <akagi>/mjai_bot/kobalab
node doctor.js
```

It walks the whole chain — `manifest.toml` → `settings.toml` →
`.akagi/resolved_settings.json` → `AKAGI_BOT_CONFIG` — and prints what each file
literally says, so the first disagreement is visible instead of inferred. The
most common finding is the folder-name mismatch described above.

Settings are applied when Akagi **spawns** the bot, i.e. at the start of a game.
A change made mid-game takes effect on the *next* game, not the current one.

### About the JavaScript dependencies

`package.json` declares `@kobalab/majiang-ai` and `@kobalab/majiang-core`, and
the shipped archive already includes them under `node_modules` — there is no
`npm install` step. If you installed from source instead, run it once:

```sh
cd mjai_bot/kobalab && npm install --omit=dev
```

`uv` and npm manage different halves of this bot and neither replaces the other:
uv builds the Python venv that runs `bot.py`, npm supplies the Node libraries
that `bridge/` requires. A `pyproject.toml` with an empty `dependencies` list is
what Akagi demands; it is not where the Node side is declared.

## Windows notes

Akagi does **not** bundle Node, so it must be installed on the machine. The shim
searches for it in this order and reports every path it tried when it fails:

1. `KOBALAB_NODE`, if set
2. `node` / `node.exe` / `nodejs` on `PATH`
3. the usual install locations — `C:\Program Files\nodejs\node.exe`,
   `%APPDATA%\nvm\node.exe` (nvm-windows),
   `%LOCALAPPDATA%\Microsoft\WindowsApps\node.exe`,
   `%LOCALAPPDATA%\Programs\nodejs\node.exe`,
   `C:\ProgramData\chocolatey\bin\node.exe`, and the Scoop shim

Each candidate is *run* with `--version` before it is accepted, which matters for
one Windows-specific trap: installing Node from the Microsoft Store creates an
**App Execution Alias** at `%LOCALAPPDATA%\Microsoft\WindowsApps\node.exe`. That
file looks present but does not behave like a normal executable, so a plain
existence check would accept it and then fail confusingly on the first spawn.
The version probe rejects it and the search moves on.

If Node is already installed and the bot still reports it missing, the usual
cause is that Akagi was started in a way that did not inherit your user `PATH` —
installing Node while Akagi is running is the common case, and a GUI app keeps
the environment it was launched with. Either restart Akagi, or set `KOBALAB_NODE`
to the full path and be done with it:

```
setx KOBALAB_NODE "C:\Program Files\nodejs\node.exe"
```

(`setx` affects processes started afterwards; restart Akagi for it to take.) If
you would rather not install Node system-wide, it is enough to unzip a Node
portable build anywhere and point `KOBALAB_NODE` at its `node.exe`.

## Running it without Akagi

The bridge is an ordinary program, so it can be driven by hand:

```sh
cd kobalab-bot
echo '[{"type":"start_game","names":["a","b","c","d"],"id":0,"num_players":4}]' | node bridge/main.js 0
```

One JSON batch per line in, exactly one JSON action per line out:

```
$ node bridge/main.js 2 < batches.jsonl
{"type":"none"}
{"type":"dahai","actor":2,"pai":"1m","tsumogiri":false,
 "meta":{"show":{"title":"打牌候选（选 1m）","items":[…]}}}
```

## Layout

What the shipped archive unpacks to, i.e. `<akagi>/mjai_bot/kobalab/`:

```
```
kobalab-bot/                (the git repository root)
├── bot.py              Akagi's entry point; runs the Node bridge and wires stdio
├── pyproject.toml      REQUIRED by Akagi; empty dependencies, just builds the venv
├── manifest.toml       display metadata, supported_modes=["4p"], settings
├── package.json        @kobalab/majiang-ai + majiang-core (pinned by lockfile)
├── node_modules/       the two libraries, vendored — no npm step at install time
├── doctor.js           settings-chain check; `node doctor.js` in the bot folder
├── bridge/
│   ├── main.js         the JSONL loop; one reply per batch, always
│   ├── tiles.js        mjai ⇄ majiang tile and hand notation
│   ├── to_majiang.js   mjai event stream → drives a majiang-core Player
│   ├── from_majiang.js the Player's decision → an mjai action
│   └── show.js         candidate list → Akagi's `meta.show` HUD card
├── test/               per-layer unit suites (node test/test_tiles.js, …)
├── probe/harness.js    whole games, cross-checked against majiang-core's board
├── pack_kobalab.py     builds the installable `kobalab.zip` (also run by CI)
└── .github/workflows/release.yml   tag `v*` → build zip → attach to the Release
```

The archive Akagi installs contains everything above except the packaging and
CI plumbing (`pack_kobalab.py`, `.github/`, `.git*`) — `pack_kobalab.py` enforces
that exclusion itself, so what ships stays exactly the bot.

## The nine things that make this work

Everything below was established by experiment against the installed libraries
and is documented at the point in the code where it is relied on. The list is
longer than it looks like it should be because the failure mode of getting one of
them wrong is a *silent* one: a dropped decision, a wrong number on the overlay,
or a model that quietly stops matching the table.

**1. Seat coordinates.** majiang-core uses one index space for two meanings
(`Player`'s getters index the model by `_menfeng`, while `Board` reads and writes
it by the event's `l`), and mjai gives absolute seats. The bridge sets
`kaiju.qijia` to the game's base dealer and stores the bot's hand at its
**menfeng** index, translating each event's actor with
`(actor - qijia - jushu) % 4`. The obvious alternative — rotating the bot to
index 0 — puts the hand where `Board.zimo` never writes, and the AI then passes
every turn.

`jushu` is the hand counter **within the round**, 0..3, with the round itself
carried by `zhuangfeng`. That distinction is load-bearing rather than cosmetic:
`Board.menfeng` and `majiang-ai`'s `SuanPai.qipai` both rotate seats with
`(id + 8 - qijia - jushu) % 4`, which only stays non-negative for 0..3. Feeding
them a game-wide index (up to 7 in a hanchan) makes that expression negative from
South 2 on; JavaScript's `%` keeps the sign, `SuanPai.qipai` indexes
`qipai.shoupai[-1]`, throws on the undefined hand and rejects every later event —
the bot plays the rest of the game answering `none`. The seat rotation is
unaffected either way, `(jushu + 4) ≡ jushu (mod 4)`.

**2. The live-wall count.** `SuanPai`'s `_n_zimo` is a *global scale factor* on
every tile-availability estimate, and `Board.shan.paishu` is what the AI's own
legality checks read instead, so the bridge tracks the wall precisely and
re-asserts **both** at every decision. The model is the library's own: every draw
counts once, opponent draws included even though their tile is censored to `"?"`
(the AI only decrements a counter for them, which is exactly right), and a kan
costs one tile — charged at its replacement draw, which is where `Majiang.Shan`
charges it (its `gangzimo` shifts the same array `zimo` pops from). Its extra dora
indicator is *not* charged separately: charging it at the announcement instead
leaves the two counters one apart for the whole interval between a kan and its
draw, and a decision can fall inside that interval — which is exactly what a
per-message comparison against the engine showed.

**3. Our own discard.** A player is not reliably told about its own discard, so
the bridge applies the choice the AI returns as soon as it returns it, rather
than waiting for an echo that may never come. It applies it through
`Player.dapai`, not by poking the model, because that call is what maintains the
state the AI then reads back: the riichi flag (and so the 1000 points and the
pot), `_diyizimo` (a stuck flag lets a nine-terminals abort appear mid-hand) and
`_neng_rong` — the only place temporary furiten is ever cleared, so skipping it
made a single missed ron permanent for the rest of the hand.

**4. A seat is never asked about its own discard.** Akagi echoes our own
discard back to us (`Majiang.Game` notifies all four seats), and feeding it to
the AI applied the discard to the model a second time — the tile was already
gone, so `Shoupai.dapai` threw, every later event was rejected, and the bot could
only answer `none`. That is what "the bot hangs after a call" actually was. The
echo is now absorbed rather than re-applied, and a seat's own chi/pon is
recognised when it comes back for the same reason.

**5. A declined call is still a decision.** The AI is conservative — most call
windows end in a pass — and it does not keep the calls it rejects, so a declined
call used to produce no output at all. The driver re-derives the comparison from
the AI's own evaluator (throwaway clones only) and the overlay explains it. See
*What the overlay shows*.

**6. Every reply is gated.** An action is only emitted if the model permits it;
anything else becomes `{"type":"none"}`. Akagi's own bundled bot uses the same
"legal-action gate" idea, but the mjai stream carries no legal set, so the bridge
derives one from its own model with the same library predicates the AI decided
with (`MajiangDriver.lastLegal`) and hands it to the translator. It is a
type-level gate — it catches "nothing of this kind is legal now": an abortive
draw mid-hand, a riichi the wall forbids, a call with no mianzi, a ron while
furiten — while which tile or mianzi to use stays the AI's business, since it
picks from those same lists. Staying silent is recoverable; desynchronising the
game is not. Exceptions are contained the same way: any failure inside the bridge
produces `none` for that batch and a line on stderr, never a dead process — Akagi
kills a bot that stops answering.

**7. A riichi is one action.** mjai spells a riichi as a declaration plus the
discard it is declared on, but Akagi reads exactly one action per batch and keeps
the declaring tile on `Reach.pai` — a documented non-spec extension — and its
autoplay stalls on a `reach` that does not name the discard. Anything smuggled
into `meta` is ignored: Akagi's `meta` is free-form HUD data and the backend never
interprets it, so a trailing `dahai` in there is simply lost.

**8. A censored draw still has to reach the model.** The model holds a hand for
all four seats. For the three the wire censors, `Board.qipai` fills that hand with
thirteen blanks, and *every* event from that seat spends from it: `Shoupai.decrease`
charges a tile it does not hold to the blanks, so a discard costs one blank, a chi
two, a pon two and a closed kan four. Only a draw puts one back. So an opponent's
`tsumo` — whose tile is `"?"`, and which therefore looks like an event with
nothing to apply — is in fact the *only* thing keeping that placeholder alive.
Skip it and the placeholder empties after that seat's thirteenth discard, at which
point `decrease` throws; and because `Board.dapai` spends the blank *before* it
records the tile in the discarder's river, the throw takes the river entry with
it, so the next call on that tile fails too. The bridge therefore feeds every draw
through `Player.zimo` with `'_'` — the library's own word for a tile it cannot see
— for all four seats.

**9. A red five in a meld is positional.** `He.fulou` recovers the called tile
from a meld string as "the digit the marker follows" and compares it against the
discarder's river, and `p5` and `p0` are different tiles to it. So a set has to be
spelled `<copies from hand><called tile><marker>`, with the called copy last and
the marker on it — the library's own form (`Shoupai.get_peng_mianzi` writes
`s50` + `5` + `=` when an ordinary five is called by a hand holding the red one,
and `s55` + `0` + `=` when the red five is). Building the digits in any other
order puts the marker on the wrong copy of the five, and the pon silently fails.

**10. The player can override the bot.** Manual play makes the bot's answer a
suggestion: the tile that actually leaves the hand is whatever the player threw,
and it comes back as an echo that may name a *different* tile from the one the
bridge already applied. That difference is information, not noise — swallowing
it (which this used to do) left a phantom tile in the model, and every later
candidate list was then computed for a hand the player does not have, until the
AI happened to discard the phantom and healed the model by luck. The echo is now
reconciled: the bot's tile goes back into the model hand, the player's tile
comes out through the ordinary discard path, and the discard that never happened
is un-recorded from the river, the danger table and the riichi flags.

## What the overlay shows

Two different cards, depending on whether the AI took the call:

**It called** — the ranked calls, with the chosen one first:

```
鸣牌候选（选 2m）
  碰 2m      868   听牌
  不鸣 (Pass) 826   向听 1
```

**It passed** — a call judgement, because a silence here is misleading:

```
鸣牌判断（不鸣，对方打 3s）
  不鸣 (Pass)  2066   向听 1
  碰 3s           0   听牌 · 听牌前进 1 · 差 -2066     ← red
```

The heading reads **对方打** (they discarded), not `打`. The distinction is worth
keeping: the tile named on a call window is the OPPONENT's discard — the one we
were offered — while a discard card's heading names the tile the bot is about to
throw. Both used to read `打 X`, so a declined pon on a tile the hand did not even
hold looked exactly like advice to discard it.

That second card exists because `@kobalab/majiang-ai` is deliberately
conservative and **most call windows end in a pass**: `select_fulou` accepts a
call only when its own evaluation strictly beats not calling, and it does not
record the calls it rejects. Without the card, a declined call produced no output
at all, which reads as "the bot never considered it" when in fact it weighed the
option and declined. Every row is computed with the AI's own `eval_shoupai` and
`get_paishu()`, so the numbers are the same currency as the decision itself; a
call that would actually have been better is coloured green rather than red, so
the rare miss is visible instead of hidden.

Cards only appear when there was a real decision. An opponent's discard you
cannot call — no matching tiles at all — stays silent, and so does a turn where
you are merely drawing and discarding.

## Verification

Two layers, both runnable offline:

```sh
# per-layer unit suites
node test/test_tiles.js        # notation, red fives, meld spelling, serialization
node test/test_decisions.js    # decision → mjai action, incl. Akagi's schema
node test/test_translator.js   # event stream → majiang, wall accounting, kans
node test/test_bridge.js       # batches in, one action out
npm test                       # all four

# whole games, compared against the engine
npm run harness                # = node probe/harness.js --games 2 --rounds south
node probe/harness.js --games 6                     # 6 seeded games per seat
node probe/harness.js --games 2 --rounds east --seed 97
```

Both commands are written for the repository layout, where the harness sits at
`probe/` and the bot's files are at the root. The layout inside the installed
archive (`mjai_bot/kobalab/`) has the same shape, and the harness resolves the
bot directory in either place — if that resolution were wrong it would silently
test a stale copy of the bridge, which is the one failure that would make the
whole sweep lie.

The harness plays real games with `Majiang.Game`, injects the bridge as the
player for one seat, feeds it a **censored** mjai view of every message (opponent
hands and draws replaced by `"?"`), and after every message compares the bridge's
model against the **engine's own board** — the concealed tiles, the melds, and the
live-wall count. A mismatch is reported with the exact event that caused it:

```
$ node harness.js --games 4
  seat 0 game 0: seed    11   9 hands   811 messages  ok
  ...
24 game(s), 225 hands, 21971 engine messages replayed.
RESULT: bridge model matched the engine after every message.
```

Two things about that comparison are what make it worth trusting, and both were
learned the hard way: the reference has to come from the ENGINE (comparing the
bridge against itself is vacuously true and hides exactly these bugs), and the
comparison has to know where the two are legitimately one step apart (the engine
applies a message to its board before notifying, and applies our reply only after
we return it).

Because a failure at one seat in one hand is a needle, the sweep is what matters:
run it with a large `--games` before trusting a change. Every wall-accounting rule
in `to_majiang.js` exists because that sweep found the counter drifting — a kan's
replacement draw, a kan's dora indicator, another seat's rinshan flag, a kan whose
replacement draw never arrived, and finally the *order* of the dora and the draw
were each a separate bug, and each now has a named regression test in
`test/test_translator.js` (section 8b).

`--rounds` picks the game length (`1`, `east`, `south`, `full`); multi-hand games
are the default because the seat rotation only moves with the hand counter, and
the first hand of a game exercises none of it.

## Limitations

- **4-player only.** `manifest.toml` declares `supported_modes = ["4p"]` so
  Akagi's UI disables the sanma toggle, and `bot.py`/the bridge refuse a 3-player
  game outright. The reason is concrete: `SuanPai` is hard-coded to a 70-tile
  live wall (the 3-player wall is 55), and the library has no `kita` rule at all,
  so every estimate would be wrong.
- **No `qijia` on the wire.** Akagi's `start_game` does not carry the game's base
  dealer, so the bridge assumes the bot's own seat is the base dealer. That view
  is internally consistent, which is all the AI's own comparisons need.
- **Wall count is reconstructed, not observed.** `majiang-ai` has no whole-game
  replay mode, so `probe/harness.js` derives its mjai input from the engine's own
  relative-seat messages. The bridge itself is what Akagi drives, and that path is
  exercised by `test/` plus the JSONL runs above. The reconstruction is exact for
  every draw the wire reports; a draw resolved inside the engine without a message
  (`reply_gang`/`reply_dapai`) would leave it one high, and the harness sweep is
  what would catch it — the sweep run for this build reports none over
  **116 games / 1298 hands / 122 127 messages**, across east and south rounds.
- **The legality gate is type-level.** `from_majiang.js` refuses an action whose
  *type* is not in the legal set the bridge derives from its own model. It cannot
  see the candidate *list* Akagi's riichi engine holds, so a legal-looking but
  engine-illegal instance of an allowed type (a chi of the wrong tile, say) is
  not caught here. Widening it would mean consuming Akagi's set for real.
- **Rule presets are two axes wide.** `tenhou` and `majsoul` differ only in
  whether kuikae is allowed; both use the library's Tenhou-shaped defaults
  (red fives, kuitan, head-bump). Anything else needs a rule edit in
  `bridge/main.js`.

## Licensing

`@kobalab/majiang-ai` and `@kobalab/majiang-core` are MIT. This bridge is MIT.
The bot runs as a separate OS process talking JSON over pipes — the same
boundary Akagi already relies on for AGPL bots — so nothing here is linked into
Akagi.
