# Guandan Data Collector

Web UI for recording every hand played in games of Guandan (掼蛋), so the data can
be analysed later in Python.


git token: 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

## Running

```bash
npm install
npm start          # http://localhost:3000
npm test           # combo classifier tests
```

Rooms are per-URL-hash: `localhost:3000/#friday` puts everyone in the `friday`
room. Default room is `main`.

## Flow

1. Everyone opens the page and enters a name.
2. The **host** (first to join) sets player count (4 or 6) and the rank card, then
   starts the game.
3. Each player records their own actions: click cards → **Record play**, or
   **Record pass**. Every turn needs an entry. The 4-player game uses **two decks**
   and the 6-player variant uses **three**, so a card can be selected up to that
   many times — click again for another copy (a **×N** badge appears), right-click
   to remove one. Jokers can form pairs and triples (of the same joker) and appear
   in a hung; two big + two small jokers is the joker bomb.
4. The host clicks **End & save game** to persist it.

**Teammates' finishing places.** After entering your teammate names (in the
teammates/enemies box), a place-picker appears for each of them under **Your
finishing place** → *Teammates' finishing places*. Set where each teammate came so
a whole side's order is captured even when they don't each have a device; the
teammate you mark 1st is flagged as the first one out. Saved per player as
`teammatePlaces`, and the game is stamped `hasTeammatePlaces`.

**Saved combos.** Recurring hands can be stored as one-click presets. Select the
cards, click **Save selection as combo** (one click — it's auto-named from the
detected combo), and it appears under **Saved combos** in the side panel. Clicking a saved combo **records that play immediately** (Undo is
still available if you misclick). Combos are card-specific and stored per-browser
in `localStorage` (keyed by room, like your name), so they persist across games and
reloads but stay private to your device.

If a game breaks up before it finishes, any player can click **Abandon my game**
and choose to **save their partial hand** (recorded as `status: "abandoned"`) or
**discard** it. Abandoning only affects that one player — others keep playing, and
the abandoning player is removed from the game so the host's later save won't
double-count them.

Combos are auto-detected and shown before you record. If a selection isn't a
legal shape it warns but still lets you save it, tagged `unknown` — data entry is
never blocked.

## Data model

Turn numbers are **per player**, not global. A player's Nth action is `turn: N`,
independent of other seats. This means not every seat needs a device — but it also
means tricks can't be reconstructed across players.

```json
{
  "schema": 1,
  "gameId": "2026-07-24T01-58-23-p7hn",
  "gameNo": "4.7",
  "playerCount": 4,
  "rankCard": "7",
  "date": "2026-07-24",
  "status": "complete",
  "startedAt": "...", "endedAt": "...",
  "hasTeammatePlaces": true,
  "players": [
    {
      "seat": 0,
      "name": "David",
      "teammates": ["Kevin"],
      "enemies": ["Amy", "Sam"],
      "place": 1,
      "teammatePlaces": { "Kevin": 2 },
      "cardsRemaining": [],
      "turns": [
        { "turn": 1, "action": "play", "cards": ["S5","H5","D5","C5"],
          "combo": "bomb4", "comboRank": 5, "usedWildcards": [] },
        { "turn": 2, "action": "pass" },
        { "turn": 3, "action": "play", "cards": ["H7","S9","D9"],
          "combo": "triple", "comboRank": 9, "usedWildcards": ["H7"] }
      ]
    }
  ]
}
```

- **`schema`** — format version, currently `1`. Bumped when the saved format
  changes in a way analysis must distinguish, so old and new records stay tellable
  apart. The loader exposes it as a `schema` column.
- **`teammates` / `enemies`** — self-reported name lists per player, both optional
  (may be empty). Entered on the site; carried on both complete and abandoned
  records so partner/opponent context survives even when a game doesn't finish.
- **`place`** — finishing position (1..playerCount), set by each player at game
  end. `null` if not entered or the game was abandoned (→ `NaN` in the loader's
  `place` column).
- **`teammatePlaces`** — a `{ name: place }` map of finishing positions a player
  recorded for their **teammates**, so a whole side's order can be captured from one
  device when teammates don't each have one. Only names in that player's
  `teammates` list are kept; the teammate at place `1` is the first one out. The
  loader exposes it as `teammate_places`, with `teammate_places(df)` flattening it
  to one row per (recorder, teammate, place) and an `is_first` flag.
