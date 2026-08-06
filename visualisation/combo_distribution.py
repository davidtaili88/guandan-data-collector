"""Combo-type distribution, one axis per gamemode.

How often each combo type (single / pair / bomb4 / hung / ...) is played, as a
share of all plays. Two axes: 4-player and 6-player.

    python -m visualisation.combo_distribution
"""

from __future__ import annotations

from _common import BAR, load_plays, new_twin_figure, save


def main() -> None:
    plays = load_plays()

    fig, ax_by_mode = new_twin_figure("Combo-type distribution by gamemode")

    for mode, ax in ax_by_mode.items():
        sub = plays[plays["player_count"] == mode]
        counts = sub["combo"].value_counts()
        counts = counts[counts > 0].sort_values(ascending=False)  # tallest first
        total = counts.sum()

        # The combo name is already the axis label, so colour carries no extra
        # information — one steady categorical slot keeps it honest and legible.
        bars = ax.bar(counts.index, counts.values, color=BAR, width=0.7)
        # Direct-label each bar with count and share — no colour-only reading.
        for bar, n in zip(bars, counts.values):
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                bar.get_height() + total * 0.01,
                f"{n}\n{n / total:.0%}",
                ha="center",
                va="bottom",
                fontsize=9,
                color="#52514e",
            )
        ax.set_ylabel(f"plays  (n = {total})", fontsize=10, color="#52514e")
        ax.tick_params(axis="x", labelrotation=45)
        for label in ax.get_xticklabels():
            label.set_horizontalalignment("right")
        ax.margins(y=0.15)

    save(fig, "combo_distribution")


if __name__ == "__main__":
    main()
