"""Finishing-place distribution, one axis per gamemode.

How often the recorded player finishes in each place (1 = first out). Places run
1..player_count, so the 4-player axis tops out at 4 and the 6-player axis at 6.
Two axes: 4-player and 6-player.

    python -m visualisation.placement_distribution
"""

from __future__ import annotations

from _common import BAR, load_plays, new_twin_figure, save


def main() -> None:
    plays = load_plays()
    # One row per (game, player); place is constant within a player's turns.
    finishes = plays.drop_duplicates(["game_id", "seat"])
    finishes = finishes[finishes["place"].notna()]

    fig, ax_by_mode = new_twin_figure("Finishing-place distribution by gamemode")

    for mode, ax in ax_by_mode.items():
        sub = finishes[finishes["player_count"] == mode]
        places = list(range(1, mode + 1))  # full 1..N axis even where count is 0
        counts = [int((sub["place"] == p).sum()) for p in places]
        total = sum(counts)

        bars = ax.bar([str(p) for p in places], counts, color=BAR, width=0.7)
        for bar, n in zip(bars, counts):
            if n:
                ax.text(
                    bar.get_x() + bar.get_width() / 2,
                    n + max(counts) * 0.02,
                    f"{n}\n{n / total:.0%}" if total else str(n),
                    ha="center",
                    va="bottom",
                    fontsize=9,
                    color="#52514e",
                )
        ax.set_xlabel("finishing place", fontsize=10, color="#52514e")
        ax.set_ylabel("games", fontsize=10, color="#52514e")
        ax.set_title(
            f"{mode}-player  (n = {total})", fontsize=12, color="#52514e"
        )
        ax.margins(y=0.15)

    save(fig, "placement_distribution")


if __name__ == "__main__":
    main()
