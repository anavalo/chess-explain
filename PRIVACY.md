# chess-explain privacy policy

Last updated: 2026-10-12

chess-explain is a browser extension that explains chess moves on lichess.org. It has no server of its
own, collects no analytics, and its developer receives no data from it.

## What it reads

When you click **Explain**, the extension reads from the lichess tab you have open:

- the position on the board (FEN), lichess's top engine move, and the next move of the game;
- your lichess username, as shown on the page.

It reads nothing from other sites, and nothing from lichess until you click **Explain**.

## Where data goes

- **lichess.org:** your username is sent to lichess's public API to check that you are not playing a
  game (the fair-play check).
- **Anthropic (api.anthropic.com):** the position, the two moves compared and the Stockfish analysis of
  them are sent to Anthropic's API, using your own API key, to write the explanation. Anthropic's
  [privacy policy](https://www.anthropic.com/legal/privacy) applies to that request.

Stockfish runs inside the extension; no analysis is sent anywhere else.

## What it stores

Your Anthropic API key is stored in `chrome.storage.local`: on this computer, in this browser profile
only, not synced. It is sent only to api.anthropic.com. You can remove it at any time by clearing the
key field in the panel's settings and saving, or by removing the extension.

Nothing else is stored. The extension does not sell or share data, and does not use it for anything
other than writing the explanation you asked for.

## Contact

Questions or issues: <https://github.com/anavalo/chess-explain/issues>
