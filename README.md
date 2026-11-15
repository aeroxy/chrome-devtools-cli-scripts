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
- The selectors lean on Discord's current markup (ids like `chat-messages-…`, `message-content-…`), which can change.

Status (2026-11-09): `channels` and `messages` were run against the live web app and checked. For `history`, the background-tab and scrolled-up guards were verified, but the scroll-and-collect loop has not yet been run against a live channel.

## outlook.js

Mail in Outlook on the web, through the same `owa/service.svc` JSON API the web app uses. Works for work or school accounts on `outlook.cloud.microsoft` and personal accounts on `outlook.live.com`. `folders`, `list` and `read` only read; `draft`, `send`, `archive` and `remove` change the mailbox.

| Function | What it does |
| --- | --- |
| `folders` | The mail folders: id, name, well-known name (`inbox`, `sentitems`, …), total and unread counts. |
| `list` | Messages in a folder, newest first: id, received, from, subject, unread, attachments, preview. Args: `folder` (default `inbox`; also `sent`, `drafts`, `deleted`, `junk`, `archive`, or an id from `folders`), `limit` (20), `offset` (0), `unread` (false). |
| `read` | One message as plain text: from, to, cc, subject, importance, attachments (name, type, size), body. Args: `id` from `list`. |
| `draft` | Saves a message to Drafts and returns its id. Args: `subject` and `body` (required), `to`, `cc`, `bcc` (comma or semicolon separated), `html` (false). |
| `send` | Sends immediately and keeps a copy in Sent Items. Same args as `draft`, with at least one recipient. |
| `archive` | Moves a message to Archive, like the Archive button. Args: `id`. |
| `remove` | Moves a message to Deleted Items, like the Delete button. Args: `id`. |

Things to know:

- When the tab is on neither domain, the adapter switches it to `outlook.cloud.microsoft`. For a personal account, open `outlook.live.com` in the tab first.
- It uses the token the tab already holds in MSAL's cache, decrypting it on work accounts, and only inside the page: the token is never returned, logged or written to disk. If it has expired, reload the Outlook tab.
- `send` cannot be undone, and it skips what the compose window does client-side (sensitivity labels, add-ins such as SafeGuard Send). Use `draft` and press Send in Outlook when those matter. Agents: confirm recipients and body with the user before running it.
- Nothing deletes permanently: a removed message can be restored from Deleted Items. The function is `remove` because `delete` is a reserved word the adapter runner cannot call.
- Ids are immutable, so an id from `list` stays valid after `archive` or `remove`.

Status (2026-11-10): every function, `send` included, was run against a personal mailbox on `outlook.live.com` and checked. On `outlook.cloud.microsoft` it has not been run since the token lookup was changed to support personal accounts.

## teams.js

Chats and channel messages in the Teams web app (`teams.cloud.microsoft`, work or school accounts), through the chat service endpoints the web app calls. `chats`, `teams` and `read` only read; `send` posts a message as you.

| Function | What it does |
| --- | --- |
| `chats` | Conversations, newest first: id, name (the chat's title, or the people in it), type, unread, and the last message. Args: `limit` (20), `unread` (false), `type` (`oneOnOne`, `group` or `meeting`). |
| `teams` | Your teams and their channels: id, name, whether a channel is General, unread. A channel id works wherever a chat id does. |
| `read` | The newest messages in a chat or channel, oldest first: id, time, from, text, plus `edited`, `deleted` and `files` when they apply. Skips system events such as members being added. Args: `id` from `chats` or `teams`, `limit` (20, at most 200). |
| `send` | Posts a message as you. Args: `id`, `text`, `html` (false). The id `48:notes` is your own private notes chat. |

Things to know:

- `send` posts immediately and cannot be unsent. Agents: confirm the chat and the text with the user before running it. To try it out, send to `48:notes`.
- To find a chat by person or topic, run `chats` with a large `limit` and search the names.
- In `read`, replies and forwards show the quoted message with each line starting with `>`, and cards and recordings show as their message type in parentheses.
- It uses the tokens the tab already holds in MSAL's cache, only inside the page: they are never returned, logged or written to disk. If one has expired, reload the Teams tab. Graph is used only to look up display names, and people it cannot find show as `unknown`.
- The chat service URLs carry a region, set by `REGION` at the top of the file (`apac`). If requests start returning 404, change it to the region your tenant uses.
- These are Teams' own undocumented endpoints, so a Teams update can break them.

## tiktok.js

Posts videos and comments as you through the web API TikTok Studio uses, in a signed-in tab. `prepare` only adds a file input to the page; `post` and `comment` publish.

| Function | What it does |
| --- | --- |
| `prepare` | Adds a hidden file input, `#tiktok-video`, for `fill` to put the video in. Studio's own upload input would start Studio's uploader instead. |
| `post` | Uploads the video in `#tiktok-video`, publishes it and returns its `id` and `url`. Args: `description`, `hashtags` (separated by spaces or commas, `#` optional), `visibility` (`everyone`, `friends` or `only_me`; default `everyone`). It needs `description`, `hashtags` or both. |
| `comment` | Posts a comment as you and returns its id. Args: `video` (the video's URL, such as `url` from `post`), `text`. |

```bash
chrome-devtools --target <name> navigate https://www.tiktok.com/tiktokstudio/content
chrome-devtools --target <name> adapter tiktok.js prepare
chrome-devtools --target <name> fill '#tiktok-video' clip.mp4
chrome-devtools --target <name> adapter tiktok.js post -a description="..." -a hashtags="AITools, LLM"
chrome-devtools --target <name> adapter tiktok.js comment -a video=<url from post> -a text="..."
```

Things to know:

- Putting the video in the input needs a chrome-devtools whose `fill` takes a local file path when the selector matches a file input.
- Run the functions on a TikTok Studio page, where `post` reads the account and the upload region. The tab doesn't need to be in front.
- The caption is `description`, a blank line, then the hashtags. Every `#tag` in it becomes a linked hashtag, including any inside `description`. Comments are allowed on the post; duet, stitch and reuse are not. TikTok makes the cover from the video.
- `post` empties `#tiktok-video` once the video is published, so running it again can't publish the same video twice. A page reload removes the input: run `prepare` and `fill` again.
- Pass `video` as a URL. The CLI turns a bare 19-digit id into a rounded number, so `comment` refuses one.
- `post` and `comment` publish immediately and can't be undone from here. Agents: confirm the video, the text and the visibility with the user before running them.
- TikTok's own scripts in the page sign every call, so the adapter never reads tokens or cookies. The temporary upload credentials TikTok hands `post` are used only inside the page: never returned, logged or written to disk.
- The upload region comes from the page, the way Studio's uploader reads it. Only the Singapore region has been tried.
- These are TikTok's undocumented endpoints, so a TikTok update can break them.

Status (2026-11-16): `post` published an 11 MB video (three upload slices) as Only you on a Singapore-region account. The video page showed both hashtags as links and a cover, and the test post was then deleted. `comment` posted a comment on a public video (TikTok returned its id), which was then deleted. A signed API call was also checked with the tab in the background.

## Adding a script

- One file per site, with the `// ==UserAdapter==` header and an `@domain`.
- Read-only unless the function name says otherwise (`send`, `archive`, `remove`), and say which functions change anything in the header comment.
- Leave tokens, cookies and storage alone unless the site's API needs a token. Then read it inside the page and never return, log or write it.
- Take channel, query and limits as `-a key=value` args; don't hard-code IDs.
- Say what the script changes about the page's state (scroll position, read state) in its header comment.
