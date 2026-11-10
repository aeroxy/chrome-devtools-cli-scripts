// ==UserAdapter==
// @name         Outlook on the web mail
// @domain       outlook.cloud.microsoft
// @domain       outlook.live.com
// ==/UserAdapter==

// List, read, send, archive and remove mail in the signed-in Outlook on the web tab through the same owa/service.svc JSON API the web app uses.
//
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/outlook.js folders
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/outlook.js list [-a folder=inbox] [-a limit=20] [-a offset=0] [-a unread=true]
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/outlook.js read -a id=<id from list>
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/outlook.js draft -a to=a@example.com -a subject="Hi" -a body="Hello" [-a cc=...] [-a bcc=...] [-a html=true]
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/outlook.js send <same args as draft, with at least one recipient>
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/outlook.js archive -a id=<id from list>
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/outlook.js remove -a id=<id from list>
//
// folder is inbox, sent, drafts, deleted, junk, archive, or a folder id from `folders`. to, cc and bcc take comma or semicolon separated addresses.
//
// archive moves a message to the Archive folder, like the Archive button. remove moves it to Deleted Items, like the Delete button, so it can be restored, and nothing in this adapter deletes permanently. The command is remove rather than delete because delete is a JavaScript reserved word and the adapter runner cannot call a function with that name.
//
// Works for work or school accounts on outlook.cloud.microsoft and personal accounts on outlook.live.com. The adapter only switches the tab to outlook.cloud.microsoft when it is on neither, so open outlook.live.com yourself for a personal account.
//
// Auth: the API needs a token the tab already holds in MSAL's localStorage cache. For work accounts it is a bearer token, encrypted with a key kept in the msal.cache.encryption cookie, so authorization() decrypts it the way MSAL does. For personal accounts it is an MSA ticket stored in plaintext. The token stays inside the page: it is never returned, logged or written to disk. MSAL's cache format is internal, so if an Outlook update breaks this, authorization() is the one place to fix.
//
// `send` calls the mail API directly, so it skips what the web app's compose window does client-side (sensitivity label, SafeGuard Send add-in). Use `draft` and press Send in Outlook when those matter. Agents: confirm recipients and body with the user before running `send`, it cannot be undone.

const FOLDERS = { inbox: 'inbox', sent: 'sentitems', sentitems: 'sentitems', drafts: 'drafts', deleted: 'deleteditems', deleteditems: 'deleteditems', junk: 'junkemail', junkemail: 'junkemail', archive: 'archive' };

const P = (field) => ({ __type: 'PropertyUri:#Exchange', FieldURI: field });
const isTrue = (v) => v === true || v === 'true';
const addr = (m) => (m ? (m.Name && m.Name !== m.EmailAddress ? `${m.Name} <${m.EmailAddress}>` : m.EmailAddress) : null);
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

async function authorization() {
  // Work or school accounts call the API with an AAD bearer token whose scopes live under outlook.office.com. Personal accounts (outlook.live.com) call it with an MSA ticket for service::outlook.office.com::mbi_ssl, sent as MSAuth1.0.
  const personal = location.hostname === 'outlook.live.com';
  const scope = personal ? 'service::outlook.office.com::mbi_ssl' : 'https://outlook.office.com/';
  const prefix = 'msal.cache.encryption=';
  const cookie = document.cookie.split('; ').find((c) => c.startsWith(prefix));
  if (!cookie) throw new Error('MSAL cache key cookie not found. Is this tab signed in to Outlook?');
  const baseKey = await crypto.subtle.importKey('raw', b64u(JSON.parse(decodeURIComponent(cookie.slice(prefix.length))).key), 'HKDF', false, ['deriveKey']);
  let best = null;
  for (const key of Object.keys(localStorage)) {
    // Cache keys read msal.3|<account>|<authority>|accesstoken|<clientId>|<tenant>|<scopes>|...
    if (!key.includes('|accesstoken|') || !key.includes(scope)) continue;
    try {
      const entry = JSON.parse(localStorage.getItem(key));
      let credential = entry;
      // Work accounts keep the cache encrypted as { nonce, data }; personal accounts keep it in plaintext.
      if (entry.data) {
        const aesKey = await crypto.subtle.deriveKey({ name: 'HKDF', salt: b64u(entry.nonce), hash: 'SHA-256', info: new TextEncoder().encode(key.split('|')[4]) }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
        credential = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, aesKey, b64u(entry.data))));
      }
      if (!best || Number(credential.expiresOn) > Number(best.expiresOn)) best = credential;
    } catch {
      // An entry we cannot decrypt (stale key, other format) is not worth failing the whole call for.
    }
  }
  if (!best || Number(best.expiresOn) * 1000 < Date.now() + 60_000) throw new Error('No valid Outlook access token in the MSAL cache. Reload the Outlook tab so it refreshes the token, then retry.');
  return personal ? `MSAuth1.0 usertoken="${best.secret}", type="MSACT"` : `Bearer ${best.secret}`;
}

