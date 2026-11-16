// ==UserAdapter==
// @name         Reddit posts and comments
// @domain       www.reddit.com
// ==/UserAdapter==

// Post a text or link post to a subreddit and comment on posts as you, through the endpoints Reddit's own web app uses, in a signed-in tab.
//
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/reddit.js rules -a subreddit=<name>
//   chrome-devtools --target <name> navigate https://www.reddit.com/r/<subreddit>/submit
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/reddit.js post -a title="..." [-a url="https://..."] [-a text="..."] [-a flair=<id from rules>]
//   chrome-devtools --target <name> navigate <url from post>
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/reddit.js comment -a post=<url from post> -a text="..."
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/reddit.js recent [-a limit=10]
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/reddit.js comments -a post=<url>
//
// rules, recent and comments only read, on any www.reddit.com page. rules shows what a subreddit asks of a post: the post types it takes (postTypes: any, link or self), the posting requirements it has set (requirements, such as is_flair_required, body_restriction_policy, title_blacklisted_strings or domain_whitelist), its rules and its post flairs with their ids. recent lists your latest posts, newest first, with id, url, date, subreddit, title, link and text. comments lists the newest top-level comments on a post, marking yours with mine; they come back in Markdown, so a pasted link can read [url](url).
//
// post publishes to the subreddit whose submit page the tab is on and returns the post's id and url. With url it's a link post; without, a text post. text is the body, in Markdown, and is optional for both, unless the subreddit requires one. flair is the id of one of the subreddit's flairs from rules; post sends it with the flair's text, as the submit form does. A subreddit that requires a flair refuses a post without one.
//
// comment posts a comment, in Markdown, on the post the tab is showing and returns its id and url. Pass the post's URL as post too: comment checks it against the page so it can't comment on the wrong post.
//
// Both run on a page where Reddit has its form for that action: the submit page for post, the post's own page for comment. Each form asks Google reCAPTCHA Enterprise for a token when you press its button, and these functions ask the same form's code for one rather than calling reCAPTCHA themselves. Let that page load with its tab showing: once, a Reddit page that loaded in a background tab froze until the tab was shown.
//
// How it works: post sends the CreatePost operation to /svc/shreddit/graphql and comment sends the comment form to /svc/shreddit/<post id>/create-comment, as the page does. Both carry Reddit's CSRF token, which Reddit's own scripts read from the csrf_token cookie for every request; this file does the same, inside the page, and never returns or logs it. These are Reddit's internal endpoints and page internals, so a Reddit update can break them. The requests follow what the web app sent in November 2026.
//
// post and comment publish immediately as you and cannot be undone from here. Agents: confirm the subreddit, the title, the link and the text with the user first.

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

// A post's base-36 id from its URL (/comments/<id>/ or redd.it/<id>).
function postId(value) {
  const id = /(?:\/comments\/|redd\.it\/)([a-z0-9]+)/i.exec(String(value ?? ''))?.[1];
  if (!id) throw new Error('post is required: the post URL, e.g. -a post=https://www.reddit.com/r/<subreddit>/comments/<id>/');
  return id.toLowerCase();
}

const markdown = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();

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

async function post(ctx) {
  const button = document.querySelector('r-post-form-submit-button');
  const form = button?.form;
  const subreddit = form?.querySelector('input[name="subredditName"]')?.value;
  if (!button?.getRecaptchaToken || !subreddit) throw new Error('post runs on a subreddit submit page. Open https://www.reddit.com/r/<subreddit>/submit in this tab first.');
  const title = String(ctx.args.title ?? '').trim();
  if (!title) throw new Error('title is required');
  const url = String(ctx.args.url ?? '').trim();
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw new Error('url must be a full http(s) link');
  const text = markdown(ctx.args.text);
  // A flair id from rules. The submit form sends the flair's id with its text.
  const flairId = String(ctx.args.flair ?? '').trim();
  let flair;
  if (flairId) {
    flair = (await flairTemplates(subreddit)).find((f) => f.id === flairId);
    if (!flair) throw new Error(`r/${subreddit} has no flair with id ${flairId}. Run rules -a subreddit=${subreddit} for its flairs.`);
  }

  const input = {
    isNsfw: false,
    isSpoiler: false,
    content: text ? { markdown: text } : {},
    title,
    isCommercialCommunication: false,
    targetLanguage: '',
    recaptchaToken: await recaptchaToken(button, form),
    ...(url ? { link: { url } } : {}),
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
  return { id: result.post.id, url: `https://www.reddit.com${result.post.permalink}`, subreddit, title, type: url ? 'link' : 'text' };
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
  }));
}

// The newest top-level comments on a post, marking yours. Comments come back in Markdown, so a pasted link can read [url](url).
async function comments(ctx) {
  const id = postId(ctx.args.post);
  const [name, thread] = await Promise.all([me(), getJson(`/comments/${id}.json?raw_json=1&limit=100&depth=1&sort=new`)]);
  return {
    post: `t3_${id}`,
    comments: (thread[1]?.data?.children ?? []).filter((c) => c.kind === 't1').map(({ data: c }) => ({ id: c.name, author: c.author, mine: c.author === name, text: c.body })),
  };
}

async function comment(ctx) {
  const wanted = postId(ctx.args.post);
  const text = markdown(ctx.args.text);
  if (!text) throw new Error('text is required');
  const host = document.querySelector('comment-composer-host[post-id]');
  const form = host?.getForm?.();
  if (!host?.getRecaptchaToken || !form) throw new Error(`comment runs on the post's page. Open https://www.reddit.com/comments/${wanted}/ in this tab first.`);
  const onPage = host.getAttribute('post-id');
  if (onPage !== `t3_${wanted}`) throw new Error(`This tab shows post ${onPage}, not t3_${wanted}. Open the post you want to comment on first.`);

  const body = new URLSearchParams({ recaptchaToken: await recaptchaToken(host, form), content: text, mode: 'markdown', csrf_token: csrfToken() });
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
  return { post: onPage, comment: id, url: `https://www.reddit.com${created.getAttribute('permalink') ?? ''}`, text };
}
