# Changelog

## 0.2.2

### The candidates do not match the hand — manual play

Playing by hand, the bot's answer is only a suggestion: the tile that actually
leaves your hand is whatever you threw. The bridge applied the bot's choice to
its model the moment it answered, and then **swallowed an echo that named a
different tile** — so the model kept the bot's pick and never saw yours. From
that turn on, every candidate list was computed for a hand you do not have: a
phantom tile was offered as a discard (the screenshot's "打 1s" for a hand with
no 1索) and a tile you do hold was never suggested.

The model "healed" only when the AI happened to discard the phantom, which is
why the damage came and went.

The echo is now reconciled: the bot's tile goes back into the model hand, your
tile comes out through the ordinary discard path (so the river and the furiten
bookkeeping follow what was really thrown), and the discard that never happened
is un-recorded from the river, the danger table and the riichi flags. A riichi
you declare yourself is picked up from `reach_accepted`, which previously
assumed the bot had chosen it.

## 0.2.1

Two defects, both reported as "the candidates on screen do not match my hand".

### The overlay

- A declined call was headed `鸣牌判断（不鸣，打 3s）`, which reads as *discard 3s*.
  3s is the OPPONENT's discard — the tile we were offered — so the card named a
  tile the hand often does not hold at all. It now reads `对方打 3s`.
- A tsumogiri's discard card had no tile in its heading at all (`打牌候选`): the
  heading asks `mianziParts` about the discard, which is spelled `p9_`, and only
  the meld markers were being stripped.

### The model (the bigger one)

- A censored opponent draw was treated as "nothing to apply", but it is the only
  thing that replenishes that seat's placeholder hand in the model. The
  placeholder ran out after that seat's thirteenth discard and then threw — and
  because `Board.dapai` spends the blank *before* it records the tile in the
  river, the throw took the river entry with it, so the next call on that tile
  failed too. Each rejection also silently cost that event's decision. Measured
  over 4 replay games: 26 rejected events before, 0 after.
- A pon of a five could be spelled with the marker on the wrong copy of the five
  (`s550=` when the ORDINARY 5s was called). `He.fulou` compares the marked digit
  against the discarder's river, so the pon was dropped — and with it the added
  kan that would have extended it.

### The test rig, which is why neither was caught

- The harness stripped only the riichi marker when converting an engine discard
  to mjai, so every tsumogiri left as a `dahai` with NO tile. The bridge refuses
  those, which means **every tsumogiri in every replayed game was dropped before
  it reached the model**: the discarder's river never recorded it and the AI's
  danger model never saw it. Fixing that raised the decisions a 4-game replay
  exercises from 1208 to 2349 — the sweep had been testing about half the game.

## 0.2.0

The first build that is safe to play a full game with. 0.1.0 looked fine — its
four unit suites and its whole-game harness were green — because both test
layers had blind spots, and 22 defects lived inside them.

### Hands that could not finish

- `jushu` carried the game-wide hand index (0..7) where the library means the
  hand within the round (0..3, with the round in `zhuangfeng`). From South 2 on,
  `SuanPai.qipai` threw and the bot answered `none` for the rest of the game.
- A closed kan was sent with three tiles in `consumed`; Akagi's schema requires
  four, so the reply failed to parse and the two sides diverged mid-hand.
- An added kan could never be translated at all — the library marks it in the
  *middle* of the meld string, which the parser did not look at — so a kan reply
  became `none` and the turn was lost.
- A chi named the wrong tile as the called one, and could drop a tile out of the
  model entirely.
- `asked` was sticky, so a batch carrying a decision followed by a round boundary
  (a new dora, the end of a hand) swallowed a decision the bot had already made
  against its own model.

### Contracts with Akagi

- Riichi rode on a `meta.extra_actions` field Akagi does not read. It now uses
  the `Reach.pai` its autoplay expects.
- The legality gate was never wired to a legal set, so it passed everything and
  the documented "every reply is gated" was only true in the unit tests.
- `hora` / `ryukyoku` carried fields Akagi's schema does not have.

### Quietly wrong play

- `shan.paishu` was never synced, so the last-tile and dead-wall rules never
  fired; our own discard bypassed `Player.dapai`, which cost the riichi points,
  the furiten bookkeeping and the first-turn flag.
- The wall counter charged a kan's dora indicator at the wrong moment, leaving it
  one tile out across the kan → replacement-draw interval — and a decision can
  land exactly there.

Plus the usual: dead code, an empty `catch` that hid the HUD failing, comments
describing the opposite of the code, and two rule presets that differed only in
their label.

### Why the tests missed all of it

The harness compared the bridge against *itself* — the reference getter returned
the subject, so the hand assertion was vacuously true — and it silently dropped
every added-kan message it was meant to replay. Both are fixed: the reference is
now the engine's own board, and the seed pins the deal *and* the dealer, so a
failure replays exactly. This build is verified by 437 unit assertions plus a
sweep of **116 games / 1298 hands / 122 127 messages** with zero divergence.
