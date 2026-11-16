// ==UserAdapter==
// @name         LinkedIn posts and comments
// @domain       www.linkedin.com
// ==/UserAdapter==

// Post and comment on LinkedIn as you, by driving LinkedIn's own composer and comment box in a signed-in tab.
//
//   chrome-devtools --target <name> navigate https://www.linkedin.com/feed/
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/linkedin.js prepare
//   chrome-devtools --target <name> fill '#li-media' clip.mp4
//   chrome-devtools --target <name> select-page
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/linkedin.js post -a text="..."
//   chrome-devtools --target <name> navigate <url from post>
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/linkedin.js comment -a post=<url from post> -a text="..."
//
// prepare adds a hidden file input for fill to put one image or video in. A text-only post needs no prepare, fill or select-page.
//
// post runs on the feed. It opens the Start a post composer, attaches the file in #li-media if there is one, puts text in, presses Post, and returns the post's id and url once LinkedIn has added the post to your feed, which for a video is after LinkedIn has uploaded and processed it. It empties the input, so posting again needs a new fill. It leaves the composer's audience and comment settings as LinkedIn shows them (Anyone for both, in testing). Each line of text is a line of the post, blank lines included: post builds the lines in LinkedIn's editor, which keeps the blank lines that pasting into the composer drops. LinkedIn links hashtags and web addresses itself; an @name stays plain text. LinkedIn's media editor loads a file only while its tab is showing, so post refuses to attach one in a background tab: run select-page first.
//
// comment runs on the post's own page, which LinkedIn still serves from its older web app, and returns the comment's id and url. It keeps line breaks in text, blank lines included. Pass the post's URL as post: comment checks it against the page so it can't comment on the wrong post.
//
// How it works: both functions put the text in through LinkedIn's own editors (TipTap in the composer, Quill in the comment box) and press LinkedIn's own buttons, so LinkedIn's code sends every request and adds its tokens; this file never reads tokens or cookies. To attach a file, post hands it to the file input LinkedIn's media editor clicks open, instead of letting the file chooser open. To learn the new post's id, post watches the requests the page sends after Post and reads only the id from the one that adds the post to your feed. These are LinkedIn's page internals, so a LinkedIn update can break them. They follow LinkedIn's web app as of November 2026.
//
// post and comment publish immediately as you, publicly, and cannot be undone from here. Agents: confirm the text, any image or video, and the post to comment on with the user first.

const INPUT_ID = 'li-media';
// The screen that holds the Start a post composer.
const COMPOSER = 'com.linkedin.sdui.flagshipnav.sharing.ShareCompose';
// How long post waits for LinkedIn to finish a post, which for a long video includes uploading and processing it.
const PUBLISH_MINUTES = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Checks four times a second until check returns something, or fails with message after the given seconds.
async function until(check, seconds, message) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(message);
    await sleep(250);
  }
}

const label = (el) => (el.getAttribute('aria-label') || el.innerText || '').trim();
const button = (root, name) => root && [...root.querySelectorAll('button')].find((b) => label(b) === name);
const enabled = (b) => (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null);
const composer = () => document.querySelector(`[data-sdui-screen="${COMPOSER}"]`)?.closest('dialog[open]');
// The media editor opens over the composer and leaves with Next.
const mediaEditor = () => [...document.querySelectorAll('dialog[open]')].find((d) => button(d, 'Next'));
const plain = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();

function startButton() {
  const start = document.querySelector('[aria-label="Start a post"]')?.closest('[role="button"]');
  if (!start) throw new Error('This runs on the LinkedIn feed. Open https://www.linkedin.com/feed/ in this tab, signed in, first.');
  return start;
}

// The media editor asks for files by clicking a file input of its own. While it opens, a click on a file input gets the file instead of the file chooser.
async function attach(file) {
  const media = button(composer(), 'Media');
  if (!media) throw new Error("LinkedIn's composer has no Media button. Discard the post in LinkedIn and retry.");
  const click = HTMLInputElement.prototype.click;
  let handed = false;
  HTMLInputElement.prototype.click = function () {
    if (this.type !== 'file') return click.apply(this, arguments);
    if (handed) return;
    handed = true;
    const files = new DataTransfer();
    files.items.add(file);
    this.files = files.files;
    this.dispatchEvent(new Event('change', { bubbles: true }));
  };
  try {
    media.click();
    await until(() => handed, 20, "LinkedIn's media editor didn't ask for a file. Discard the post in LinkedIn and retry.");
  } finally {
    HTMLInputElement.prototype.click = click;
  }
  const next = await until(() => enabled(button(mediaEditor(), 'Next')), 120, `LinkedIn's media editor didn't finish loading ${file.name}. LinkedIn takes JPEG, PNG, GIF, WebP, AVIF and BMP images and common video formats.`);
  next.click();
  await until(() => !mediaEditor() && composer(), 30, "LinkedIn's media editor didn't close. Check the tab.");
}

// Resolves with the activity id of the next post the page adds to the top of the feed, read from the request it sends for that.
function watchFeed() {
  const original = window.fetch;
  let found;
  const added = new Promise((resolve) => {
    found = resolve;
  });
  const watcher = function (resource, init) {
    if (String(resource?.url ?? resource).includes('addUpdateToFeedListRequest') && typeof init?.body === 'string') {
      const id = /"activityId":"(\d+)"/.exec(init.body)?.[1];
      if (id) found(id);
    }
    return original.apply(this, arguments);
  };
  window.fetch = watcher;
  return {
    added,
    stop: () => {
      if (window.fetch === watcher) window.fetch = original;
    },
  };
}

