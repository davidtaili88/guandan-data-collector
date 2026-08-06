"""Wildcard-usage distribution by combo type, one axis per gamemode.

For each combo type, how many plays used a wildcard (the heart-suited rank card
standing in for another card). Bars are the wildcard-play count per combo,
labelled with the usage rate within that combo (wildcard plays / all plays of
that combo). Only combos that ever used a wildcard are shown. Two axes:
4-player and 6-player.

    python -m visualisation.wildcard_distribution
"""

from __future__ import annotations

from _common import BAR, load_plays, new_twin_figure, save


def main() -> None:
    plays = load_plays()

    fig, ax_by_mode = new_twin_figure("Wildcard usage by combo type and gamemode")

    for mode, ax in ax_by_mode.items():
        sub = plays[plays["player_count"] == mode]
        total_by_combo = sub.groupby("combo", observed=True).size()
        wild_by_combo = (
            sub[sub["used_wildcard"]].groupby("combo", observed=True).size()
        )
        wild_by_combo = wild_by_combo[wild_by_combo > 0].sort_values(
            ascending=False
        )

        total_wild = int(wild_by_combo.sum())
        if wild_by_combo.empty:
            ax.text(0.5, 0.5, "no wildcard plays", ha="center", va="center",
                    transform=ax.transAxes, color="#52514e")
            ax.set_axis_off()
            continue

        combos = list(wild_by_combo.index)
        bars = ax.bar(combos, wild_by_combo.values, color=BAR, width=0.7)
        for bar, combo, n in zip(bars, combos, wild_by_combo.values):
            rate = n / total_by_combo[combo]
            # "used / total" and the within-combo rate, stacked above each bar.
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                bar.get_height() + wild_by_combo.max() * 0.03,
                f"{n} of {total_by_combo[combo]}\n{rate:.0%}",
                ha="center",
                va="bottom",
                fontsize=9,
                color="#52514e",
            )
        ax.set_ylabel(
            f"wildcard plays  (n = {total_wild})", fontsize=10, color="#52514e"
        )
        ax.tick_params(axis="x", labelrotation=45)
        for label in ax.get_xticklabels():
            label.set_horizontalalignment("right")
        ax.margins(y=0.22)
        # Integer-only ticks — counts are small whole numbers.
        ax.set_yticks(range(0, int(wild_by_combo.max()) + 1))

    save(fig, "wildcard_distribution")


if __name__ == "__main__":
    main()
