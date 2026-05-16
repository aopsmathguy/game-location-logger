# 2D Shooter Position Logger

This Chrome extension injects into the game page, reads the live game object, and records:

- your current position
- enemy positions
- a few status fields such as visible / dead / downed

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder

## Use

1. Open the game page
2. Open DevTools if you want to watch samples in the console
3. Play the game
4. Click the extension icon to export the collected log as JSON

## Notes

- The extractor is tailored to the current bundle structure.
- It looks first for `window.Mi.game`, then falls back to scanning globals for a game-shaped object.
- If the game bundle changes, obfuscated property names may change too, and you may need to update the extractor.


Notes:
- This build injects at document_start and in all frames.
- It also does a bounded recursive search for the game object, since the bundle uses module-scoped state rather than a plain window global.
