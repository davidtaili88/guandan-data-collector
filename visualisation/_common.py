"""Shared helpers for the visualisation scripts.

Every chart in this folder is one matplotlib figure split into two axes, one per
gamemode (4-player and 6-player). "Gamemode" is just ``player_count``. The helpers
here load the turns, give a stable colour per combo type, and lay out the twin-ax
figure so the individual scripts only have to describe *what* to plot.

Run any script from the repo root, e.g.::

    python -m visualisation.combo_distribution
"""

from __future__ import annotations

import sys
from pathlib import Path

import matplotlib
import matplotlib.pyplot as plt
import pandas as pd

# Make ``from analysis.loader import ...`` work no matter the cwd.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from analysis.loader import load_turns  # noqa: E402

# The two gamemodes, in the order the axes appear (left -> right).
GAMEMODES = [4, 6]

# Where rendered PNGs land.
OUT_DIR = Path(__file__).resolve().parent / "output"

# Single categorical slot (blue) from the validated dataviz reference palette.
# These charts each encode ONE measure (a count) against named categories, so the
# category name lives on the axis and colour carries no extra information — one
# steady hue is the honest, legible choice rather than a per-category rainbow.
BAR = "#2a78d6"


def load_plays() -> pd.DataFrame:
    """All non-pass turns for complete games, restricted to the two gamemodes."""
    df = load_turns()
    if df.empty:
        raise SystemExit(
            "No games found. Extract the data-branch games into data/games/ first."
        )
    plays = df[(~df["is_pass"]) & (df["status"] == "complete")]
    return plays[plays["player_count"].isin(GAMEMODES)].copy()


def new_twin_figure(suptitle: str):
    """A figure with one axis per gamemode, sharing sensible defaults.

    Returns ``(fig, {4: ax, 6: ax})`` so callers plot each gamemode by name.
    """
    fig, axes = plt.subplots(1, len(GAMEMODES), figsize=(13, 5.5))
    fig.suptitle(suptitle, fontsize=15, fontweight="bold")
    ax_by_mode = {}
    for ax, mode in zip(axes, GAMEMODES):
        ax.set_title(f"{mode}-player", fontsize=12, color="#52514e")
        # Recessive frame: drop the top/right spines, soften the rest.
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        for side in ("left", "bottom"):
            ax.spines[side].set_color("#c3c2b7")
        ax.tick_params(colors="#52514e", labelsize=10)
        ax_by_mode[mode] = ax
    return fig, ax_by_mode


def save(fig, name: str, show: bool = True) -> Path:
    """Write ``<name>.png`` into the output folder and report the path.

    When ``show`` is true and a GUI backend is available (i.e. running locally,
    not headless/CI), also pop the figure open in a window. On a headless
    backend the ``plt.show()`` is simply a no-op, so this stays safe everywhere.
    """
    OUT_DIR.mkdir(exist_ok=True)
    path = OUT_DIR / f"{name}.png"
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    fig.savefig(path, dpi=150, facecolor="white")
    print(f"wrote {path}")
    if show and not matplotlib.get_backend().lower().endswith("agg"):
        # Only pop a window on an interactive backend; on headless Agg this
        # would just warn and do nothing.
        plt.show()
    return path
