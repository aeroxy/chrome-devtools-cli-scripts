// ==UserAdapter==
// @name         RedNote video notes and comments
// @domain       creator.xiaohongshu.com
// @domain       www.xiaohongshu.com
// ==/UserAdapter==

// Post a video note and comment on notes as you on RedNote (Xiaohongshu, 小红书), through the web API its own pages use, in a signed-in tab.
//
//   chrome-devtools --target <name> select-page
//   chrome-devtools --target <name> navigate https://creator.xiaohongshu.com/publish/publish
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/rednote.js prepare
//   chrome-devtools --target <name> fill '#rednote-video' clip.mp4
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/rednote.js post -a title="..." -a description="..." [-a hashtags="AI工具, 大模型"] [-a visibility=everyone|friends|only_me]
//   chrome-devtools --target <name> navigate https://www.xiaohongshu.com/explore
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/rednote.js comment -a note=<url from post> -a text="..."
//   chrome-devtools --target <name> navigate https://creator.xiaohongshu.com/new/note-manager
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/rednote.js recent [-a limit=10]
//   chrome-devtools --target <name> navigate https://www.xiaohongshu.com/explore
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/rednote.js comments -a note=<url from post or recent>
//
// recent and comments only read. recent runs on the creator site and lists your latest notes, newest first, up to 10 (the note manager's first page), with id, a url that opens the note, date and title; the note manager gives titles, not the notes' text. comments runs on www.xiaohongshu.com and lists the first comments on a note, marking yours with mine. RedNote wants the xsec_token in the note's link for that, so pass a url from post or recent.
//
// prepare adds a hidden file input for fill to put the video in. The publish page's own input would start the page's uploader instead.
//
// post uploads that video, publishes it as a video note, returns its id and a url that opens it, and empties the input, so posting again needs a new fill. title is optional and at most 20 characters, counted as the publish page counts them: a Chinese character as one, two ASCII characters as one. The note's text is description, a blank line, then the hashtags (separated by spaces or commas, with or without #). A hashtag links only to an existing RedNote topic, so post looks each one up first and stops before uploading anything if one isn't a topic, naming the closest topics. Names match exactly first, then ignoring case. A # typed inside description stays plain text. visibility is everyone unless given; friends means mutual follows only. Comments and copying the note's text are allowed, the publish page's defaults. The cover is the video's first frame.
//
// comment posts a comment on a note and returns its id. Pass the note's URL or its 24-character id.
//
// prepare and post run on the publish page, whose video tools post uses; comment runs on www.xiaohongshu.com. Let the publish page load with its tab showing: twice, one that loaded in a hidden tab froze until shown, holding up every chrome-devtools command. Once it has loaded, post works with the tab in the background.
//
// How it works: the page's own HTTP client signs every call (X-s, X-t, X-S-Common, and x-rap-param on the calls RedNote checks most), so this file never computes those or touches cookies. post reads the video's metadata and first frame with the publish page's own tools, uploads the video and the frame to RedNote's storage with the one-file upload permits RedNote hands out, waits until RedNote has started processing the video, and publishes with /web_api/sns/v2/note. These are RedNote's undocumented endpoints and page internals, so a RedNote update can break them. The requests follow what the publish page sent in November 2026.
//
// post and comment publish immediately as you and cannot be undone from here. Agents: confirm the video, the title, the text and the visibility with the user first.

const INPUT_ID = 'rednote-video';
const CREATOR = 'https://creator.xiaohongshu.com';
const EDITH = 'https://edith.xiaohongshu.com';
// The publish page's codes for who can see a note. 2 and 3 are its "hide from" and "only show to" lists, which need user ids.
const VISIBILITY = { everyone: 0, only_me: 1, friends: 4 };
// Upload part size. The publish page varies it with connection speed; storage takes anything from 1 MB.
const PART_BYTES = 5 * 1024 * 1024;

let client;

