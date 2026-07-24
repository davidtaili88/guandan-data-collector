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


def load_turns(data_dir: Path | str | None = None) -> pd.DataFrame:
    """Flatten all games into one turn-per-row DataFrame.

    Columns: game_id, player_count, rank_card, seat, name, turn, action,
             cards, combo, combo_rank, used_wildcards, n_cards, is_bomb,
             is_pass, used_wildcard
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
                        "game_id": game["gameId"],
                        "game_no": game.get("gameNo"),
                        "date": game.get("date"),
                        "player_count": game["playerCount"],
                        "rank_card": rank_card,
                        "rank_card_value": _BASE_VALUE.get(rank_card),
                        "started_at": game.get("startedAt"),
                        "seat": player["seat"],
                        "name": player["name"],
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
    if not df.empty:
        df["started_at"] = pd.to_datetime(df["started_at"], errors="coerce")
        df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.date
        df["combo"] = df["combo"].astype("category")
        df["name"] = df["name"].astype("category")
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