async function owa(action, body) {
  const res = await fetch(`/owa/service.svc?action=${action}&app=Mail`, {
    method: 'POST',
    headers: {
      authorization: await authorization(),
      action,
      'content-type': 'application/json; charset=utf-8',
      // Immutable ids survive a move between folders, so an id from `list` stays valid for `read`.
      prefer: 'IdType="ImmutableId"',
    },
    body: JSON.stringify({
      __type: `${action}JsonRequest:#Exchange`,
      Header: { __type: 'JsonRequestHeaders:#Exchange', RequestServerVersion: 'V2018_01_08' },
      Body: { __type: `${action}Request:#Exchange`, ...body },
    }),
  });
  if (!res.ok) throw new Error(`${action} returned HTTP ${res.status}${res.status === 401 ? ' (token rejected, reload the Outlook tab and retry)' : ''}`);
  const messages = (await res.json())?.Body?.ResponseMessages?.Items;
  if (!messages) throw new Error(`Unexpected ${action} response`);
  const failed = messages.find((m) => m.ResponseClass !== 'Success');
  if (failed) throw new Error(`${action} failed: ${failed.ResponseCode}: ${failed.MessageText}`);
  return messages;
}

function folderId(name) {
  // Well-known names resolve server-side; anything else is taken as a folder id from `folders`.
  const known = FOLDERS[name];
  return known ? { __type: 'DistinguishedFolderId:#Exchange', Id: known } : { __type: 'FolderId:#Exchange', Id: name };
}

async function folders() {
  const [msg] = await owa('FindFolder', {
    FolderShape: { __type: 'FolderResponseShape:#Exchange', BaseShape: 'IdOnly', AdditionalProperties: ['DistinguishedFolderId', 'FolderClass', 'FolderDisplayName', 'TotalCount', 'UnreadCount'].map(P) },
    Paging: { __type: 'IndexedPageView:#Exchange', BasePoint: 'Beginning', Offset: 0, MaxEntriesReturned: 1000 },
    ParentFolderIds: [{ __type: 'DistinguishedFolderId:#Exchange', Id: 'msgfolderroot' }],
    Traversal: 'Deep',
  });
  // The root also holds calendar, contacts, tasks and similar folders; only mail folders matter here.
  return msg.RootFolder.Folders
    .filter((f) => !f.FolderClass || f.FolderClass.startsWith('IPF.Note'))
    .map((f) => ({ id: f.FolderId.Id, name: f.DisplayName, wellKnown: f.DistinguishedFolderId, total: f.TotalCount, unread: f.UnreadCount }));
}

async function list(ctx) {
  const folder = String(ctx.args.folder ?? 'inbox');
  const limit = Number(ctx.args.limit ?? 20);
  const offset = Number(ctx.args.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) throw new Error('limit must be a positive integer and offset a non-negative integer');
  const [msg] = await owa('FindItem', {
    ParentFolderIds: [folderId(folder)],
    ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'IdOnly', AdditionalProperties: ['Subject', 'From', 'DateTimeReceived', 'IsRead', 'HasAttachments', 'Preview'].map(P) },
    Traversal: 'Shallow',
    Paging: { __type: 'IndexedPageView:#Exchange', BasePoint: 'Beginning', Offset: offset, MaxEntriesReturned: limit },
    ViewFilter: isTrue(ctx.args.unread) ? 'Unread' : 'All',
    FocusedViewFilter: -1,
    SortOrder: [{ __type: 'SortResults:#Exchange', Order: 'Descending', Path: P('DateTimeReceived') }],
  });
  const root = msg.RootFolder;
  return {
    folder,
    total: root.TotalItemsInView,
    offset,
    items: root.Items.map((i) => ({ id: i.ItemId.Id, received: i.DateTimeReceived, from: addr(i.From?.Mailbox), subject: i.Subject, unread: !i.IsRead, attachments: i.HasAttachments, preview: i.Preview })),
  };
}

