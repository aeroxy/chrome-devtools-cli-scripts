// ==UserAdapter==
// @name         Microsoft Teams chats and channels
// @domain       teams.cloud.microsoft
// ==/UserAdapter==

// List, read and send Teams chats and channel messages in the signed-in Teams web tab, through the same chat service endpoints the web app calls.
//
//
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/teams.js chats [-a limit=20] [-a unread=true] [-a type=oneOnOne|group|meeting]
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/teams.js teams
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/teams.js read -a id=<id from chats or teams> [-a limit=20]
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/teams.js send -a id=<id from chats or teams> -a text="Hello" [-a html=true]
//
// chats lists the newest conversations first, named by their title or by the people in them. To find a chat by person or topic, list with a large limit and search the names. teams lists your teams with their channels, and a channel id works wherever a chat id does. read returns the newest messages oldest first, so it reads top to bottom, and skips system events such as members being added or calls starting. Replies and forwards show the quoted message with each line starting with >, and cards and recordings show as their type in parentheses. send posts as plain text unless html=true, and the id 48:notes is your own private notes chat.
//
// Auth: the tab caches its access tokens as plain JSON in localStorage (MSAL), so cachedToken() just reads them. They stay inside the page: never returned, logged or written to disk. Graph is only used to look up display names, because the cached Graph token has no Chat.Read scope, so chats and messages come from Teams' own undocumented chat service instead. If Teams changes those endpoints or the token cache, csa(), messagesUrl() and cachedToken() are the places to fix.
//
// `send` posts immediately as you and cannot be unsent. Agents: confirm the chat and the text with the user before running it.

// The region in the chat service URLs, as the authz call reports it in regionGtms.chatServiceAfd (teams.cloud.microsoft/api/chatsvc/<region>). Change it if requests start returning 404.
const REGION = 'apac';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const isTrue = (v) => v === true || v === 'true';
// ThreadActivity/*, Event/* and the like are system events (members added, calls started) whose content is XML, not chat text.
const isSystemEvent = (type) => !/^(Text|RichText)/.test(type);

function cachedToken(host, scope = '') {
  let best = null;
  for (const key of Object.keys(localStorage)) {
    // MSAL v2 cache keys read msal.2|<account>|<authority>|accesstoken|<clientId>|<tenant>|<scopes>|, and the credential is plain JSON.
    if (!key.includes('|accesstoken|') || !(key.split('|')[6] ?? '').toLowerCase().includes(`https://${host}/${scope}`)) continue;
    const entry = JSON.parse(localStorage.getItem(key));
    if (!best || Number(entry.expiresOn) > Number(best.expiresOn)) best = entry;
  }
  if (!best || Number(best.expiresOn) * 1000 < Date.now() + 60_000) throw new Error(`No valid ${host} token in the MSAL cache. Reload the Teams tab so it refreshes the token, then retry.`);
  return best;
}

