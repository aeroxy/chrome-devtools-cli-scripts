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

Posts videos and comments as you through the web API TikTok Studio uses, in a signed-in tab. `prepare` only adds a file input to the page, and `recent` and `comments` only read; `post` and `comment` publish.

| Function | What it does |
| --- | --- |
| `prepare` | Adds a hidden file input, `#tiktok-video`, for `fill` to put the video in. Studio's own upload input would start Studio's uploader instead. |
| `post` | Uploads the video in `#tiktok-video`, publishes it and returns its `id` and `url`. Args: `description`, `hashtags` (separated by spaces or commas, `#` optional), `visibility` (`everyone`, `friends` or `only_me`; default `everyone`). It needs `description`, `hashtags` or both. |
| `comment` | Posts a comment as you and returns its id. Args: `video` (the video's URL, such as `url` from `post`), `text`. |
| `recent` | Your latest videos, newest first: id, url, date, caption. Args: `limit` (default 10, at most 50). |
| `comments` | The first 50 comments on a video, with `mine` marking yours. Args: `video` (its URL). |

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
- TikTok has shown a video's comment count as 0 while the video had comments, so check with `comments`, not the count.
- TikTok drops a caption's line breaks: a caption posted with them reads back as one paragraph.
- These are TikTok's undocumented endpoints, so a TikTok update can break them.

Status (2026-11-16): `post` published an 11 MB video (three upload slices) as Only you on a Singapore-region account. The video page showed both hashtags as links and a cover, and the test post was then deleted. `comment` posted a comment on a public video (TikTok returned its id), which was then deleted. A signed API call was also checked with the tab in the background. `recent` and `comments` were checked against the account's own videos: `comments` found both comments on a video whose count TikTok showed as 0.

## rednote.js

Posts video notes and comments as you on RedNote (Xiaohongshu, 小红书), through the web API its own pages use, in a signed-in tab. `prepare` only adds a file input to the page, and `recent` and `comments` only read; `post` and `comment` publish.

| Function | What it does |
| --- | --- |
| `prepare` | Adds a hidden file input, `#rednote-video`, for `fill` to put the video in. The publish page's own input would start the page's uploader instead. |
| `post` | Uploads the video in `#rednote-video`, publishes it as a video note and returns its `id` and a `url` that opens it. Args: `title` (at most 20 characters), `description`, `hashtags` (RedNote topic names, separated by spaces or commas, `#` optional), `visibility` (`everyone`, `friends` or `only_me`; default `everyone`). It needs at least one of `title`, `description` and `hashtags`. |
| `comment` | Posts a comment as you and returns its id. Args: `note` (the note's URL, such as `url` from `post`, or its 24-character id), `text`. |
| `recent` | Your latest notes, newest first, up to 10: id, a `url` that opens it, date, title. Args: `limit` (default 10). |
| `comments` | The first comments on a note, with `mine` marking yours. Args: `note` (a URL from `post` or `recent`). |

```bash
chrome-devtools --target <name> select-page
chrome-devtools --target <name> navigate https://creator.xiaohongshu.com/publish/publish
chrome-devtools --target <name> adapter rednote.js prepare
chrome-devtools --target <name> fill '#rednote-video' clip.mp4
chrome-devtools --target <name> adapter rednote.js post -a title="..." -a description="..." -a hashtags="AI工具, 大模型"
chrome-devtools --target <name> navigate https://www.xiaohongshu.com/explore
chrome-devtools --target <name> adapter rednote.js comment -a note=<url from post> -a text="..."
```

Things to know:

- Putting the video in the input needs a chrome-devtools whose `fill` takes a local file path when the selector matches a file input.
- `prepare` and `post` run on the publish page, whose own video tools `post` uses to read the video's metadata and take its first frame for the cover. Other creator pages don't start those tools. `comment` runs on `www.xiaohongshu.com`.
- Let the publish page load with its tab showing (`select-page`, with Chrome not hidden behind other windows). Twice, a publish page that loaded in a hidden tab froze until the tab was shown, and every chrome-devtools command waited behind it. Once it has loaded, `post` works with the tab in the background.
- The note's text is `description`, a blank line, then the hashtags. RedNote links a hashtag only to an existing topic, so `post` looks each one up first and stops before uploading anything if one isn't a topic, naming the closest topics it found. Names match exactly first, then ignoring case; `AIAgent` and `aiagent` are separate topics. A `#` typed inside `description` stays plain text.
- `title` is counted the way the publish page counts it: a Chinese character as one, two ASCII characters as one.
- `friends` means mutual follows only. Comments and copying the note's text (允许正文复制) are allowed, the publish page's defaults for a new note.
- Some topics carry a campaign (活动). The publish page joins it when you pick such a topic from its list; `post` doesn't.
- `post` empties `#rednote-video` once the note is published, so running it again can't publish the same video twice. A page reload removes the input: run `prepare` and `fill` again.
- The `url` from `post` carries the `xsec_token` RedNote's note pages ask for, from the note manager's list. The share link RedNote returns on publishing has none, and for the test note it showed "page isn't available".
- `recent` runs on the creator site, like `post`, and `comments` on `www.xiaohongshu.com`, like `comment`. The note manager `recent` reads gives titles, not the notes' text. `comments` needs the `xsec_token` in a link from `post` or `recent`.
- `post` and `comment` publish immediately and can't be undone from here. Agents: confirm the video, the title, the text and the visibility with the user before running them.
- The page's own HTTP client signs every call, so the adapter never reads tokens or cookies. The upload permits RedNote hands `post` are used only inside the page: never returned, logged or written to disk.
- It relies on RedNote's undocumented endpoints and on page internals (the publish page's `window._publisher` and the page's HTTP client module), so a RedNote update can break it.

Status (2026-11-16): `post` published an 11 MB, 8-second video as only me, with its tab in the background. The note page showed the title, the blank line and the hashtag as a link, the note manager showed the video's first frame as the cover, and the note was then deleted. `comment` posted a comment on that note, which showed on the note page and was then deleted. `everyone` and `friends` visibility haven't been tried. `recent` and `comments` were checked against the account's own notes, and `comments` marked both of a note's link comments as yours.

## x.js

Posts and replies as you on X, through the API client X's own web app uses, in a signed-in tab. `prepare` only adds a file input to the page, and `recent` and `replies` only read; `post` and `reply` publish.

| Function | What it does |
| --- | --- |
| `prepare` | Adds a hidden file input, `#x-media`, for `fill` to put one image, GIF or video in. A text-only post doesn't need it. |
| `post` | Publishes `text`, with the file in `#x-media` attached if there is one, and returns the post's `id` and `url`. Args: `text`. It needs text, media or both. |
| `reply` | Posts a reply as you and returns its `id` and `url`. Args: `to` (the post's URL, such as `url` from `post`), `text`. |
| `recent` | Your latest posts, newest first, as your profile's Posts tab lists them, with your replies in your own threads and without reposts: id, url, date, `replyTo` (null unless it replies to a post), text with links expanded from t.co. Args: `limit` (default 10, at most 50). |
| `replies` | The replies X shows under a post, with `mine` marking yours and links expanded. Args: `post` (its URL). |

```bash
chrome-devtools --target <name> navigate https://x.com/home
chrome-devtools --target <name> adapter x.js prepare
chrome-devtools --target <name> fill '#x-media' clip.mp4
chrome-devtools --target <name> adapter x.js post -a text="..."
chrome-devtools --target <name> adapter x.js reply -a to=<url from post> -a text="..."
```

Things to know:

- Attaching media needs a chrome-devtools whose `fill` takes a local file path when the selector matches a file input.
- Run it on any signed-in `x.com` page. X's page kept answering from a background tab in testing.
- Hashtags, @mentions and links in `text` work as typed: X links them itself. X applies its own length limit and duplicate-post check, and `post` passes X's error on.
- A video is posted once X has finished processing it, as the web app does.
- `post` empties `#x-media` once the post is published, so running it again can't post the same media twice. A page reload removes the input: run `prepare` and `fill` again.
- Pass `to` as a URL. The CLI turns a bare 19-digit id into a rounded number, so `reply` refuses one. Replying to your own latest post, one after another, makes a thread. `reply` attaches no media.
- `post` and `reply` publish immediately, publicly unless the account is protected, and can't be undone from here. Agents: confirm the text and any media with the user before running them.
- It borrows X's own API client from the page, which adds the bearer token, the CSRF token and the transaction id, so the adapter never reads tokens or cookies. The query id and feature list for posting come from X's code in the page, so they follow X's updates.
- These are X's internal endpoints and page internals, so an X update can break them.

Status (2026-11-16): `post` published an 8-second, 11 MB video with text, and `reply` replied to it. Read back from X, the post had the video (720×1280) and the reply was attached to it; both were then deleted. An image upload was also tried, without posting it. `recent` and `replies` were checked against the account's own posts: `replies` found both link replies under a post, with their links expanded from t.co.

## instagram.js

Posts a video as a Reel and comments as you on Instagram, through Instagram's own web code, in a signed-in tab. `prepare` only adds a file input to the page, and `recent` and `comments` only read; `post` and `comment` publish.

| Function | What it does |
| --- | --- |
| `prepare` | Adds a hidden file input, `#ig-video`, for `fill` to put the video in. |
| `post` | Uploads the video in `#ig-video`, publishes it as a Reel and returns its `id` and `url`. Args: `caption`. |
| `comment` | Posts a comment as you and returns its id. Args: `post` (the post's URL, such as `url` from `post`), `text`. |
| `recent` | Your latest posts, newest first: id, url, date, caption. Args: `limit` (default 10, at most 50). |
| `comments` | The first comments on a post, with `mine` marking yours. Args: `post` (its URL). |

```bash
chrome-devtools --target <name> navigate https://www.instagram.com/
chrome-devtools --target <name> adapter instagram.js prepare
chrome-devtools --target <name> fill '#ig-video' clip.mp4
chrome-devtools --target <name> adapter instagram.js post -a caption="..."
chrome-devtools --target <name> adapter instagram.js comment -a post=<url from post> -a text="..."
```

Things to know:

- Putting the video in the input needs a chrome-devtools whose `fill` takes a local file path when the selector matches a file input.
- Run it on any signed-in `www.instagram.com` page. `post` loads the New post dialog's code itself, without opening the dialog.
- `post` handles one video, published as a Reel. Photos and carousels aren't supported. It reads the video's duration and size with Instagram's own container parser, so it takes MP4 and MOV files.
- Hashtags and @mentions in `caption` work as typed. Comments and like counts stay on, as Instagram sets them for a new post.
- Instagram picks the cover frame: `post` uses the composer's mode where Instagram takes it, instead of uploading a frame from the page.
- `post` empties `#ig-video` once the Reel is published, so running it again can't publish the same video twice. A page reload removes the input: run `prepare` and `fill` again.
- `comment` takes the post's URL and works out the media id from the code in it.
- `post` and `comment` publish immediately, publicly unless the account is private, and can't be undone from here. Agents: confirm the video, the caption and the text with the user before running them.
- It calls Instagram's own modules through the page's `require`, and those add the CSRF and session tokens, so the adapter never reads tokens or cookies.
- These are Instagram's internal endpoints and page internals, so an Instagram update can break them.

Status (2026-11-16): from a freshly loaded home page, `post` published an 8-second, 11 MB video as a public Reel and `comment` commented on it. The Reel page showed the video, the caption and one comment, and the Reel was then deleted. A background tab hasn't been tried. `recent` and `comments` were checked against the account's own Reels.

## youtube.js

Uploads videos and comments on your videos as you on YouTube, through YouTube Studio's own web client, in a signed-in tab. `prepare` only adds a file input to the page, and `recent` and `comments` only read; `post` and `comment` publish.

| Function | What it does |
| --- | --- |
| `prepare` | Adds a hidden file input, `#yt-video`, for `fill` to put the video in. |
| `post` | Uploads the video in `#yt-video`, publishes it and returns its `id` and `url`. Args: `title` (required), `description`, `visibility` (`public`, `unlisted` or `private`; default `public`). |
| `comment` | Posts a comment as you on a video on your own channel and returns its id. Args: `video` (the video's URL, such as `url` from `post`, or its id), `text`. |
| `recent` | Your latest uploads, newest first: id, url, date, visibility, title, description. Args: `limit` (default 10, at most 50). |
| `comments` | The newest published comments on one of your videos, with `mine` marking yours. A comment just posted can take about 20 seconds to show. Args: `video`. |

```bash
chrome-devtools --target <name> navigate https://studio.youtube.com/
chrome-devtools --target <name> adapter youtube.js prepare
chrome-devtools --target <name> fill '#yt-video' clip.mp4
chrome-devtools --target <name> adapter youtube.js post -a title="..." -a description="..."
chrome-devtools --target <name> adapter youtube.js comment -a video=<url from post> -a text="..."
```

Things to know:

- Putting the video in the input needs a chrome-devtools whose `fill` takes a local file path when the selector matches a file input.
- Run it on a signed-in `studio.youtube.com` page.
- `post` marks the video as not made for kids, the answer Studio requires before publishing. YouTube decides whether it's a Short and processes the video after publishing, so it can take a few minutes to play.
- `comment` works on videos on your own channel, because it goes through Studio, which only lists comments for your own videos. YouTube refuses comments on private videos.
- `post` empties `#yt-video` once the video is published, so running it again can't upload the same video twice. A page reload removes the input: run `prepare` and `fill` again.
- If YouTube refuses the details after the upload, the video stays as a private draft in Studio, and `post` says so.
- `post` and `comment` publish immediately and can't be undone from here. Agents: confirm the video, the title, the description, the visibility and the text with the user before running them.
- It uses Studio's own services: its InnerTube client signs the calls and handles Google's re-authentication prompts, and its BotGuard attestation object attests the upload and the publish, so the adapter never reads tokens or cookies.
- These are YouTube's internal endpoints and page internals, so a YouTube update can break them.

Status (2026-11-16): `post` uploaded an 8-second, 11 MB video and published it as private. Read back from Studio, it had the title and description, was out of draft, not made for kids and processed. `comment` was refused on the private video, as YouTube does, then posted once the video was switched to unlisted, and showed in Studio. The video was then deleted. Public visibility hasn't been tried. `recent` and `comments` were checked against the channel's own videos.

## reddit.js

Posts text and link posts and comments as you on Reddit, through the endpoints Reddit's own web app uses, in a signed-in tab. `post` and `comment` publish; `rules`, `recent` and `comments` only read.

| Function | What it does |
| --- | --- |
| `post` | Publishes to the subreddit whose submit page the tab is on and returns the post's `id` and `url`. Args: `title` (required), `url` (makes it a link post), `text` (the body, in Markdown), `flair` (a flair id from `rules`). |
| `comment` | Posts a comment, in Markdown, on the post the tab is showing and returns its `comment` id and `url`. Args: `post` (the post's URL, such as `url` from `post`), `text`. |
| `rules` | What a subreddit asks of a post: the post types it takes (`postTypes`: `any`, `link` or `self`), the requirements it has set (flair, title and body rules, allowed domains), its rules, and its post flairs with their ids. Args: `subreddit`. |
| `recent` | Your latest posts, newest first: id, url, date, subreddit, title, link, text. Args: `limit` (default 10, at most 50). |
| `comments` | The newest top-level comments on a post, in Markdown, with `mine` marking yours. Args: `post` (its URL). |

```bash
chrome-devtools --target <name> adapter reddit.js rules -a subreddit=<subreddit>
chrome-devtools --target <name> navigate https://www.reddit.com/r/<subreddit>/submit
chrome-devtools --target <name> adapter reddit.js post -a title="..." -a url="https://..."
chrome-devtools --target <name> navigate <url from post>
chrome-devtools --target <name> adapter reddit.js comment -a post=<url from post> -a text="..."
```

Things to know:

- Run `post` on the subreddit's submit page and `comment` on the post's page. Reddit gets a Google reCAPTCHA Enterprise token when you press each form's button, and these functions ask that form's own code for one.
- `comment` checks that the tab shows the post you named, so it can't comment on the wrong one.
- `text` is Markdown in both functions, and a link post can have a body too.
- Run `rules` before posting: a subreddit that requires a flair refuses a post without one, many require a body, and some bar words from titles. `post` sets no NSFW or spoiler tag.
- Let the page load with its tab showing (`select-page`). Once, a Reddit page that loaded in a background tab froze until the tab was shown, and every chrome-devtools command waited behind it.
- `post` and `comment` publish immediately and can't be undone from here. Agents: confirm the subreddit, the title, the link and the text with the user before running them.
- Every request carries Reddit's CSRF token. Reddit's own scripts read it from the `csrf_token` cookie, and the adapter does the same inside the page, never returning or logging it. It touches no other cookie.
- These are Reddit's internal endpoints and page internals, so a Reddit update can break them.

Status (2026-11-16): in a test subreddit, `post` published a text post (a Markdown body with bold text and two paragraphs) and a link post, and `comment` commented on the text post in Markdown. All three rendered as written and were then deleted. `rules`, `recent` and `comments` were checked against live subreddits and the account's own posts. Posting with `flair` hasn't been tried; the field comes from the submit form's own code.

## linkedin.js

Posts and comments as you on LinkedIn, by driving LinkedIn's own post composer and comment box in a signed-in tab. `prepare` only adds a file input to the page, and `recent` and `comments` only read; `post` and `comment` publish.

| Function | What it does |
| --- | --- |
| `prepare` | Adds a hidden file input, `#li-media`, for `fill` to put one image or video in. A text-only post doesn't need it. |
| `post` | Publishes `text` through the feed's Start a post composer, with the file in `#li-media` attached if there is one, and returns the post's `id` and `url`. Args: `text`. It needs text, media or both. |
| `comment` | Posts a comment as you on the post the tab is showing and returns its `comment` id and `url`. Args: `post` (the post's URL, such as `url` from `post`), `text`. |
| `recent` | Your latest posts, newest first, from your activity page, without reposts or other activity: id, url, date, text. Args: `limit` (default 10, at most 50). |
| `comments` | The comments the post's page shows, with `mine` marking yours. Args: `post` (its URL). |

```bash
chrome-devtools --target <name> navigate https://www.linkedin.com/feed/
chrome-devtools --target <name> adapter linkedin.js prepare
chrome-devtools --target <name> fill '#li-media' clip.mp4
chrome-devtools --target <name> select-page
chrome-devtools --target <name> adapter linkedin.js post -a text="..."
chrome-devtools --target <name> navigate <url from post>
chrome-devtools --target <name> adapter linkedin.js comment -a post=<url from post> -a text="..."
```

Things to know:

- Attaching media needs a chrome-devtools whose `fill` takes a local file path when the selector matches a file input.
- Run `post` on the feed and `comment` on the post's own page. LinkedIn serves the post page from its older web app, whose comment box differs from the feed's.
- LinkedIn's media editor loads a file only while its tab is showing, so `post` refuses to attach one in a background tab. Run `select-page` straight before `post`, with Chrome not hidden behind other windows: in testing, the tab sometimes went back to hidden within seconds. A text-only post and `comment` don't need the tab showing: in dry runs from a background tab, both got as far as LinkedIn's Post and Comment buttons.
- `post` finds LinkedIn's buttons by their English names (Start a post, Media, Next, Post), so it needs LinkedIn's interface in English.
- Each line of `text` is a line of the post or comment, blank lines included. Pasting text into LinkedIn's composer drops blank lines; `post` doesn't paste but builds the lines in LinkedIn's editor, one paragraph per line and an empty one per blank line, as pressing Enter does.
- Pass real line breaks in `text`: the CLI keeps a typed `\n` as a backslash and an `n`. In bash, a quoted string that spans lines works, as does `-a text="$(printf 'one\n\ntwo')"`.
- LinkedIn links hashtags and web addresses itself. An `@name` stays plain text: tagging someone means picking them from LinkedIn's suggestions, which `post` doesn't do.
- `post` leaves the audience and comment settings as the composer shows them. In testing, that was Anyone for both.
- `post` stops if a composer is already open, or if the composer opens with a saved draft in it, so it never posts over your draft.
- `post` returns once LinkedIn has added the post to your feed. For a video, that's after LinkedIn has uploaded and processed it, so a long video takes a while; `post` waits up to 10 minutes.
- `post` empties `#li-media` once the post is published, so running it again can't post the same media twice. A page reload removes the input: run `prepare` and `fill` again.
- `comment` checks that the tab shows the post you named, so it can't comment on the wrong one. Pass `post` as a URL: the CLI turns a bare 19-digit id into a rounded number, so `comment` refuses one.
- The `url` from `comment` has the form LinkedIn's Copy link to comment uses. A link to the post with only `commentUrn` added opened the post without showing the comment.
- `recent` runs on your activity page (`https://www.linkedin.com/in/me/recent-activity/all/`) and sees what the page has loaded, usually a few weeks. `comments` runs on the post's page, like `comment`.
- `post` and `comment` publish immediately, publicly, and can't be undone from here. Agents: confirm the text, any image or video, and the post to comment on with the user first.
- Both put the text in through LinkedIn's own editors and press LinkedIn's own buttons, so LinkedIn's code sends every request with its tokens, and the adapter never reads tokens or cookies. To learn the new post's id, `post` watches the page's requests after Post and reads only the id from the one that adds the post to your feed.
- These are LinkedIn's page internals, so a LinkedIn update can break them.

Status (2026-11-16): `post` published an 8-second, 11 MB video with text from the feed, and `comment` commented on it from the post's page. LinkedIn's own success toast linked to the same post URL `post` returned, and the reloaded post page showed the video, the text and the comment under the id `comment` returned. A second, text-only post had a line break, a blank line and two blank lines in a row, and a comment on it had a line break and a blank line; LinkedIn stored and showed both exactly as written. Both posts were then deleted, with their comments. Attaching an image was dry-run up to the Post button but not published. `recent` and `comments` were checked against the account's own posts, and the dates `recent` reads from post ids matched when the posts were made.

## Adding a script

- One file per site, with the `// ==UserAdapter==` header and an `@domain`.
- Read-only unless the function name says otherwise (`send`, `archive`, `remove`), and say which functions change anything in the header comment.
- Leave tokens, cookies and storage alone unless the site's API needs a token. Then read it inside the page and never return, log or write it.
- Take channel, query and limits as `-a key=value` args; don't hard-code IDs.
- Say what the script changes about the page's state (scroll position, read state) in its header comment.