// The page's own HTTP client. Its interceptors sign each call, so requests made through it look like the page's own. The page doesn't put it on window, so it is found among the page's webpack modules by an error message only that module contains.
function http() {
  if (client) return client;
  const chunks = window[Object.keys(window).find((k) => k.startsWith('webpackChunk'))];
  let load;
  chunks?.push([[Symbol('rednote')], {}, (r) => { load = r; }]);
  const id = load && Object.keys(load.m).find((k) => String(load.m[k]).includes('[Http Exception] apiKey is empty'));
  const found = id && load(id);
  // Without its signing interceptors the client would send unsigned calls, which RedNote rejects.
  if (!found?.post || !found.interceptors?.spam?.queue?.length) {
    throw new Error("Could not find RedNote's HTTP client in this page. Reload the tab and retry. If that doesn't help, RedNote has changed its pages and this adapter needs updating.");
  }
  client = found;
  return client;
}

// Calls RedNote's web API and returns the whole JSON body. The client throws when the body says success: false (HTTPBizError, with RedNote's message and code) or the request fails.
async function call(method, url, payload) {
  const options = { extractData: false, withCredentials: true, timeout: 30000 };
  let body;
  try {
    body = method === 'GET' ? await http().get(url, { ...options, params: payload }) : await http().post(url, payload, options);
  } catch (error) {
    throw new Error(`${method} ${new URL(url).pathname} failed: ${error.message}${error.code === undefined ? '' : ` (code ${error.code})`}`);
  }
  if (!body || typeof body !== 'object') throw new Error(`${method} ${new URL(url).pathname} returned no JSON`);
  return body;
}

// The publish page's video tools, which it puts on window as _publisher: MediaInfo for the metadata RedNote takes with a video, and ffmpeg for the first frame. Other creator pages have _publisher too, but only the publish page starts its ffmpeg.
function videoTools() {
  const media = window._publisher?.media;
  if (location.hostname !== 'creator.xiaohongshu.com' || !location.pathname.startsWith('/publish') || !media?.getFirstFrame) {
    throw new Error('This needs the RedNote publish page. Open https://creator.xiaohongshu.com/publish/publish in this tab first.');
  }
  return media;
}

const utf8 = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const sha1 = async (text) => hex(await crypto.subtle.digest('SHA-1', utf8.encode(text)));
const cosEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
// key=value pairs sorted by key, keys lowercased, as Tencent COS signs query parameters and headers.
const cosPairs = (o) => Object.keys(o).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)).map((k) => `${cosEncode(k).toLowerCase()}=${cosEncode(String(o[k]))}`).join('&');
const cosList = (o) => Object.keys(o).map((k) => k.toLowerCase()).sort().join(';');

async function hmacSha1(key, text) {
  const k = await crypto.subtle.importKey('raw', utf8.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, utf8.encode(text)));
}

// A request to RedNote's file storage, which speaks the Tencent COS API. The upload permit carries only a token, so the request is signed the way the publish page's COS SDK signs it then, with "null" as the key id and the secret. signed holds the headers the signature covers besides host; the browser sets host and content-length itself.
async function storage(permit, method, key, { query = {}, signed = {}, unsigned = {}, body = null }) {
  const keyTime = `${Math.floor((permit.startTime || Date.now()) / 1000)};${Math.floor(permit.expireTime / 1000)}`;
  const headers = { ...signed, host: permit.uploadAddr };
  const text = [method.toLowerCase(), `/${key}`, cosPairs(query), cosPairs(headers), ''].join('\n');
  const signature = await hmacSha1(await hmacSha1('null', keyTime), ['sha1', keyTime, await sha1(text), ''].join('\n'));
  const search = Object.entries(query).map(([k, v]) => (v === '' ? k : `${k}=${cosEncode(String(v))}`)).join('&');
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `https://${permit.uploadAddr}/${key}${search ? `?${search}` : ''}`);
    xhr.setRequestHeader('Authorization', `q-sign-algorithm=sha1&q-ak=null&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${cosList(headers)}&q-url-param-list=${cosList(query)}&q-signature=${signature}`);
    xhr.setRequestHeader('x-cos-security-token', permit.token);
    for (const [k, v] of Object.entries({ ...signed, ...unsigned })) if (k.toLowerCase() !== 'content-length') xhr.setRequestHeader(k, v);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr) : reject(new Error(`RedNote storage refused ${method} ${key}: HTTP ${xhr.status} ${xhr.responseText.slice(0, 200)}`)));
    xhr.onerror = () => reject(new Error(`${method} to RedNote storage failed before reaching it`));
    xhr.send(body);
  });
}

