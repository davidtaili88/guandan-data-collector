# Guandan Data Collector

Web UI for recording every hand played in games of Guandan (掼蛋), so the data can
be analysed later in Python.

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
   **Record pass**. Every turn needs an entry.
4. The host clicks **End & save game** to persist it.

Combos are auto-detected and shown before you record. If a selection isn't a
legal shape it warns but still lets you save it, tagged `unknown` — data entry is
never blocked.

## Data model

Turn numbers are **per player**, not global. A player's Nth action is `turn: N`,
independent of other seats. This means not every seat needs a device — but it also
means tricks can't be reconstructed across players.

```json
{
  "gameId": "2026-07-24T01-58-23-p7hn",
  "playerCount": 4,
  "rankCard": "7",
  "startedAt": "...", "endedAt": "...",
  "players": [
    {
      "seat": 0,
      "name": "David",
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

Card codes: suit (`S H D C`) + rank (`2`–`9`, `T J Q K A`), plus `BJ` / `RJ` for
the jokers. `comboRank` is the comparison value — the rank card sits at 15 (above
ace), black joker 16, red joker 17; runs are ranked by their top card.

Written to:
- `data/games/<gameId>.json` — authoritative, one file per game
- `data/turns.jsonl` — append-only flat log

## Persistence on Render

**Render's filesystem is ephemeral** — `data/` is wiped on every redeploy. Two ways out:

- **Export button** (always available) — downloads all turns as JSONL.
- **GitHub sync** (optional) — set `GITHUB_TOKEN` and `GITHUB_REPO` (`owner/repo`)
  env vars and each saved game is committed to `games/` in that repo. Uncomment
  the entries in `render.yaml`. Without these the app runs exactly the same, just
  local-only.

## Analysis

```bash
pip install -r analysis/requirements.txt
python -m analysis.loader          # quick summary
```

```python
from analysis.loader import load_turns, combo_frequency, player_summary, explode_cards

df = load_turns()
combo_frequency(df)                       # what shapes get played
player_summary(df)                        # pass rate, bomb rate per player
df[df.is_bomb].groupby("name").size()     # who bombs most
explode_cards(df).card_rank.value_counts()  # per-card frequency
```

## Layout

| Path | Purpose |
|---|---|
| `server.js` | Express + Socket.io, room and turn recording |
| `public/guandan.js` | Card model + combo classifier (shared by server and browser) |
| `public/app.js` | UI: deck rendering, selection, live combo readout |
| `storage.js` | Local JSON/JSONL writes + optional GitHub commits |
| `analysis/loader.py` | pandas loaders and summary helpers |
| `test/classify.test.mjs` | Classifier tests |
