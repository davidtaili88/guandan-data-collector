# Collected game data

This orphan branch holds Guandan game data collected by the app — one JSON file
per game under `games/`, committed automatically. It has its own history,
independent of `main` (the code), so code commits and data commits never mix.

Analyse with:
    git fetch origin data && git checkout data
    python -m analysis.loader