// Adds the hidden file input that fill puts the image or video in. It lasts until the page reloads.
async function prepare() {
  startButton();
  if (!document.getElementById(INPUT_ID)) {
    document.body.append(Object.assign(document.createElement('input'), { type: 'file', id: INPUT_ID, accept: 'image/*,video/*', hidden: true }));
  }
  return { selector: `#${INPUT_ID}` };
}

async function post(ctx) {
  const text = plain(ctx.args.text);
  const input = document.getElementById(INPUT_ID);
  const file = input?.files?.[0];
  if (!text && !file) throw new Error(`Pass text, or put an image or video in #${INPUT_ID} with prepare and fill, or both`);
  if (file && !/^(image|video)\//.test(file.type)) throw new Error(`LinkedIn posts take an image or a video; this file's type is ${file.type || 'unknown'}`);
  if (file && document.visibilityState !== 'visible') throw new Error("LinkedIn's media editor loads a file only while its tab is showing. Run select-page for this target, with Chrome not hidden behind other windows, then post again.");
  const start = startButton();
  if (composer()) throw new Error("LinkedIn's composer is already open in this tab. Post or discard what's in it first.");

  start.click();
  const editor = await until(() => composer()?.querySelector('.tiptap.ProseMirror[role="textbox"]')?.editor, 20, "LinkedIn's composer didn't open. Reload the feed and retry.");
  if (!editor.isEmpty) throw new Error('LinkedIn opened the composer with a saved draft in it. Post or discard the draft in LinkedIn first.');
  if (file) await attach(file);
  // One paragraph per line, as pressing Enter makes. The composer sends paragraphs joined by a newline.
  editor
    .chain()
    .clearContent(true)
    .insertContent(text.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })))
    .run();
  const send = await until(() => enabled(button(composer(), 'Post')), 20, 'LinkedIn kept Post disabled. Check the composer in the tab: the text may be over its length limit.');

  const feed = watchFeed();
  try {
    send.click();
    await until(() => !composer(), 60, "LinkedIn didn't take the post: its composer is still open. Check the tab.");
    const id = await Promise.race([
      feed.added,
      sleep(PUBLISH_MINUTES * 60 * 1000).then(() => {
        throw new Error(`LinkedIn hadn't finished the post after ${PUBLISH_MINUTES} minutes. Look for it on your profile before posting again.`);
      }),
    ]);
    if (input) input.value = '';
    return { id: `urn:li:activity:${id}`, url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`, text, media: file ? file.name : null };
  } finally {
    feed.stop();
  }
}

// A post's id from its URL: /feed/update/urn:li:activity:<id>/ (or ugcPost or share), or /posts/<name>_<words>-activity-<id>-<code>/.
function postId(value) {
  if (typeof value === 'number') throw new Error('Pass the post URL: the CLI turns a bare 19-digit id into a rounded number.');
  const id = /(?:activity|ugcPost|share)[:-](\d+)/.exec(String(value ?? ''))?.[1];
  if (!id) throw new Error('post is required: the post URL, e.g. -a post=https://www.linkedin.com/feed/update/urn:li:activity:<id>/');
  return id;
}

// A comment's link as LinkedIn's Copy link to comment writes it: the post's thread, then the comment in two forms, parentheses encoded. A link with only commentUrn didn't show the comment.
function commentUrl(urn) {
  const [, thread, commentId] = /^urn:li:comment:\((\w+:\d+),(\d+)\)$/.exec(urn) ?? [];
  if (!thread) return null;
  const encode = (value) => encodeURIComponent(value).replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `https://www.linkedin.com/feed/update/urn:li:${thread}?commentUrn=${encode(urn)}&dashCommentUrn=${encode(`urn:li:fsd_comment:(${commentId},urn:li:${thread})`)}`;
}

async function comment(ctx) {
  const id = postId(ctx.args.post);
  const text = plain(ctx.args.text);
  if (!text) throw new Error('text is required');
  const form = await until(() => document.querySelector('form.comments-comment-box__form'), 15, `comment runs on the post's page. Open ${ctx.args.post} in this tab first.`);
  const thread = form.closest('[data-urn]');
  const quill = form.querySelector('.ql-container')?.__quill;
  if (!thread || !quill) throw new Error("This page's comment box isn't the one comment knows. LinkedIn has changed its post page and this adapter needs updating.");
  if (!location.href.includes(id) && !thread.dataset.urn.includes(id)) throw new Error(`This tab shows ${thread.dataset.urn}, not post ${id}. Open the post you want to comment on first.`);

  const comments = () => [...thread.querySelectorAll('[data-id^="urn:li:comment:"]')];
  const before = new Set(comments().map((c) => c.dataset.id));
  quill.setText(text, 'user');
  // The comment box passes its text on to the Comment button's code 300 ms after the last change. Pressing sooner could send an empty comment.
  await sleep(1000);
  // The Comment button appears once the box has text. It has no type attribute, so it submits the form by default.
  const send = await until(() => enabled([...form.querySelectorAll('button')].find((b) => b.type === 'submit')), 20, "LinkedIn didn't offer its Comment button for this text. Check the comment box in the tab.");
  send.click();
  const created = await until(() => comments().find((c) => !before.has(c.dataset.id)), 60, "LinkedIn didn't show the new comment within a minute. Reload the post's page to check before commenting again.");
  return { post: thread.dataset.urn, comment: created.dataset.id, url: commentUrl(created.dataset.id), text };
}