async function api(url, token, init = {}) {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${new URL(url, location.origin).pathname.replace(/\/conversations\/[^/]+/, '/conversations/<id>')} returned HTTP ${res.status}${res.status === 401 ? ' (token rejected, reload the Teams tab and retry)' : ''}`);
  return res.json();
}

// The chat service aggregator returns every team, channel and chat in one call, with the last message of each.
const csa = () => api(`/api/csa/${REGION}/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true`, cachedToken('chatsvcagg.teams.microsoft.com').secret);
const messagesUrl = (id) => `/api/chatsvc/${REGION}/v1/users/ME/conversations/${encodeURIComponent(id)}/messages`;

// Regexes rather than DOMParser, which a Trusted Types policy on the page could refuse to parse. Entities stay encoded here so that htmlToText decodes them exactly once.
function stripTags(html) {
  return html
    // Newlines inside the HTML source are only whitespace, because line breaks are <br> and the ends of blocks. Teams writes <br> as <br>\r\n, so keeping them would double every break.
    .replace(/\r?\n/g, ' ')
    // A blockquote is a reply or a forward. Prefixing its lines with > keeps the quoted text from reading as the sender's own words, and a reply names its author in a separate <strong>, so that gets a colon.
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, quoted) => {
      const text = stripTags(quoted.replace(/(<strong[^>]*itemprop="mri"[^>]*>[^<]*)<\/strong>/i, '$1: </strong>'));
      return `\n${text.trim().split('\n').map((line) => `> ${line}`).join('\n')}\n`;
    })
    .replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, '$1')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
}

function htmlToText(html) {
  return stripTags(String(html))
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, e) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? whole;
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function messageText(type, content) {
  if (type === 'Text') return String(content ?? '').trim();
  if (type === 'RichText/Html') return htmlToText(content ?? '');
  // Cards, recordings and system events carry no chat text worth converting, so they are named instead.
  return `(${type})`;
}

function attachmentNames(raw) {
  try {
    const files = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw ?? [];
    return files.map((f) => f.fileName ?? f.title).filter(Boolean);
  } catch {
    return [];
  }
}

function limitArg(ctx, max = Infinity) {
  const n = Number(ctx.args.limit ?? 20);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(max === Infinity ? 'limit must be a positive integer' : `limit must be an integer from 1 to ${max}`);
  return n;
}

function convId(ctx) {
  if (!ctx.args.id) throw new Error('id is required, take one from `chats` or `teams`: -a id=<id>');
  return String(ctx.args.id);
}

// Chat members only carry ids (8:orgid:<object id>), so names come from Graph in batches of 20, its limit per $batch.
async function displayNames(mris) {
  const names = new Map();
  const oids = [...new Set(mris)].filter((mri) => mri.startsWith('8:orgid:')).map((mri) => mri.slice('8:orgid:'.length));
  try {
    const token = cachedToken('graph.microsoft.com', 'user.readbasic.all').secret;
    const batches = [];
    for (let i = 0; i < oids.length; i += 20) batches.push(oids.slice(i, i + 20));
    await Promise.all(batches.map(async (batch) => {
      const { responses } = await api('https://graph.microsoft.com/v1.0/$batch', token, {
        method: 'POST',
        body: JSON.stringify({ requests: batch.map((oid, n) => ({ id: String(n), method: 'GET', url: `/users/${oid}?$select=displayName` })) }),
      });
      for (const r of responses) if (r.status === 200) names.set(`8:orgid:${batch[Number(r.id)]}`, r.body.displayName);
    }));
  } catch {
    // Names are cosmetic, so a failed lookup shows 'unknown' instead of failing the whole listing.
  }
  return names;
}

async function chats(ctx) {
  const limit = limitArg(ctx);
  const type = ctx.args.type == null ? null : String(ctx.args.type);
  if (type && !['oneOnOne', 'group', 'meeting'].includes(type)) throw new Error('type must be oneOnOne, group or meeting');
  const me = `8:orgid:${cachedToken('chatsvcagg.teams.microsoft.com').homeAccountId.split('.')[0].toLowerCase()}`;
  const kind = (c) => (c.isOneOnOne ? 'oneOnOne' : c.threadType === 'meeting' ? 'meeting' : 'group');
  // A one-on-one chat id is 19:<object id>_<object id>@unq.gbl.spaces, which still names the other person after they have left and dropped out of the member list.
  const others = (c) => {
    const pair = c.id.match(/^19:([0-9a-f-]{36})_([0-9a-f-]{36})@unq\.gbl\.spaces$/i);
    return (pair ? pair.slice(1).map((oid) => `8:orgid:${oid.toLowerCase()}`) : (c.members ?? []).map((m) => m.mri)).filter((mri) => mri !== me);
  };
  const picked = (await csa()).chats
    // Empty conversations (mostly meeting chats nobody has written in) have no message to sort or show, and Teams does not list them either.
    .filter((c) => c.lastMessage && !c.isEmptyConversation)
    .filter((c) => !type || kind(c) === type)
    .filter((c) => !isTrue(ctx.args.unread) || !c.isRead)
    .sort((a, b) => String(b.lastMessage.composeTime).localeCompare(String(a.lastMessage.composeTime)))
    .slice(0, limit);
  // One-on-one chats have no title and are named after the other person, as are group chats nobody titled.
  const names = await displayNames(picked.filter((c) => !c.title).flatMap((c) => others(c).slice(0, 3)));
  const nameOf = (c) => {
    if (c.title) return c.title;
    const people = others(c);
    if (!people.length) return 'me';
    // Bots and users Graph cannot find still put their name on their own messages.
    const named = (mri) => names.get(mri) || (people.length === 1 && !c.isLastMessageFromMe && c.lastMessage.imDisplayName) || 'unknown';
    return people.slice(0, 3).map(named).join(', ') + (people.length > 3 ? ` +${people.length - 3}` : '');
  };
  return picked.map((c) => ({
    id: c.id,
    name: nameOf(c),
    type: kind(c),
    unread: !c.isRead,
    last: { from: c.isLastMessageFromMe ? 'me' : c.lastMessage.imDisplayName ?? null, time: c.lastMessage.composeTime, text: messageText(c.lastMessage.messageType, c.lastMessage.content).slice(0, 200) },
  }));
}

async function teams() {
  return (await csa()).teams
    .filter((t) => !t.isDeleted)
    .map((t) => ({
      id: t.id,
      name: t.displayName,
      channels: (t.channels ?? []).filter((c) => !c.isDeleted).map((c) => ({ id: c.id, name: c.displayName, general: c.isGeneral, unread: !c.isMessageRead })),
    }));
}

async function read(ctx) {
  const id = convId(ctx);
  const limit = limitArg(ctx, 200);
  const { messages } = await api(`${messagesUrl(id)}?startTime=1&view=msnp24Equivalent%7CsupportsMessageProperties&pageSize=${limit}`, cachedToken('ic3.teams.office.com').secret);
  return {
    id,
    messages: messages
      .filter((m) => !isSystemEvent(m.messagetype))
      // The service does not always return messages in time order (some sit hours out of sequence), and a message id is its arrival time in milliseconds.
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((m) => {
        const files = attachmentNames(m.properties?.files);
        return {
          id: m.id,
          time: m.composetime,
          from: m.imdisplayname || m.fromDisplayNameInToken || null,
          text: messageText(m.messagetype, m.content),
          ...(m.properties?.edittime ? { edited: true } : {}),
          ...(m.properties?.deletetime ? { deleted: true } : {}),
          ...(files.length ? { files } : {}),
        };
      }),
  };
}

async function send(ctx) {
  const id = convId(ctx);
  if (ctx.args.text == null || String(ctx.args.text) === '') throw new Error('text is required');
  const text = String(ctx.args.text);
  // The web app always sends HTML, so plain text is escaped into paragraphs to render the same way.
  const content = isTrue(ctx.args.html) ? text : `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>')}</p>`;
  const res = await api(messagesUrl(id), cachedToken('ic3.teams.office.com').secret, {
    method: 'POST',
    body: JSON.stringify({
      content,
      messagetype: 'RichText/Html',
      contenttype: 'text',
      amsreferences: [],
      clientmessageid: `${Date.now()}${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
      properties: { importance: '', subject: null },
    }),
  });
  // A message id is its arrival time in milliseconds.
  return { sent: true, id: String(res.OriginalArrivalTime), conversation: id };
}
