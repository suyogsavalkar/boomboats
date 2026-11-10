# Trailer tools

How `Boomboats_Trailer.mp4` was made. To re-shoot after game changes:

1. Run a copy of the game on port 3101 with `PORT=3101 BB_DEBUG=1 BB_GOD=1 BB_MATCH_SECONDS=900`.
   The trailer copy also had two extra tweaks: `MIN_ACTORS = 8` in `shared/data.js` (more bots on screen), and
   `BB_GOD` support in the server's `kill()`/`damage()` (the camera boat can't be sunk, so no respawn bubbles).
2. `node shots.mjs` records every shot into `clips/` from headless Chrome (canvas + game audio, auto-retakes
   any take with dropped frames). Needs `puppeteer-core` and Google Chrome.
3. `node render_cards.mjs` renders the title cards; `python3 edit.py` cuts the trailer on the music's bar grid
   (178.6 BPM), grades it, adds titles, music and stingers. Paths at the top of each script point at the
   folders used during the original build, so adjust them first.
