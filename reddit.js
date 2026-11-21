// ==UserAdapter==
// @name         Reddit posts and comments
// @domain       www.reddit.com
// ==/UserAdapter==

// Post a text, link or image post to a subreddit and comment on posts as you, through the endpoints Reddit's own web app uses, in a signed-in tab.
//
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/reddit.js rules -a subreddit=<name>
//   chrome-devtools --target <name> navigate https://www.reddit.com/r/<subreddit>/submit
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/reddit.js post -a title="..." [-a url="https://..."] [-a text="..."] [-a flair=<id from rules>]
//   chrome-devtools --target <name> navigate https://www.reddit.com/r/<subreddit>/submit/?type=IMAGE
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/reddit.js prepare
//   chrome-devtools --target <name> fill '#reddit-media' screenshot.png
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/reddit.js post -a title="..." [-a text="..."] [-a flair=<id from rules>]
//   chrome-devtools --target <name> navigate <url from post>
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/reddit.js comment -a post=<url from post> -a text="..." [-a parent=<comment id or permalink>]
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/reddit.js recent [-a limit=10]
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/reddit.js comments -a post=<url> [-a parent=<comment id or permalink>]
//
// rules, recent and comments only read, on any www.reddit.com page. rules shows what a subreddit asks of a post: the post types it takes (postTypes: any, link or self), the posting requirements it has set (requirements, such as is_flair_required, body_restriction_policy, title_blacklisted_strings or domain_whitelist), its rules and its post flairs with their ids. recent lists your latest posts, newest first, with id, url, date, subreddit, title, link, text and removed (null for a post that is up, or Reddit's reason, such as automod_filtered, when a moderator or the subreddit's AutoModerator has removed or held it). comments lists the newest top-level comments on a post, marking yours with mine; they come back in Markdown, so a pasted link can read [url](url).
//
// post publishes to the subreddit whose submit page the tab is on and returns the post's id and url. With url it's a link post, with an image in #reddit-media it's an image post, and with neither it's a text post. text is the body, in Markdown, and is optional for all three, unless the subreddit requires one. An image post runs on the submit page's Images tab (/submit/?type=IMAGE), where prepare adds the hidden file input for fill to put one JPEG, PNG, WebP or GIF image in; post empties the input afterwards, so posting again needs a new fill. Reddit posts an image or a link, not both, so a link goes in a comment. flair is the id of one of the subreddit's flairs from rules; post sends it with the flair's text, as the submit form does. A subreddit that requires a flair refuses a post without one. post also returns removed, read a few seconds after posting: null for a post that is up, or the reason Reddit hides it when the subreddit's AutoModerator holds it for moderators, which the author's own page doesn't show.
//
// comment posts a comment, in Markdown, on the post the tab is showing and returns its id and url. Pass the post's URL as post too: comment checks it against the page so it can't comment on the wrong post. With parent, a comment's id (t1_...) or permalink, it replies to that comment instead, through the reply box Reddit opens under it, so run it on a page that shows that comment (its permalink does). comments with parent lists the replies to that comment instead of the post's top-level comments.
//
// Both run on a page where Reddit has its form for that action: the submit page for post, the post's own page for comment. Each form asks Google reCAPTCHA Enterprise for a token when you press its button, and these functions ask the same form's code for one rather than calling reCAPTCHA themselves. Let that page load with its tab showing: once, a Reddit page that loaded in a background tab froze until the tab was shown.
//
// How it works: post sends the CreatePost operation to /svc/shreddit/graphql and comment sends the comment form to /svc/shreddit/<post id>/create-comment, as the page does; a reply goes to the same address with the reply box's own hidden fields (parentId, commentDepth). Both carry Reddit's CSRF token, which Reddit's own scripts read from the csrf_token cookie for every request; this file does the same, inside the page, and never returns or logs it. For an image, post hands the file to the submit page's own Images field (r-post-media-input), which uploads it to Reddit's media storage as it does for a picked file, and sends the address that field returns as the post's image. These are Reddit's internal endpoints and page internals, so a Reddit update can break them. The requests follow what the web app sent in November 2026.
//
// post and comment publish immediately as you and cannot be undone from here. Agents: confirm the subreddit, the title, the link or image and the text with the user first.

// Reddit's CSRF token, which its own scripts read from this cookie for every request.
function csrfToken() {
  const value = document.cookie.split('; ').find((c) => c.startsWith('csrf_token='))?.slice('csrf_token='.length);
  if (!value) throw new Error('Reddit has set no CSRF token in this tab. Reload the page, signed in, and retry.');
  return decodeURIComponent(value);
}

