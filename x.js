// ==UserAdapter==
// @name         X posts and replies
// @domain       x.com
// ==/UserAdapter==

// Post and reply on X as you, through the API client X's own web app uses, in a signed-in tab.
//
//   chrome-devtools --target <name> navigate https://x.com/home
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/x.js prepare
//   chrome-devtools --target <name> fill '#x-media' clip.mp4
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/x.js post -a text="..."
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/x.js reply -a to=<url from post> -a text="..."
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/x.js recent [-a limit=10]
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/x.js replies -a post=<url>
//
// recent and replies only read. recent lists your latest posts, newest first, as your profile's Posts tab does (your replies in your own threads included, reposts left out), with id, url, date, replyTo (the post it replies to, or null) and text, links expanded from t.co. replies lists the replies X shows under a post, marking yours with mine.
//
// prepare adds a hidden file input for fill to put one image, GIF or video in. A text-only post needs neither prepare nor fill.
//
// post publishes text, with the file in #x-media attached if there is one, returns the post's id and url, and empties the input, so posting again needs a new fill. Hashtags, @mentions and links in text work as typed: X links them itself.
//
// reply posts a reply to a post and returns its id and url. Pass the post's URL: the CLI turns a bare 19-digit id into a rounded number. Replying to your own latest post, one after another, makes a thread. reply attaches no media.
//
// Run them on any signed-in x.com page. X's page kept answering from a background tab in testing.
//
// How it works: X's web app hands its API client to Redux thunks, so this file dispatches one to the page's store and borrows the client. The client adds the bearer token, the CSRF token and x-client-transaction-id itself, so this file never touches tokens or cookies. CreateTweet's query id and feature list come from X's own operation module in the page, so they follow X's current build. Media goes up to upload.x.com through the same client in chunks (INIT, APPEND, FINALIZE, then STATUS until X has processed it). These are X's internal endpoints and page internals, so an X update can break them. The requests follow what the web app sent in November 2026.
//
// post and reply publish immediately as you, publicly unless the account is protected, and cannot be undone from here. Agents: confirm the text and any media with the user first.

const INPUT_ID = 'x-media';
// Upload chunk size. X's APPEND command takes up to 5 MB per chunk.
const CHUNK_BYTES = 4 * 1024 * 1024;

let borrowed;
let readState;

// What X's web app gives its Redux thunks: { api, featureSwitches, ... }. The store sits on the React root's Provider.
function app() {
  if (borrowed) return borrowed;
  const root = document.getElementById('react-root');
  const key = root && Object.keys(root).find((k) => k.startsWith('__reactContainer$'));
  const fibers = key ? [root[key]] : [];
  while (fibers.length && !borrowed) {
    const fiber = fibers.pop();
    const store = fiber.memoizedProps?.store;
    if (store?.dispatch && store.getState) {
      try {
        store.dispatch((dispatch, getState, extra) => {
          borrowed = extra;
          readState = getState;
        });
      } catch {
        // A store without thunks: reported below.
      }
      break;
    }
    if (fiber.sibling) fibers.push(fiber.sibling);
    if (fiber.child) fibers.push(fiber.child);
  }
  if (!borrowed?.api?.apiClient?.graphQLFullResponse) {
    throw new Error("Could not find X's API client in this page. Open https://x.com/home in this tab, signed in, and retry. If that doesn't help, X has changed its web app and this adapter needs updating.");
  }
  return borrowed;
}

// X's own document for a GraphQL operation: its query id and the feature switches it sends. Each lives in a small webpack module of its own.
function operation(name) {
  let load;
  window.webpackChunk_twitter_responsive_web?.push([[Symbol('x')], {}, (r) => { load = r; }]);
  const id = load && Object.keys(load.m).find((k) => {
    const src = String(load.m[k]);
    return src.includes('exports={queryId:') && src.includes(`operationName:"${name}"`);
  });
  const doc = id && load(id);
  if (doc?.operationName !== name || !doc.queryId) throw new Error(`Could not find X's ${name} operation in this page. Reload the tab and retry.`);
  return doc;
}

// Runs a GraphQL operation through X's client, which fills in the feature switches. X reports refusals (duplicate post, too long, spam checks) as errors beside the data.
async function graphql(name, variables) {
  let res;
  try {
    res = await app().api.apiClient.graphQLFullResponse(operation(name), variables);
  } catch (error) {
    throw new Error(`${name} failed: ${error?.message ?? error}`);
  }
  if (res?.errors?.length) throw new Error(`X refused ${name}: ${res.errors.map((e) => `${e.message}${e.code ? ` (code ${e.code})` : ''}`).join('; ')}`);
  return res?.data;
}

