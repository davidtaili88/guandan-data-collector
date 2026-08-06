# visualisation

Matplotlib charts over the collected games. Each script produces **one figure with
two axes — one per gamemode** (4-player on the left, 6-player on the right), where
"gamemode" is just `player_count`.

| Script | Chart |
|--------|-------|
| `combo_distribution.py` | How often each combo type is played (share of all plays). |
| `placement_distribution.py` | How often the recorded player finishes in each place. |
| `wildcard_distribution.py` | Wildcard plays per combo type, labelled with the usage rate within that combo. |

Shared loading, the twin-axis layout, and the bar colour live in `_common.py`.
PNGs are written to `output/`.

## Data

The scripts read `data/games/*.json` via `analysis/loader.py`. That folder is
gitignored; the games themselves live on the `data` branch under `games/`. To make
them available locally:

```sh
mkdir -p data/games
for f in $(git ls-tree --name-only data:games); do
  git show "data:games/$f" > "data/games/$f"
done
```

## Running

From the repo root:

```sh
pip install -r analysis/requirements.txt matplotlib
python visualisation/combo_distribution.py
python visualisation/placement_distribution.py
python visualisation/wildcard_distribution.py
```
