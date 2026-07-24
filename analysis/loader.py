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

# Ordering used for comboRank on straights/tubes/plates. Singles/pairs/triples/
# bombs use card value instead, where the rank card sits at 15 and jokers 16-17.
RANK_ORDER = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"]

BOMB_COMBOS = {"bomb4", "bomb5", "bomb6", "bomb7", "bomb8", "jokerBomb", "straightFlush"}


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
                rows.append(
                    {
                        "game_id": game["gameId"],
                        "player_count": game["playerCount"],
                        "rank_card": game["rankCard"],
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
        df["combo"] = df["combo"].astype("category")
        df["name"] = df["name"].astype("category")
    return df


def explode_cards(df: pd.DataFrame) -> pd.DataFrame:
    """One row per individual card played — for per-card frequency analysis."""
    plays = df[~df["is_pass"]].explode("cards").rename(columns={"cards": "card"})
    plays = plays[plays["card"].notna()].copy()
    plays["suit"] = plays["card"].str[0].where(~plays["card"].isin(["BJ", "RJ"]))
    plays["card_rank"] = plays["card"].str[1:].where(~plays["card"].isin(["BJ", "RJ"]), plays["card"])
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