// One call to upload.x.com through X's client, which sends the same auth headers X's uploader does.
function upload(method, params, form) {
  return app().api.apiClient.dispatch({ host: 'https://upload.x.com', path: '/i/media/upload.json', method, params, ...(form ? { data: form, headers: { 'content-type': 'multipart/form-data' } } : {}) });
}

// The media_category X's uploader uses for each kind of file.
function mediaCategory(file) {
  if (file.type === 'image/gif') return 'tweet_gif';
  if (file.type.startsWith('image/')) return 'tweet_image';
  if (file.type.startsWith('video/')) return 'amplify_video';
  throw new Error(`X takes an image, a GIF or a video; this file's type is ${file.type || 'unknown'}`);
}

// Uploads the file and waits until X has processed it, as the web app does before posting. Returns the media id.
async function uploadMedia(file) {
  const started = await upload('POST', { command: 'INIT', total_bytes: file.size, media_type: file.type, media_category: mediaCategory(file) });
  const id = started?.media_id_string;
  if (!id) throw new Error('X did not start the media upload');
  for (let start = 0, index = 0; start < file.size; start += CHUNK_BYTES, index++) {
    const form = new FormData();
    form.append('media', file.slice(start, start + CHUNK_BYTES), 'blob');
    await upload('POST', { command: 'APPEND', media_id: id, segment_index: index }, form);
  }
  let info = (await upload('POST', { command: 'FINALIZE', media_id: id, allow_async: true }))?.processing_info;
  // X says how long to wait between checks. The cap only keeps a stuck video from holding the CLI forever.
  for (let check = 0; info && info.state !== 'succeeded'; check++) {
    if (info.state === 'failed') throw new Error(`X could not process the media: ${info.error?.message ?? 'processing failed'}`);
    if (check === 300) throw new Error('X was still processing the media after 300 checks. Nothing was posted.');
    await new Promise((resolve) => setTimeout(resolve, (info.check_after_secs || 1) * 1000));
    info = (await upload('GET', { command: 'STATUS', media_id: id }))?.processing_info;
  }
  return id;
}

// Publishes with CreateTweet, as the web app's composer does. semantic_annotation_options is what the composer sent from a profile page (a post) and a post's page (a reply).
async function createTweet(text, { mediaId, replyTo } = {}) {
  const data = await graphql('CreateTweet', {
    tweet_text: text,
    ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo, exclude_reply_user_ids: [] } } : {}),
    media: { media_entities: mediaId ? [{ media_id: mediaId, tagged_users: [] }] : [], possibly_sensitive: false },
    semantic_annotation_ids: [],
    disallowed_reply_options: null,
    semantic_annotation_options: { composition_signal_1: true, source: replyTo ? 'Unknown' : 'Profile' },
  });
  const result = data?.create_tweet?.tweet_results?.result;
  // Posts with limited visibility come wrapped as { tweet }.
  const tweet = result?.tweet ?? result;
  if (!tweet?.rest_id) throw new Error(`X did not return the new post: ${JSON.stringify(data).slice(0, 200)}`);
  const handle = tweet.core?.user_results?.result?.core?.screen_name;
  return { id: tweet.rest_id, url: `https://x.com/${handle ?? 'i/web'}/status/${tweet.rest_id}` };
}

// A post's id from its URL, passed as the arg called name. A bare id passed with -a arrives as a number the CLI has already rounded, so it is refused rather than used.
function postId(value, name = 'to') {
  if (typeof value === 'number') throw new Error('Pass the post URL (https://x.com/<handle>/status/<id>), not the bare id: the CLI turns a 19-digit number into a rounded one.');
  const id = /\/status(?:es)?\/(\d+)/.exec(String(value ?? ''))?.[1];
  if (!id) throw new Error(`${name} is required: the post URL, e.g. -a ${name}=https://x.com/<handle>/status/<id>`);
  return id;
}

// How many items a list function returns: limit, from 1 to 50, 10 unless given.
const limitFrom = (value) => Math.min(Math.max(Math.trunc(Number(value)) || 10, 1), 50);