// Asks a Reddit form's own code for a fresh reCAPTCHA token, which it writes into the form's hidden recaptchaToken input.
async function recaptchaToken(element, form) {
  const input = form?.querySelector('input[name="recaptchaToken"]');
  if (!input) throw new Error("Reddit's form has no reCAPTCHA field on this page. Reload the page and retry.");
  input.value = '';
  await element.getRecaptchaToken();
  if (!input.value) throw new Error("Reddit's reCAPTCHA gave no token. Reload the page and retry.");
  return input.value;
}

// A comment's full id (t1_...) from that id, a bare one or its permalink (/comment/<id>/ or /comments/<post>/<slug>/<id>/).
function commentId(value) {
  const s = String(value ?? '').trim();
  const id = /^t1_([a-z0-9]+)$/i.exec(s)?.[1] ?? /\/comment\/([a-z0-9]+)/i.exec(s)?.[1] ?? /\/comments\/[a-z0-9]+\/[^/]+\/([a-z0-9]+)/i.exec(s)?.[1] ?? /^([a-z0-9]+)$/i.exec(s)?.[1];
  if (!id) throw new Error('parent is a comment id (t1_...) or its permalink');
  return `t1_${id.toLowerCase()}`;
}

// A post's base-36 id from its URL (/comments/<id>/ or redd.it/<id>).
function postId(value) {
  const id = /(?:\/comments\/|redd\.it\/)([a-z0-9]+)/i.exec(String(value ?? ''))?.[1];
  if (!id) throw new Error('post is required: the post URL, e.g. -a post=https://www.reddit.com/r/<subreddit>/comments/<id>/');
  return id.toLowerCase();
}

const markdown = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();

const INPUT_ID = 'reddit-media';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How many items a list function returns: limit, from 1 to 50, 10 unless given.
const limitFrom = (value) => Math.min(Math.max(Math.trunc(Number(value)) || 10, 1), 50);

// A GET to Reddit's JSON API as the signed-in user. Reads need no CSRF token.
async function getJson(path) {
  const res = await fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error(`Reddit answered ${path.split('?')[0]} with HTTP ${res.status}`);
  return json;
}

const me = async () => (await getJson('/api/me.json')).data?.name ?? null;

// Flair texts come HTML-escaped in Reddit's flair list; the submit form shows and sends them unescaped.
const unescapeHtml = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

async function flairTemplates(subreddit) {
  const list = await getJson(`/r/${subreddit}/api/link_flair_v2.json`).catch(() => []);
  return (Array.isArray(list) ? list : []).map((f) => ({ id: f.id, text: unescapeHtml(f.text), editable: Boolean(f.text_editable), modOnly: Boolean(f.mod_only) }));
}

// The submit page's own Images field. It exists only on the page's Images tab.
const imageField = () => {
  const field = document.querySelector('r-post-media-input');
  return field?.addFiles && field.allowImages ? field : null;
};

// Adds the hidden file input that fill puts one image in. It lasts until the page reloads.
async function prepare() {
  if (!imageField()) throw new Error('prepare runs on the submit page\'s Images tab. Open https://www.reddit.com/r/<subreddit>/submit/?type=IMAGE in this tab first.');
  if (!document.getElementById(INPUT_ID)) {
    document.body.append(Object.assign(document.createElement('input'), { type: 'file', id: INPUT_ID, accept: 'image/jpeg,image/png,image/webp,image/gif', hidden: true }));
  }
  return { selector: `#${INPUT_ID}` };
}

// Gives the image to the submit page's Images field, which uploads it as it does a picked file, and returns the address Reddit gives it.
async function uploadImage(file) {
  const field = imageField();
  if (!field) throw new Error("An image post runs on the submit page's Images tab. Open https://www.reddit.com/r/<subreddit>/submit/?type=IMAGE in this tab first.");
  field.clear();
  await field.addFiles([file]);
  // The field refuses a file it doesn't accept without adding it, so it must appear quickly; the upload itself can take longer.
  for (let waited = 0; !field.mediaController?.media?.length; waited += 250) {
    if (waited >= 10000) throw new Error(`Reddit's Images field did not take ${file.name}. It takes JPEG, PNG, WebP and GIF images within Reddit's size limits.`);
    await sleep(250);
  }
  for (let waited = 0; field.mediaController.media[0].status !== 'success'; waited += 500) {
    if (waited >= 90000) throw new Error(`Reddit's image upload had not finished after 90 seconds (status ${field.mediaController.media[0].status}). Nothing was posted.`);
    await sleep(500);
  }
  const [uploaded] = JSON.parse(field.value);
  if (!uploaded?.url) throw new Error('Reddit uploaded the image but gave no address for it. Nothing was posted.');
  return uploaded.url;
}

