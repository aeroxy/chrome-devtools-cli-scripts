# chrome-devtools-cli-scripts

Custom `run-script` and `adapter` files for the Chrome DevTools CLI. One file per site, named for the site. The global `chrome-devtools` skill links this folder as `scripts/`, so an agent finds these before writing a one-off.

## Running a script

Always pin `--target` to the tab you mean (`chrome-devtools list-pages` shows the names). An adapter navigates the tab it runs in if the domain doesn't match its `@domain`.

```bash
chrome-devtools --target <name> adapter discord.js messages
chrome-devtools --target <name> adapter discord.js history --output out.json -a limit=300 -a since=2026-11-01
```

Put `--output` before any `-a`. Paths are relative to wherever you run from.

## discord.js

Read-only helpers for the Discord web app, run in a tab you already have open. They only read the page: they never touch your token, cookies or storage, and never send, edit or delete anything.

| Function | What it does |
| --- | --- |
| `channels` | The channels in the sidebar of the open server: id, name, type (`category` for headings), unread, url. |
| `messages` | The messages currently loaded in the open channel, with no scrolling: id, author, timestamp, content, links, reply preview, attachment count. |
| `history` | Scrolls up through the open channel collecting older messages, then returns to the newest one. Args: `limit` (default 500), `since` (ISO date), `max_rounds` (150), `settle_ms` (700), `stall_rounds` (4), `force` (false). |
| `jump_to_present` | Brings the open channel back to the newest message. |

Things to know:

- Discord keeps only about 60 messages in the page and loads older ones as you scroll, but only while the tab is in front. Run `chrome-devtools --target <name> select-page` first; `history` refuses to run in a background tab.
- `history` also refuses if the tab is scrolled up in the channel (so it doesn't move you off your place); pass `-a force=true` to override.
- `history` and `jump_to_present` end at the newest message. Discord will probably count that as reading the channel, so use them on channels you have already read.
- `history` returns a `reason`: `start_of_channel` means the whole channel was pulled; `stalled`, `limit`, `since` and `max_rounds` mean it stopped early.
- Output contains other people's messages. `.gitignore` keeps `*.json` out of the repo; don't paste it anywhere public.
- The selectors lean on Discord's current markup (ids like `chat-messages-…`, `message-content-…`), which can change.

Status (2026-11-09): `channels` and `messages` were run against the live web app and checked. For `history`, the background-tab and scrolled-up guards were verified, but the scroll-and-collect loop has not yet been run against a live channel.

## Adding a script

- One file per site, with the `// ==UserAdapter==` header and an `@domain`.
- Read-only unless the name says otherwise, and never read tokens, cookies or storage.
- Take channel, query and limits as `-a key=value` args; don't hard-code IDs.
- Say what the script changes about the page's state (scroll position, read state) in its header comment.