// Somewhere to upload one file. RedNote answers with permits on two upload hosts, and the publish page uses the one with the higher qos.
async function permit(scene) {
  const body = await call('GET', `${CREATOR}/api/media/v1/upload/creator/permit`, { biz_name: 'spectrum', scene, file_count: 1, version: 1, source: 'web' });
  const [best] = (body.data?.uploadTempPermits ?? []).sort((a, b) => b.qos - a.qos);
  if (!best?.fileIds?.[0] || !best.token) throw new Error(`RedNote gave no upload permit for the ${scene}`);
  return best;
}

// Uploads the video in parts, as the publish page does: start, one PUT per part, then the parts' ETags to finish. Finishing answers with the id RedNote processes the video under.
async function uploadVideo(file) {
  const p = await permit('video');
  const key = p.fileIds[0];
  const started = await storage(p, 'POST', key, { query: { uploads: '' }, unsigned: { 'Content-Type': file.type || 'video/mp4' } });
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(started.responseText)?.[1];
  if (!uploadId) throw new Error('RedNote storage did not start the upload');
  const parts = [];
  for (let start = 0; start < file.size; start += PART_BYTES) {
    const part = file.slice(start, start + PART_BYTES);
    const number = parts.length + 1;
    const sent = await storage(p, 'PUT', key, { query: { partNumber: number, uploadId }, signed: { 'content-length': part.size }, body: part });
    parts.push(`<Part><PartNumber>${number}</PartNumber><ETag>${sent.getResponseHeader('ETag').replace(/"/g, '&quot;')}</ETag></Part>`);
  }
  const done = await storage(p, 'POST', key, { query: { uploadId }, unsigned: { 'Content-Type': 'application/xml' }, body: `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>` });
  const videoId = done.getResponseHeader('X-Ros-Video-Id');
  if (!videoId) throw new Error('RedNote storage took the video but returned no video id');
  return { fileId: key, videoId };
}

// Uploads the cover image in one PUT and returns its file id with the size the PNG header gives.
async function uploadCover(png) {
  const p = await permit('image');
  await storage(p, 'PUT', p.fileIds[0], { signed: { 'content-length': png.length }, body: png });
  const size = new DataView(png.buffer, png.byteOffset, png.length);
  return { id: p.fileIds[0], width: size.getUint32(16), height: size.getUint32(20) };
}

// The publish page won't publish until RedNote reports the video's first frame, its sign that processing has started. It asks every 3 seconds, up to 100 times.
async function processed(videoId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const body = await call('GET', `${EDITH}/web_api/sns/capa/postgw/query_transcode`, { video_id: videoId, need_transcode: false, resource_type: 0 });
    if (body.data?.has_first_frame) return;
    await new Promise((resolve) => setTimeout(resolve, body.data?.query_interval_ms || 3000));
  }
  throw new Error('RedNote had not started processing the video after 100 checks. Nothing was published; try post again.');
}