- **`hasTeammatePlaces`** — game-level flag stamped `true` when any player recorded
  teammate places. `first_teammate_places_game(df)` uses it to report the earliest
  game number that has this data.
- **`cardsRemaining`** — the cards still in the player's hand at game end, as raw
  codes (empty if they finished). Not classified — it's a leftover hand, not a
  play. Loader exposes `cards_remaining` and `n_cards_remaining`.
- **`gameNo`** — human-friendly sequence, `"<variant>.<n>"`: the nth game of the
  4- or 6-player variant (e.g. `4.7`). Also the filename. Counted from the data
  repo so it survives Render restarts; override in `storage.js` (`GAMENO_OVERRIDE`
  const or the `GAMENO_OVERRIDE` env var, e.g. `4:12,6:3`) if the count is ever wrong.
- **`gameId`** — timestamp; the collision-proof unique key behind `gameNo`.
- **`date`** — `YYYY-MM-DD` for easy grouping.
- **`status`** — `"complete"` (normal end) or `"abandoned"` (a player quit
  mid-game and saved their partial hand). Filter in analysis with
  `df[df.status == "complete"]`.
- **Card codes** — suit (`S H D C`) + rank (`2`–`9`, `T J Q K A`), plus `BJ`
  (**Small Joker**) / `RJ` (**Big Joker**). Stored as readable codes; the Python
  loader converts to integer values for analysis (see below).
- **`comboRank`** — comparison value: rank card = 15 (above ace), small joker 16,
  big joker 17; runs are ranked by their top card.

Combo IDs stored in `combo`: `single`, `pair`, `triple`, `hung` (full house /
three-with-two), `straight`, `tongHuaShun` (straight flush), `tractor` (3 pairs),
`steelBoard` (2 triples), `bomb4`…`bomb12`, `jokerBomb`, `unknown`.

Written to:
- `data/games/<gameNo>.json` — one file per game (local scratch; ephemeral on Render)
- `data/turns.jsonl` — append-only flat log
- the **`guandan-data` GitHub repo** — the durable copy, when the token is set

## Persistence on Render

**Render's filesystem is ephemeral** — `data/` is wiped on every redeploy. Two ways out:

- **Export button** (always available) — downloads all turns as JSONL.
- **GitHub sync** (recommended) — set `GITHUB_TOKEN` in Render and each saved game
  is committed to `games/` on the **`data` branch of this repo**. That branch is an
  *orphan* — its own history, independent of `main` — so code commits and "Add game"
  commits never mix. `GITHUB_REPO`/`GITHUB_BRANCH` default to this repo's `data`
  branch; only set them if you fork or rename. Without a token the app still runs,
  just local-only.

To analyse the collected data:

```bash
git fetch origin data && git checkout data   # switch to the data branch
python -m analysis.loader
git checkout main                             # back to code
```

## Analysis

```bash
pip install -r analysis/requirements.txt
python -m analysis.loader          # quick summary
```

```python
from analysis.loader import load_turns, combo_frequency, player_summary, explode_cards

df = load_turns()
# Or re-derive combo/comboRank from raw cards with the CURRENT classifier, so a
# later fix to the combo logic retroactively corrects old data (needs Node):
df = load_turns(reclassify=True)
combo_frequency(df)                       # what shapes get played
player_summary(df)                        # pass rate, bomb rate per player
df[df.is_bomb].groupby("name").size()     # who bombs most

# explode_cards adds integer columns: value (2-14, jokers 16/17), game_value
# (rank card bumped to 15), suit, card_rank, is_wildcard
ex = explode_cards(df)
ex.value.mean()                           # average card value played
ex.groupby("suit").size()                 # suit distribution
ex[ex.is_wildcard]                        # every wildcard play
```

Cards are stored as readable codes (`S4`) and converted to integers in Python, so
storage stays git-diffable while analysis gets clean numeric columns.

## Layout

| Path | Purpose |
|---|---|
| `server.js` | Express + Socket.io, room and turn recording |
| `public/guandan.js` | Card model + combo classifier (shared by server and browser) |
| `public/app.js` | UI: deck rendering, selection, live combo readout |
| `storage.js` | Local JSON/JSONL writes + optional GitHub commits |
| `analysis/loader.py` | pandas loaders and summary helpers |
| `analysis/reclassify.mjs` | Node bridge so the loader can re-derive combos via `guandan.js` |
| `test/classify.test.mjs` | Classifier tests |
