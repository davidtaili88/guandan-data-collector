"""Load collected Guandan games into pandas.

The collector writes two things under ``data/``:
  * ``games/<gameId>.json`` — one nested document per game
  * ``turns.jsonl``          — append-only, one flat record per turn

For analysis you almost always want the flat form, so :func:`load_turns` is the
main entry point. It reads the per-game JSON files rather than turns.jsonl,
because the JSON files are the authoritative copy (the JSONL can contain
duplicates if a game was saved twice).

Usage:
    from analysis.loader import load_turns
    df = load_turns()
    df[df.combo == "bomb4"].groupby("name").size()
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
GAMES_DIR = DATA_DIR / "games"

# Ordering used for comboRank on straights/tractors/steel-boards. Singles/pairs/
# triples/bombs use card value instead (rank card 14, jokers 15-16 — see below).
RANK_ORDER = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"]

# Every N-bomb up to 12, plus joker bomb and Tong Hua Shun (a suited bomb).
BOMB_COMBOS = {f"bomb{n}" for n in range(4, 13)} | {"jokerBomb", "tongHuaShun"}

# Base numeric value of a card rank, suit-independent, matching the JS
# cardValue() scheme so this agrees with the stored comboRank:
#   2..A -> 2..14,  rank card -> 15,  small joker -> 16,  big joker -> 17.
_BASE_VALUE = {r: i + 2 for i, r in enumerate(RANK_ORDER)}  # '2'->2 ... 'A'->14
_BASE_VALUE["BJ"] = 16  # small joker
_BASE_VALUE["RJ"] = 17  # big joker


def card_rank_str(card: str) -> str:
    """Rank portion of a card code: 'S4' -> '4', 'BJ' -> 'BJ'."""
    return card if card in ("BJ", "RJ") else card[1:]


def card_suit(card: str):
    """Suit letter, or None for jokers. 'S4' -> 'S', 'RJ' -> None."""
    return None if card in ("BJ", "RJ") else card[0]


def card_value(card: str, rank_card: str | None = None) -> int:
    """Integer value of a card, matching the in-game strength order.

    2..A map to 2..14. If ``rank_card`` is given, a card of that rank jumps to 15
    (above ace, below the jokers at 16/17). Pass ``rank_card=None`` to get the
    plain face value ignoring the wildcard bump.
    """
    r = card_rank_str(card)
    if rank_card is not None and r == rank_card:
        return 15
    return _BASE_VALUE[r]


def load_games(data_dir: Path | str | None = None) -> list[dict]:
    """Return every saved game as a list of nested dicts."""
    games_dir = Path(data_dir) / "games" if data_dir else GAMES_DIR
    if not games_dir.exists():
        return []
    games = []
    for path in sorted(games_dir.glob("*.json")):
        with path.open(encoding="utf-8") as fh:
            games.append(json.load(fh))
    return games


def load_turns(
    data_dir: Path | str | None = None, reclassify: bool = False
) -> pd.DataFrame:
    """Flatten all games into one turn-per-row DataFrame.

    Columns: schema, game_id, game_no, date, status, player_count, rank_card,
             rank_card_value, seat, name, teammates, enemies, turn, action,
             cards, combo, combo_rank, used_wildcards, n_cards, is_bomb,
             is_pass, used_wildcard

    The stored ``combo``/``comboRank`` are cached at record time. Pass
    ``reclassify=True`` to recompute them from the raw ``cards`` using the CURRENT
    classifier (analysis/reclassify.mjs -> public/guandan.js), so a later fix to
    the combo logic retroactively corrects old data. Requires Node on PATH.
    """
    rows = []
    for game in load_games(data_dir):
        for player in game.get("players", []):
            for turn in player.get("turns", []):
                cards = turn.get("cards", [])
                wilds = turn.get("usedWildcards", [])
                rank_card = str(game["rankCard"])
                rows.append(
                    {
                        "schema": game.get("schema", 1),
                        "game_id": game["gameId"],
                        "game_no": game.get("gameNo"),
                        "date": game.get("date"),
                        # 'complete' (normal end) or 'abandoned' (player quit
                        # mid-game). Older records without the field are assumed
                        # complete. Filter with df[df.status == 'complete'].
                        "status": game.get("status", "complete"),
                        "player_count": game["playerCount"],
                        "rank_card": rank_card,
                        "rank_card_value": _BASE_VALUE.get(rank_card),
                        "started_at": game.get("startedAt"),
                        "seat": player["seat"],
                        "name": player["name"],
                        # Self-reported relationships (may be empty lists).
                        "teammates": player.get("teammates", []),
                        "enemies": player.get("enemies", []),
                        # Finishing places this player recorded for their
                        # teammates: {name: place}. Empty dict when the feature
                        # wasn't used. game-level 'has_teammate_places' below is
                        # the flag the collector stamps when any player used it.
                        "teammate_places": player.get("teammatePlaces") or {},
                        "has_teammate_places": bool(
                            game.get("hasTeammatePlaces", False)
                        ),
                        # Finishing place (1..playerCount). NaN when not entered
                        # or the game was abandoned. Kept as a float column so the
                        # NaN is representable.
                        "place": player.get("place"),
                        # cardsRemaining: a list means it was recorded (possibly
                        # empty = finished with none). null/absent means "not
                        # available" — kept as [] for the value but NaN count, so
                        # "not recorded" stays distinct from "finished with 0".
                        "cards_remaining": player.get("cardsRemaining") or [],
                        "n_cards_remaining": (
                            len(player["cardsRemaining"])
                            if isinstance(player.get("cardsRemaining"), list)
                            else float("nan")
                        ),
                        "turn": turn["turn"],
                        "action": turn["action"],
                        "cards": cards,
                        "combo": turn.get("combo"),
                        "combo_rank": turn.get("comboRank"),
                        "used_wildcards": wilds,
                        "n_cards": len(cards),
                        "is_pass": turn["action"] == "pass",
                        "is_bomb": turn.get("combo") in BOMB_COMBOS,
                        "used_wildcard": len(wilds) > 0,
                    }
                )

    df = pd.DataFrame(rows)
    if df.empty:
        return df

    if reclassify:
        df = _reclassify(df)

    df["started_at"] = pd.to_datetime(df["started_at"], errors="coerce")
    df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.date
    df["combo"] = df["combo"].astype("category")
    df["name"] = df["name"].astype("category")
    # Finishing place: float so a missing/abandoned place is NaN, not an error.
    df["place"] = pd.to_numeric(df["place"], errors="coerce")
    df["is_bomb"] = df["combo"].isin(BOMB_COMBOS)
    return df


def _reclassify(df: pd.DataFrame) -> pd.DataFrame:
    """Recompute combo/comboRank/used_wildcards from raw cards via the JS
    classifier, so analysis reflects the current rules rather than the values
    cached when each turn was recorded. Passes are left untouched.
    """
    import subprocess

    plays = df[~df["is_pass"]]
    if plays.empty:
        return df

    payload = {
        "rows": [
            {"cards": list(c), "rankCard": rc}
            for c, rc in zip(plays["cards"], plays["rank_card"])
        ]
    }
    script = Path(__file__).resolve().parent / "reclassify.mjs"
    proc = subprocess.run(
        ["node", str(script)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"reclassify.mjs failed: {proc.stderr.strip()}")
    results = json.loads(proc.stdout)["results"]

    df = df.copy()
    for idx, res in zip(plays.index, results):
        df.at[idx, "combo"] = res["combo"]
        df.at[idx, "combo_rank"] = res["comboRank"]
        df.at[idx, "used_wildcards"] = res["usedWildcards"]
        df.at[idx, "used_wildcard"] = len(res["usedWildcards"]) > 0
    return df


def explode_cards(df: pd.DataFrame) -> pd.DataFrame:
    """One row per individual card played — for per-card frequency analysis.

    Adds integer/analysis-friendly columns derived from the raw card code:
      suit        — 'S'/'H'/'D'/'C', or NaN for jokers
      card_rank   — rank string ('4', 'T', 'BJ', ...)
      value       — integer face value 2..14 (jokers 16/17), ignoring wildcard
      game_value  — integer value WITH the game's rank card bumped to 15
    """
    plays = df[~df["is_pass"]].explode("cards").rename(columns={"cards": "card"})
    plays = plays[plays["card"].notna()].copy()
    plays["suit"] = plays["card"].map(card_suit)
    plays["card_rank"] = plays["card"].map(card_rank_str)
    plays["value"] = plays["card"].map(lambda c: card_value(c, None))
    plays["game_value"] = plays.apply(
        lambda row: card_value(row["card"], row["rank_card"]), axis=1
    )
    plays["is_wildcard"] = plays.apply(
        lambda row: card_suit(row["card"]) == "H" and card_rank_str(row["card"]) == row["rank_card"],
        axis=1,
    )
    return plays


# ---------------------------------------------------------------- summaries

def first_teammate_places_game(df: pd.DataFrame) -> str | None:
    """The ``game_no`` of the earliest game that has teammate-place data.

    Uses the collector's game-level ``hasTeammatePlaces`` stamp. Games are ordered
    by ``started_at`` (falling back to ``game_no``) so "first" means first played,
    not first alphabetically. Returns ``None`` if no game has the data yet.
    """
    if df.empty or "has_teammate_places" not in df.columns:
        return None
    games = df[df["has_teammate_places"]].drop_duplicates("game_id")
    if games.empty:
        return None
    games = games.sort_values(["started_at", "game_no"], na_position="last")
    return games.iloc[0]["game_no"]


def teammate_places(df: pd.DataFrame) -> pd.DataFrame:
    """One row per recorded (recorder, teammate, place) triple.

    Flattens each player's ``teammate_places`` map so teammate finishing places
    can be analysed directly. Columns: game_id, game_no, player_count, name
    (the recorder), teammate, place, is_first (place == 1).
    """
    rows = []
    for _, r in df.drop_duplicates(["game_id", "seat"]).iterrows():
        for teammate, place in (r["teammate_places"] or {}).items():
            rows.append(
                {
                    "game_id": r["game_id"],
                    "game_no": r["game_no"],
                    "player_count": r["player_count"],
                    "name": r["name"],
                    "teammate": teammate,
                    "place": place,
                    "is_first": place == 1,
                }
            )
    return pd.DataFrame(rows)


def combo_frequency(df: pd.DataFrame) -> pd.DataFrame:
    """How often each combo type is played, overall and as a share."""
    plays = df[~df["is_pass"]]
    out = plays["combo"].value_counts().rename("count").to_frame()
    out["share"] = (out["count"] / out["count"].sum()).round(4)
    return out


def player_summary(df: pd.DataFrame) -> pd.DataFrame:
    """Per-player aggregates: turns, pass rate, bomb rate, avg cards per play."""
    g = df.groupby("name", observed=True)
    plays = df[~df["is_pass"]].groupby("name", observed=True)
    out = pd.DataFrame(
        {
            "turns": g.size(),
            "plays": plays.size(),
            "passes": g["is_pass"].sum(),
            "pass_rate": g["is_pass"].mean().round(3),
            "bomb_plays": plays["is_bomb"].sum(),
            "avg_cards_per_play": plays["n_cards"].mean().round(2),
            "wildcard_plays": plays["used_wildcard"].sum(),
        }
    )
    return out.fillna(0).sort_values("turns", ascending=False)


def opening_plays(df: pd.DataFrame, n: int = 1) -> pd.DataFrame:
    """What players do on their first ``n`` turns of a game."""
    early = df[df["turn"] <= n]
    return early.groupby(["name", "combo"], observed=True).size().rename("count").reset_index()


if __name__ == "__main__":
    frame = load_turns()
    if frame.empty:
        print("No games found in", GAMES_DIR)
    else:
        print(f"{len(frame)} turns across {frame.game_id.nunique()} games\n")
        print(combo_frequency(frame), "\n")
        print(player_summary(frame))