// The video's metadata from the publish page's MediaInfo, in the shape the page sends. JSON leaves out fields MediaInfo didn't find, as it does for the page.
async function metadata(media, file) {
  const info = await media.queryVideoInfo(file);
  const v = media.queryVideoTrack(info);
  const a = media.queryAudioTrack(info);
  if (!v) throw new Error('RedNote cannot read a video stream in this file');
  if (Number(v.Duration) > 4 * 3600) throw new Error('RedNote takes videos up to 4 hours long');
  const video = { bitrate: +v.BitRate, colour_primaries: v.colour_primaries, duration: 1e3 * v.Duration, format: v.Format, frame_rate: +v.FrameRate, height: +v.Height, matrix_coefficients: v.matrix_coefficients, rotation: +v.Rotation, transfer_characteristics: v.transfer_characteristics, width: +v.Width };
  const audio = a ? { bitrate: +a.BitRate, channels: +a.Channels, duration: 1e3 * a.Duration, format: a.Format, sampling_rate: +a.SamplingRate } : {};
  return { video, audio, width: Number(v.Width), height: Number(v.Height), duration: Number(v.Duration) };
}

// The publish page's title length: characters past ASCII (and ^) count as 2, the rest as 1, halved and rounded up.
function titleLength(title) {
  let units = 0;
  for (let i = 0; i < title.length; i++) units += title.charCodeAt(i) > 127 || title[i] === '^' ? 2 : 1;
  return Math.ceil(units / 2);
}

// The description as the publish page's editor writes it: a blank line becomes a line holding one tab, and the editor allows no two blank lines in a row.
function noteText(value) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  const lines = text.split('\n').map((line) => (line.trim() ? line : '\t'));
  return lines.filter((line, i) => !(line === '\t' && lines[i - 1] === '\t')).join('\n');
}