async function post(ctx) {
  const button = document.querySelector('r-post-form-submit-button');
  const form = button?.form;
  const subreddit = form?.querySelector('input[name="subredditName"]')?.value;
  if (!button?.getRecaptchaToken || !subreddit) throw new Error('post runs on a subreddit submit page. Open https://www.reddit.com/r/<subreddit>/submit in this tab first.');
  const title = String(ctx.args.title ?? '').trim();
  if (!title) throw new Error('title is required');
  const url = String(ctx.args.url ?? '').trim();
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw new Error('url must be a full http(s) link');
  const file = document.getElementById(INPUT_ID)?.files?.[0];
  if (file && !file.type.startsWith('image/')) throw new Error(`An image post takes an image; this file's type is ${file.type || 'unknown'}`);
  if (file && url) throw new Error('Reddit posts an image or a link, not both. Put the link in a comment.');
  const text = markdown(ctx.args.text);
  // A flair id from rules. The submit form sends the flair's id with its text.
  const flairId = String(ctx.args.flair ?? '').trim();
  let flair;
  if (flairId) {
    flair = (await flairTemplates(subreddit)).find((f) => f.id === flairId);
    if (!flair) throw new Error(`r/${subreddit} has no flair with id ${flairId}. Run rules -a subreddit=${subreddit} for its flairs.`);
  }

  // The upload comes first: the reCAPTCHA token below is good for a short while only.
  const image = file ? await uploadImage(file) : null;
  const input = {
    isNsfw: false,
    isSpoiler: false,
    content: text ? { markdown: text } : {},
    title,
    isCommercialCommunication: false,
    targetLanguage: '',
    recaptchaToken: await recaptchaToken(button, form),
    ...(url ? { link: { url } } : {}),
    ...(image ? { image: { url: image } } : {}),
    subredditName: subreddit,
    correlationId: crypto.randomUUID(),
    ...(flair ? { flair: { id: flair.id, text: flair.text } } : {}),
  };
  const res = await fetch('/svc/shreddit/graphql', {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'CreatePost', variables: { input }, csrf_token: csrfToken() }),
  });
  const json = await res.json().catch(() => null);
  const result = json?.data?.createSubredditPost;
  if (!res.ok || json?.errors?.length || !result?.ok || !result.post?.id) {
    const problems = [...(json?.errors ?? []), ...(result?.errors ?? []), ...(result?.fieldErrors ?? [])].map((e) => e.message ?? JSON.stringify(e));
    throw new Error(`Reddit did not publish the post: ${problems.join('; ') || `HTTP ${res.status}`}`);
  }
  if (file) {
    imageField()?.clear();
    document.getElementById(INPUT_ID).value = '';
  }
  // A subreddit's AutoModerator can hold a new post for its moderators within seconds. The author's page doesn't show it, but the post's data says why it's hidden. A failed lookup leaves removed null: the post is already up, so post must not fail.
  await sleep(4000);
  const removed = await getJson(`/comments/${String(result.post.id).replace(/^t3_/, '')}.json?raw_json=1&limit=1`)
    .then((json) => json[0]?.data?.children?.[0]?.data?.removed_by_category ?? null)
    .catch(() => null);
  return { id: result.post.id, url: `https://www.reddit.com${result.post.permalink}`, subreddit, title, type: image ? 'image' : url ? 'link' : 'text', removed };
}

