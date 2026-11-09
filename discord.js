// ==UserAdapter==
// @name         Discord (read-only)
// @domain       discord.com
// ==/UserAdapter==

// Read-only helpers for the Discord web app, run in the tab you already have open.
//
//   chrome-devtools --target <name> adapter discord.js channels
//   chrome-devtools --target <name> adapter discord.js messages
//   chrome-devtools --target <name> adapter discord.js history -a limit=300 -a since=2026-11-01
//   chrome-devtools --target <name> adapter discord.js jump_to_present
//
// Add `--output file.json` before any `-a` to write the result to a file.
//
// These scripts only read the page. They never touch your token, cookies or
// storage, and they never send, edit or delete anything.
//
// Discord keeps only ~60 messages in the DOM and loads older ones as you scroll,
// but only while the tab is in front. Run `select-page` for the target first.

const MSG = 'li[id^="chat-messages-"]';

const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

function byId(a, b) {
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
}

function readMessages() {
  const out = [];
  let lastAuthor = null;
  for (const li of document.querySelectorAll(MSG)) {
    const m = /^chat-messages-(?:(\d+)-)?(\d+)$/.exec(li.id);
    if (!m) continue;
    // Consecutive messages from one author carry the name only on the first.
    const name = li.querySelector('h3 [class*="username"]');
    if (name) lastAuthor = name.textContent.trim();
    // A reply's preview holds its own message-content element, so take this message's by id.
    const body =
      li.querySelector(`[id="message-content-${m[2]}"]`) ||
      [...li.querySelectorAll('[id^="message-content-"]')].find((e) => !e.closest('[class*="repliedMessage"]')) ||
      null;
    const time = li.querySelector('time');
    const reply = li.querySelector('[class*="repliedTextContent"]');
    const links = body
      ? [...new Set([...body.querySelectorAll('a[href^="http"]')].map((a) => a.href))]
      : [];
    out.push({
      id: m[2],
      channelId: m[1] || null,
      author: lastAuthor,
      ts: time ? time.getAttribute('datetime') : null,
      content: body ? body.innerText.trim() : '',
      links,
      replyTo: reply ? reply.innerText.trim().slice(0, 140) : null,
      attachments: li.querySelectorAll('[class*="messageAttachment"], [class*="imageWrapper"]').length,
    });
  }
  return out;
}

function findScroller() {
  const list =
    document.querySelector('ol[data-list-id="chat-messages"]') ||
    (document.querySelector(MSG) && document.querySelector(MSG).closest('ol'));
  for (let el = list; el && el !== document.body; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

function jumpButton() {
  return [...document.querySelectorAll('button, [role="button"]')].find((b) =>
    /jump to present/i.test(b.textContent || '')
  );
}

function atPresent(scroller) {
  return !jumpButton() && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
}

async function goToPresent(ctx, scroller) {
  const btn = jumpButton();
  if (btn) btn.click();
  await ctx.wait(500);
  const s = scroller || findScroller();
  if (s) s.scrollTop = s.scrollHeight;
  await ctx.wait(300);
}

function reachedStart(scroller) {
  return /welcome to #|this is the start of the #/i.test(scroller.innerText.slice(0, 2000));
}

// The channels listed in the sidebar of the current server.
async function channels(ctx) {
  const guild = location.pathname.split('/')[2];
  if (!guild || guild === '@me') throw new Error('Open a server channel first; direct messages have no channel list.');
  const rows = [...document.querySelectorAll('[data-list-item-id^="channels___"]')].map((e) => {
    const label = e.getAttribute('aria-label') || '';
    const id = e.getAttribute('data-list-item-id').replace('channels___', '');
    return {
      id,
      name: label.replace(/^unread, /, '').split(' (')[0],
      type: (/\(([^)]*channel[^)]*)\)/.exec(label) || [])[1] || 'category',
      unread: /^unread, /.test(label),
      url: `https://discord.com/channels/${guild}/${id}`,
    };
  });
  return { guild, count: rows.length, channels: rows };
}

// The messages currently loaded in the open channel, no scrolling.
async function messages(ctx) {
  const rows = readMessages();
  return { channel: document.title, url: location.href, count: rows.length, messages: rows };
}

// Scroll up through the open channel and collect older messages, then return to
// the present. Stops at `limit` messages, `since` (ISO date), `max_rounds`, or
// when nothing new loads. `reason` says which, so you can tell a complete pull
// ("start_of_channel") from one that merely stopped ("stalled", "limit", ...).
async function history(ctx) {
  const a = ctx.args || {};
  const limit = num(a.limit, 500);
  const maxRounds = num(a.max_rounds, 150);
  const settle = num(a.settle_ms, 700);
  const stallLimit = num(a.stall_rounds, 4);
  const since = a.since ? Date.parse(a.since) : null;
  if (a.since && Number.isNaN(since)) throw new Error('since must be an ISO date, e.g. 2026-11-01');

  if (document.visibilityState !== 'visible') {
    throw new Error('This tab is in the background, so Discord will not load older messages. Run select-page for this target first.');
  }
  const scroller = findScroller();
  if (!scroller) throw new Error('No message list found. Open a text channel first.');
  if (String(a.force) !== 'true' && !atPresent(scroller)) {
    throw new Error('This tab is scrolled up in the channel, and running would move you. Jump to the present first, or pass -a force=true.');
  }

  const seen = new Map();
  const merge = () => {
    let added = 0;
    for (const m of readMessages()) {
      const prev = seen.get(m.id);
      if (!prev) {
        seen.set(m.id, m);
        added++;
      } else if (!prev.author && m.author) {
        prev.author = m.author;
      }
    }
    return added;
  };
  const oldestMs = () => Math.min(...[...seen.values()].filter((m) => m.ts).map((m) => Date.parse(m.ts)));

  let reason = 'max_rounds';
  let rounds = 0;
  let stalls = 0;
  try {
    merge();
    while (rounds < maxRounds) {
      if (seen.size >= limit) { reason = 'limit'; break; }
      if (since !== null && oldestMs() < since) { reason = 'since'; break; }
      rounds++;
      scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.floor(scroller.clientHeight * 0.9));
      await ctx.wait(settle);
      const added = merge();
      if (added > 0) { stalls = 0; continue; }
      // Nothing new is only a stall once we are at the top of what is loaded.
      if (scroller.scrollTop > 80) continue;
      stalls++;
      if (stalls >= stallLimit) { reason = reachedStart(scroller) ? 'start_of_channel' : 'stalled'; break; }
      await ctx.wait(settle);
    }
  } finally {
    await goToPresent(ctx, scroller);
  }

  const rows = [...seen.values()].sort(byId);
  // Fill in authors for continuation messages from the message before them.
  for (let i = 1; i < rows.length; i++) if (!rows[i].author) rows[i].author = rows[i - 1].author;
  const cut = since !== null ? rows.filter((m) => !m.ts || Date.parse(m.ts) >= since) : rows;
  return {
    channel: document.title,
    url: location.href,
    reason,
    rounds,
    count: cut.length,
    oldest: cut.length ? cut[0].ts : null,
    newest: cut.length ? cut[cut.length - 1].ts : null,
    messages: cut,
  };
}

// Bring the open channel back to the newest message.
async function jump_to_present(ctx) {
  await goToPresent(ctx);
  const scroller = findScroller();
  return { atPresent: scroller ? atPresent(scroller) : null };
}