// The signed-in account's user id, from the web app's session state.
function myId() {
  app();
  const id = readState?.().session?.user_id;
  if (!id) throw new Error('Could not find the signed-in account in this page. Open https://x.com/home in this tab, signed in, and retry.');
  return id;
}

// Every post in an X API response, in the order X lists them. X wraps some posts in a visibility envelope.
function postsIn(data) {
  const found = new Map();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const post = node.__typename === 'TweetWithVisibilityResults' ? node.tweet : node.__typename === 'Tweet' ? node : null;
    if (post?.rest_id && post.legacy && !found.has(post.rest_id)) found.set(post.rest_id, post);
    Object.values(node).forEach(walk);
  };
  walk(data);
  return [...found.values()];
}

const handleOf = (post) => post.core?.user_results?.result?.core?.screen_name ?? post.core?.user_results?.result?.legacy?.screen_name;

// A post's text as written: X's long-post text when there is one, links expanded from t.co, and the t.co link X adds for attached media left out.
function textOf(post) {
  const note = post.note_tweet?.note_tweet_results?.result;
  let text = note?.text ?? post.legacy.full_text ?? '';
  for (const u of [...(note?.entity_set?.urls ?? []), ...(post.legacy.entities?.urls ?? [])]) if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
  for (const m of post.legacy.entities?.media ?? []) if (m.url) text = text.split(m.url).join('');
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}

const postText = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();

// Adds the hidden file input that fill puts the media in. It lasts until the page reloads.
async function prepare() {
  app();
  if (!document.getElementById(INPUT_ID)) {
    document.body.append(Object.assign(document.createElement('input'), { type: 'file', id: INPUT_ID, accept: 'image/*,video/*', hidden: true }));
  }
  return { selector: `#${INPUT_ID}` };
}

async function post(ctx) {
  const text = postText(ctx.args.text);
  const input = document.getElementById(INPUT_ID);
  const file = input?.files?.[0];
  if (!text && !file) throw new Error(`Pass text, or put media in #${INPUT_ID} with prepare and fill, or both`);
  if (file) mediaCategory(file);
  const mediaId = file ? await uploadMedia(file) : undefined;
  const posted = await createTweet(text, { mediaId });
  if (input) input.value = '';
  return { ...posted, text, media: file ? file.name : null };
}

// Your latest posts, newest first, as your profile's Posts tab lists them, without reposts.
async function recent(ctx) {
  const userId = myId();
  const limit = limitFrom(ctx.args.limit);
  const data = await graphql('UserTweets', { userId, count: limit + 5, includePromotedContent: false, withQuickPromoteEligibilityTweetFields: true, withVoice: true });
  return postsIn(data)
    .filter((p) => p.legacy.user_id_str === userId && !p.legacy.retweeted_status_result)
    .sort((a, b) => (BigInt(b.rest_id) > BigInt(a.rest_id) ? 1 : -1))
    .slice(0, limit)
    .map((p) => ({ id: p.rest_id, url: `https://x.com/${handleOf(p) ?? 'i/web'}/status/${p.rest_id}`, date: new Date(p.legacy.created_at).toISOString(), replyTo: p.legacy.in_reply_to_status_id_str ?? null, text: textOf(p) }));
}

// The replies X shows under a post on its page, marking yours. Your own replies come first, as X lists a thread.
async function replies(ctx) {
  const id = postId(ctx.args.post, 'post');
  const userId = myId();
  const data = await graphql('TweetDetail', { focalTweetId: id, with_rux_injections: false, rankingMode: 'Relevance', includePromotedContent: false, withCommunity: true, withQuickPromoteEligibilityTweetFields: true, withBirdwatchNotes: true, withVoice: true });
  const posts = postsIn(data);
  const conversation = posts.find((p) => p.rest_id === id)?.legacy.conversation_id_str;
  return {
    post: id,
    // X's post ids grow with time, so a larger id in the same conversation is a reply after the post.
    replies: posts
      .filter((p) => p.legacy.conversation_id_str === conversation && BigInt(p.rest_id) > BigInt(id))
      .map((p) => ({ id: p.rest_id, author: handleOf(p), mine: p.legacy.user_id_str === userId, replyTo: p.legacy.in_reply_to_status_id_str, text: textOf(p) })),
  };
}

async function reply(ctx) {
  const replyTo = postId(ctx.args.to);
  const text = postText(ctx.args.text);
  if (!text) throw new Error('text is required');
  return { ...(await createTweet(text, { replyTo })), to: replyTo, text };
}