function itemId(ctx) {
  if (!ctx.args.id) throw new Error('id is required, take one from `list`: -a id=<id>');
  return { __type: 'ItemId:#Exchange', Id: String(ctx.args.id) };
}

async function read(ctx) {
  const [msg] = await owa('GetItem', {
    // BodyType Text makes the server flatten HTML mail, which is what a terminal or an agent wants.
    ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'IdOnly', BodyType: 'Text', AdditionalProperties: ['Subject', 'From', 'ToRecipients', 'CcRecipients', 'DateTimeReceived', 'Importance', 'Attachments', 'Body'].map(P) },
    ItemIds: [itemId(ctx)],
  });
  const m = msg.Items[0];
  return {
    id: m.ItemId.Id,
    received: m.DateTimeReceived,
    from: addr(m.From?.Mailbox),
    to: (m.ToRecipients ?? []).map(addr),
    cc: (m.CcRecipients ?? []).map(addr),
    subject: m.Subject,
    importance: m.Importance,
    attachments: (m.Attachments ?? []).map((a) => ({ name: a.Name, type: a.ContentType, size: a.Size, inline: Boolean(a.IsInline) })),
    body: m.Body?.Value,
  };
}

function recipients(value) {
  return String(value ?? '')
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((email) => {
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error(`Not an email address: ${email}`);
      return { EmailAddress: email, RoutingType: 'SMTP', MailboxType: 'Mailbox' };
    });
}

async function compose(ctx, disposition) {
  const { subject, body } = ctx.args;
  if (subject == null || body == null) throw new Error('subject and body are required');
  const to = recipients(ctx.args.to);
  const cc = recipients(ctx.args.cc);
  const bcc = recipients(ctx.args.bcc);
  // Validate before any network call so a bad send never leaves the page half-built.
  if (disposition === 'SendAndSaveCopy' && to.length + cc.length + bcc.length === 0) throw new Error('send needs at least one recipient in to, cc or bcc');
  const [msg] = await owa('CreateItem', {
    MessageDisposition: disposition,
    Items: [{
      __type: 'Message:#Exchange',
      Subject: String(subject),
      Body: { __type: 'BodyContentType:#Exchange', BodyType: isTrue(ctx.args.html) ? 'HTML' : 'Text', Value: String(body) },
      ToRecipients: to,
      CcRecipients: cc,
      BccRecipients: bcc,
    }],
  });
  const emails = (rs) => rs.map((r) => r.EmailAddress);
  return disposition === 'SaveOnly'
    ? { draft: msg.Items[0].ItemId.Id, to: emails(to), cc: emails(cc), bcc: emails(bcc), subject: String(subject) }
    : { sent: true, to: emails(to), cc: emails(cc), bcc: emails(bcc), subject: String(subject) };
}

async function draft(ctx) {
  return compose(ctx, 'SaveOnly');
}

async function send(ctx) {
  return compose(ctx, 'SendAndSaveCopy');
}

async function archive(ctx) {
  const item = itemId(ctx);
  const [msg] = await owa('MoveItem', {
    ItemIds: [item],
    ToFolderId: { __type: 'TargetFolderId:#Exchange', BaseFolderId: { __type: 'DistinguishedFolderId:#Exchange', Id: 'archive' } },
  });
  return { id: msg.Items?.[0]?.ItemId?.Id ?? item.Id, movedTo: 'archive' };
}

async function remove(ctx) {
  const item = itemId(ctx);
  // MoveToDeletedItems is what the Delete button does, and it keeps the message recoverable.
  await owa('DeleteItem', { ItemIds: [item], DeleteType: 'MoveToDeletedItems' });
  return { id: item.Id, movedTo: 'deleteditems' };
}