function hashtagNames(value) {
  return [...new Set(String(value ?? '').split(/[\s,，、#]+/).filter(Boolean))];
}

// Looks each hashtag up with the publish page's topic search and takes the topic with exactly that name, or failing that the same name in another case. Case can matter: AIAgent and aiagent are separate topics.
async function findTopics(names) {
  const topics = [];
  const missing = [];
  for (const name of names) {
    const body = await call('POST', `${CREATOR}/api/galaxy/v2/creator/servicegw/v2/search/topics`, { keyword: name, topic_round_start_time: Date.now(), content: '' });
    const found = (body.data?.topics ?? []).map((t) => t.topic_info_dto).filter((t) => t?.id);
    const topic = found.find((t) => t.name === name) ?? found.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!topic) missing.push(`${name} (closest: ${found.slice(0, 3).map((t) => t.name).join(', ') || 'none'})`);
    else if (!topics.some((t) => t.id === topic.id)) topics.push({ id: topic.id, name: topic.name, link: topic.link, type: 'topic' });
  }
  if (missing.length) throw new Error(`Not RedNote topics, so nothing was uploaded: ${missing.join('; ')}. Use existing topic names.`);
  return topics;
}

// Your latest notes, newest first, as the creator site's note manager lists them.
async function postedNotes() {
  const body = await call('GET', `${CREATOR}/api/galaxy/v2/creator/note/user/posted`, { tab: 0, page: 0 });
  return body.data?.notes ?? [];
}

// A link that opens a note from the note manager's list. RedNote's note pages want the xsec_token the list gives with each note.
const noteUrl = (note) => `https://www.xiaohongshu.com/explore/${note.id}${note.xsec_token ? `?xsec_token=${encodeURIComponent(note.xsec_token)}&xsec_source=${note.xsec_source || 'pc_creatormng'}` : ''}`;

// A link that opens the new note. The share_link in the publish answer has no xsec_token and shows "page isn't available". The note is published by now, so a failed lookup falls back to the plain link instead of failing post, which an agent might then retry.
async function noteLink(id) {
  try {
    const note = (await postedNotes()).find((n) => n.id === id);
    if (note) return noteUrl(note);
  } catch {
    // Reported by returning the link without a token.
  }
  return noteUrl({ id });
}

// A note's 24-character id, from the id itself or a note URL (/explore/<id>, /discovery/item/<id>, /user/profile/<user>/<id>).
function noteId(value) {
  if (typeof value === 'number') throw new Error('Pass the note URL: the CLI turned this id into a number.');
  const id = [...String(value ?? '').matchAll(/(?:^|\/)([0-9a-f]{24})(?=$|[/?#])/gi)].pop()?.[1];
  if (!id) throw new Error('note is required: the note URL or its 24-character id, e.g. -a note=https://www.xiaohongshu.com/explore/<id>');
  return id.toLowerCase();
}

// Adds the hidden file input that fill puts the video in. It lasts until the page reloads.
async function prepare() {
  videoTools();
  if (!document.getElementById(INPUT_ID)) {
    document.body.append(Object.assign(document.createElement('input'), { type: 'file', id: INPUT_ID, accept: 'video/*', hidden: true }));
  }
  return { selector: `#${INPUT_ID}` };
}

async function post(ctx) {
  const media = videoTools();
  const input = document.getElementById(INPUT_ID);
  const file = input?.files?.[0];
  if (!file) throw new Error(`No video to post. In this tab, run prepare, then fill '#${INPUT_ID}' <video>.`);
  const title = String(ctx.args.title ?? '').trim();
  if (titleLength(title) > 20) throw new Error(`title is ${titleLength(title)} characters as RedNote counts them (two ASCII characters as one); it allows 20`);
  const visibility = String(ctx.args.visibility ?? 'everyone');
  if (!Object.hasOwn(VISIBILITY, visibility)) throw new Error('visibility must be everyone, friends or only_me');
  const description = noteText(ctx.args.description);
  const names = hashtagNames(ctx.args.hashtags);
  if (!title && !description && !names.length) throw new Error('Pass a title, a description or hashtags');

  const topics = await findTopics(names);
  const { video, audio, width, height, duration } = await metadata(media, file);
  // The publish page's ffmpeg names its working folders after the name given here and doesn't overwrite, so a fresh name keeps a repeat post from reading back an older frame. It refuses ("please bootstrap first") until the page has finished starting it.
  const frame = await media.getFirstFrame(`rednote-${Date.now()}`, file).catch((error) => {
    throw new Error(`The publish page's ffmpeg could not take the cover frame, so nothing was uploaded: ${error?.message ?? error}. If the page has only just opened, wait a few seconds and retry.`);
  });
  if (!(frame?.file instanceof Uint8Array)) throw new Error("The publish page's ffmpeg gave no first frame for the cover, so nothing was uploaded");
  const cover = await uploadCover(frame.file);
  const { fileId, videoId } = await uploadVideo(file);
  await processed(videoId);

  const desc = [description, topics.map((t) => `#${t.name}[话题]#`).join(' ')].filter(Boolean).join('\n\t\n');
  const res = await call('POST', `${EDITH}/web_api/sns/v2/note`, {
    common: {
      type: 'video',
      note_id: '',
      source: JSON.stringify({ type: 'web', ids: '', extraInfo: JSON.stringify({ subType: 'official', systemId: 'web' }) }),
      title,
      desc,
      ats: [],
      hash_tag: topics,
      business_binds: JSON.stringify({ version: 1, noteId: 0, bizType: 0, noteOrderBind: {}, notePostTiming: {}, noteCollectionBind: { id: '' }, noteSketchCollectionBind: { id: '' }, noteCopyBind: { copyable: true }, interactionPermissionBind: { commentPermission: 0 }, optionRelationList: [] }),
      privacy_info: { op_type: 1, type: VISIBILITY[visibility], user_ids: [] },
      goods_info: {},
      biz_relations: [],
      capa_trace_info: { contextJson: JSON.stringify({ recommend_title: { recommend_title_id: '', is_use: 3, used_index: -1 }, recommendTitle: [], recommend_topics: { used: topics.map((t) => ({ id: t.id, name: t.name, topic_source: 'search_offical' })) } }) },
    },
    image_info: null,
    video_info: {
      fileid: fileId,
      file_id: fileId,
      format_width: width,
      format_height: height,
      video_preview_type: width / height <= 0.6 ? 'full_vertical_screen' : '',
      composite_metadata: { video, audio },
      timelines: [],
      cover: {
        fileid: cover.id,
        file_id: cover.id,
        width: cover.width,
        height: cover.height,
        stickers: { neptune: [], version: 2 },
        fonts: [],
        frame: { ts: 0, is_upload: false, is_user_select: false },
        extra_info_json: JSON.stringify({ cover_recommend: { isUseRecommend: false, isAiCover: false } }),
      },
      chapters: [],
      summary: '',
      chapter_sync_text: false,
      segments: { count: 1, need_slice: false, items: [{ mute: 0, speed: 1, start: 0, duration, transcoded: 0, media_source: 1, original_metadata: { video, audio } }] },
      entrance: 'web',
      pk_cover_biz_relations: [],
    },
  });
  if (!res.data?.id) throw new Error(`RedNote did not publish the note: ${res.msg || JSON.stringify(res).slice(0, 200)}`);
  input.value = '';
  return { id: res.data.id, url: await noteLink(res.data.id), visibility, title, hashtags: topics.map((t) => t.name) };
}

// How many items a list function returns: limit, from 1 to 10 (the note manager's first page), 10 unless given.
const limitFrom = (value) => Math.min(Math.max(Math.trunc(Number(value)) || 10, 1), 10);

// Your latest notes, newest first, with links that open them. The note manager gives titles, not the notes' text. A note id starts with its creation time in seconds, as 8 hex digits.
async function recent(ctx) {
  if (location.hostname !== 'creator.xiaohongshu.com') throw new Error('recent runs on the creator site. Open https://creator.xiaohongshu.com/new/note-manager in this tab first.');
  return (await postedNotes()).slice(0, limitFrom(ctx.args.limit)).map((n) => ({ id: n.id, url: noteUrl(n), date: new Date(parseInt(n.id.slice(0, 8), 16) * 1000).toISOString(), title: n.display_title }));
}

// The first comments on a note, marking yours, as the note page loads them. RedNote asks for the xsec_token in the note's link, so pass a link that has one, such as url from post or recent.
async function comments(ctx) {
  if (location.hostname !== 'www.xiaohongshu.com') throw new Error('comments runs on www.xiaohongshu.com. Navigate this tab there first, for example to https://www.xiaohongshu.com/explore');
  const id = noteId(ctx.args.note);
  const token = new URL(String(ctx.args.note), 'https://www.xiaohongshu.com').searchParams.get('xsec_token') ?? '';
  const [page, me] = await Promise.all([
    call('GET', `${EDITH}/api/sns/web/v2/comment/page`, { note_id: id, cursor: '', top_comment_id: '', image_formats: 'jpg,webp,avif', xsec_token: token }),
    call('GET', `${EDITH}/api/sns/web/v2/user/me`),
  ]);
  // The www page's client hands back camelCase keys; the creator site's doesn't, so both spellings are read.
  const myId = me.data?.userId ?? me.data?.user_id;
  return {
    note: id,
    comments: (page.data?.comments ?? []).map((c) => {
      const user = c.userInfo ?? c.user_info ?? {};
      return { id: c.id, author: user.nickname, mine: myId ? (user.userId ?? user.user_id) === myId : null, text: c.content };
    }),
  };
}

// Comment as you on a note. Same request the note page sends.
async function comment(ctx) {
  if (location.hostname !== 'www.xiaohongshu.com') throw new Error('comment runs on www.xiaohongshu.com. Navigate this tab there first, for example to https://www.xiaohongshu.com/explore');
  const id = noteId(ctx.args.note);
  const text = String(ctx.args.text ?? '').trim();
  if (!text) throw new Error('text is required');
  const res = await call('POST', `${EDITH}/api/sns/web/v1/comment/post`, { note_id: id, content: text, at_users: [] });
  const posted = res.data?.comment;
  if (!posted?.id) throw new Error(`RedNote did not post the comment: ${res.msg || JSON.stringify(res).slice(0, 200)}`);
  return { note: id, comment: posted.id, text: posted.content };
}