// What a subreddit asks of a post: the post types it takes, its posting requirements (flair, title and body rules, allowed domains), its rules and its post flairs. post takes a flair's id.
async function rules(ctx) {
  const subreddit = String(ctx.args.subreddit ?? '').replace(/^\/?r\//i, '').trim();
  if (!subreddit) throw new Error('subreddit is required, e.g. -a subreddit=rust');
  const [about, requirements, list, flairs] = await Promise.all([
    getJson(`/r/${subreddit}/about.json`),
    getJson(`/api/v1/${subreddit}/post_requirements.json`),
    getJson(`/r/${subreddit}/about/rules.json`),
    flairTemplates(subreddit),
  ]);
  return {
    subreddit: about.data?.display_name ?? subreddit,
    subscribers: about.data?.subscribers,
    // any, link (link posts only) or self (text posts only).
    postTypes: about.data?.submission_type,
    // Only the requirements the subreddit has set.
    requirements: Object.fromEntries(Object.entries(requirements).filter(([, v]) => v !== null && v !== false && v !== '' && !(Array.isArray(v) && !v.length))),
    rules: (list.rules ?? []).map((r) => ({ name: r.short_name, appliesTo: r.kind, description: r.description })),
    flairs,
  };
}

// Your latest posts, newest first.
async function recent(ctx) {
  const name = await me();
  if (!name) throw new Error('This tab is not signed in to Reddit.');
  const listing = await getJson(`/user/${name}/submitted.json?limit=${limitFrom(ctx.args.limit)}&raw_json=1`);
  return (listing.data?.children ?? []).map(({ data: p }) => ({
    id: p.name,
    url: `https://www.reddit.com${p.permalink}`,
    date: new Date(p.created_utc * 1000).toISOString(),
    subreddit: p.subreddit,
    title: p.title,
    link: p.is_self ? null : p.url,
    text: p.selftext,
    removed: p.removed_by_category ?? null,
  }));
}

// The newest top-level comments on a post, or with parent the replies to that comment, marking yours. Comments come back in Markdown, so a pasted link can read [url](url).
async function comments(ctx) {
  const id = postId(ctx.args.post);
  const parent = ctx.args.parent ? commentId(ctx.args.parent) : null;
  const path = parent
    ? `/comments/${id}/_/${parent.slice(3)}.json?raw_json=1&limit=100&depth=2&sort=new`
    : `/comments/${id}.json?raw_json=1&limit=100&depth=1&sort=new`;
  const [name, thread] = await Promise.all([me(), getJson(path)]);
  const top = thread[1]?.data?.children ?? [];
  const list = parent ? top.find((c) => c.data?.name === parent)?.data?.replies?.data?.children ?? [] : top;
  return {
    post: `t3_${id}`,
    ...(parent ? { parent } : {}),
    comments: list.filter((c) => c.kind === 't1').map(({ data: c }) => ({ id: c.name, author: c.author, mine: c.author === name, text: c.body })),
  };
}

async function comment(ctx) {
  const wanted = postId(ctx.args.post);
  const text = markdown(ctx.args.text);
  if (!text) throw new Error('text is required');
  const parent = ctx.args.parent ? commentId(ctx.args.parent) : null;
  let host = document.querySelector('comment-composer-host[post-id]:not([parent-id])');
  if (parent) {
    const target = document.querySelector(`shreddit-comment[thingid="${parent}"]`);
    if (!target) throw new Error(`This page doesn't show comment ${parent}. Open its permalink in this tab first.`);
    const replyBox = () => document.querySelector(`comment-composer-host[parent-id="${parent}"]`);
    if (!replyBox()) target.querySelector('faceplate-tracker[noun="reply_comment"] button')?.click();
    for (let i = 0; i < 40 && !replyBox()?.getForm?.(); i++) await sleep(250);
    host = replyBox();
    if (!host) throw new Error(`Reddit opened no reply box under comment ${parent}. Reload the page and retry.`);
  }
  const form = host?.getForm?.();
  if (!host?.getRecaptchaToken || !form) throw new Error(`comment runs on the post's page. Open https://www.reddit.com/comments/${wanted}/ in this tab first.`);
  const onPage = host.getAttribute('post-id');
  if (onPage !== `t3_${wanted}`) throw new Error(`This tab shows post ${onPage}, not t3_${wanted}. Open the post you want to comment on first.`);

  // The form's own hidden fields (a reply box carries parentId and commentDepth), then the comment.
  const body = new URLSearchParams();
  for (const input of form.querySelectorAll('input[type="hidden"][name]')) {
    if (input.name !== 'recaptchaToken') body.set(input.name, input.value);
  }
  body.set('recaptchaToken', await recaptchaToken(host, form));
  body.set('content', text);
  body.set('mode', 'markdown');
  body.set('csrf_token', csrfToken());
  const res = await fetch(`/svc/shreddit/${onPage}/create-comment`, {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'text/vnd.reddit.partial+html, application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const html = await res.text();
  // Reddit answers with the new comment as HTML for the page to insert.
  const created = new DOMParser().parseFromString(html, 'text/html').querySelector('shreddit-comment[thingid], shreddit-comment[thingId]');
  const id = created?.getAttribute('thingId') ?? created?.getAttribute('thingid');
  if (!res.ok || !id) throw new Error(`Reddit did not post the comment: HTTP ${res.status} ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  return { post: onPage, ...(parent ? { parent } : {}), comment: id, url: `https://www.reddit.com${created.getAttribute('permalink') ?? ''}`, text };
}
