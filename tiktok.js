// ==UserAdapter==
// @name         TikTok posts and comments
// @domain       www.tiktok.com
// ==/UserAdapter==

// Post a video and comment on videos as you, through the same web API TikTok Studio uses, in a signed-in tab.
//
//   chrome-devtools --target <name> navigate https://www.tiktok.com/tiktokstudio/content
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/tiktok.js prepare
//   chrome-devtools --target <name> fill '#tiktok-video' clip.mp4
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/tiktok.js post -a description="..." [-a hashtags="AITools, LLM"] [-a visibility=everyone|friends|only_me]
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/tiktok.js comment -a video=<url from post> -a text="..."
//
// prepare adds a hidden file input for fill to put the video in. Studio's own upload input would start Studio's uploader instead.
//
// post uploads that video, publishes it, returns its id and url, and empties the input, so posting again needs a new fill. The caption is description, a blank line, then hashtags (separated by spaces or commas, with or without #). Every #tag in the caption becomes a hashtag, including any in the description. visibility is everyone unless given. Comments are allowed; duet, stitch and reuse are not. TikTok makes the cover from the video.
//
// comment posts a comment on a video and returns its id. Pass the video's URL, not its id: the CLI turns a bare 19-digit number into a rounded one.
//
// Run them on a TikTok Studio page: post reads the account and upload region there, and comment has only been tried there. Neither needs the tab in front.
//
// How it works: TikTok's own scripts in the page sign the API calls (msToken, X-Bogus, _signature, and a CSRF token on protected POSTs), so this file never touches tokens or cookies. post gets temporary upload credentials from /api/v1/video/upload/auth/, signs one call to the video storage API with them (AWS Signature V4), uploads the file in slices, has the storage service register the video, runs the music copyright check, and publishes with /tiktok/web/project/post/v1/. These are TikTok's undocumented endpoints, so a TikTok update can break them. The requests follow what Studio sent in November 2026.
//
// post and comment publish immediately as you and cannot be undone from here. Agents: confirm the video, the text and the visibility with the user first.

const INPUT_ID = 'tiktok-video';
// Studio's codes for who can see a post.
const VISIBILITY = { everyone: 0, friends: 2, only_me: 1 };
// Studio picks 3, 5 or 10 MB slices by connection speed. 5 MB is its normal size.
const SLICE_BYTES = 5 * 1024 * 1024;
// Studio signs storage calls for the region its page names in gfdatav1, and anything not listed here is Singapore. Only Singapore has been tried.
const STORAGE_REGIONS = { maliva: 'us-east-1', ttp: 'US-TTP', ttp2: 'US-TTP', ie: 'gcp', useastred: 'gcp', 'eu-ttp2': 'gcp', no1a: 'gcp' };

// Calls TikTok's web API from inside the page. TikTok's own scripts there add msToken, X-Bogus and _signature to the URL, and the CSRF token to protected POSTs. agw-js-conv: str asks for 64-bit ids as strings, which JSON.parse would otherwise round.
function request(method, path, query, body) {
  const url = `${path}?${new URLSearchParams({ aid: '1988', ...query })}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('agw-js-conv', 'str');
    if (body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = () => {
      let json = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // Reported below with the status code.
      }
      if (xhr.status !== 200 || !json) reject(new Error(`${method} ${path} returned HTTP ${xhr.status}${json ? '' : ' and no JSON'}`));
      else resolve(json);
    };
    xhr.onerror = () => reject(new Error(`${method} ${path} failed before reaching TikTok`));
    xhr.send(body === undefined ? null : JSON.stringify(body));
  });
}

// The signed-in account and upload region, from the context Studio embeds in its pages as JSON with HTML entities left in.
function studio() {
  const el = document.getElementById('__Creator_Center_Context__');
  if (!el) throw new Error('This needs a TikTok Studio page. Open https://www.tiktok.com/tiktokstudio/content in this tab first.');
  const json = el.textContent.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const user = JSON.parse(json).commonAppContext?.user;
  // Studio gives the 19-digit uid as a string. As a number it would already be rounded.
  if (typeof user?.uid !== 'string') throw new Error('Could not find the signed-in account on this Studio page. Reload it and retry.');
  let region = 'sg';
  try {
    region = JSON.parse(document.getElementById('gfdatav1')?.textContent || '{}').region || region;
  } catch {
    // Studio itself falls back to Singapore when gfdatav1 is missing or unreadable.
  }
  return { uid: user.uid, handle: user.uniqueId, region: STORAGE_REGIONS[region] ?? 'ap-singapore-1' };
}

const utf8 = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', utf8.encode(text)));
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

async function hmac(key, text) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? utf8.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, utf8.encode(text));
}

// A GET to TikTok's video storage API (the vod service behind /top/v1), signed with AWS Signature V4 using the upload credentials, as Studio's uploader does.
async function storage(query, creds, region) {
  const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = stamp.slice(0, 8);
  const qs = Object.keys(query).sort().map((k) => `${rfc3986(k)}=${rfc3986(String(query[k]))}`).join('&');
  const canonical = ['GET', '/top/v1', qs, `x-amz-date:${stamp}`, `x-amz-security-token:${creds.session_token}`, '', 'x-amz-date;x-amz-security-token', await sha256('')].join('\n');
  const scope = `${day}/${region}/vod/aws4_request`;
  let key = await hmac(`AWS4${creds.secret_acess_key}`, day);
  for (const part of [region, 'vod', 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, ['AWS4-HMAC-SHA256', stamp, scope, await sha256(canonical)].join('\n')));
  const res = await fetch(`/top/v1?${qs}`, {
    headers: {
      'x-amz-date': stamp,
      'x-amz-security-token': creds.session_token,
      authorization: `AWS4-HMAC-SHA256 Credential=${creds.access_key_id}/${scope}, SignedHeaders=x-amz-date;x-amz-security-token, Signature=${signature}`,
    },
  });
  const json = await res.json().catch(() => null);
  const error = json?.ResponseMetadata?.Error;
  if (!res.ok || !json?.Result || error) throw new Error(`The video storage API refused ${query.Action}: ${error?.Message ?? `HTTP ${res.status}`}`);
  return json.Result;
}

// A POST to the upload host. It answers code 2000 on success.
async function tos(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])), body });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.code !== 2000) throw new Error(`The video upload failed at ${headers['X-Phase']}: ${json?.message ?? `HTTP ${res.status}`}`);
  return json.data;
}

// Uploads the file the way Studio's uploader does in its stream mode, and returns the video's vid and metadata (Width, Height, Duration in seconds).
async function upload(file, creds, region, uid) {
  const address = await storage(
    { Action: 'ApplyUploadInner', Version: '2020-11-19', SpaceName: 'tiktok', FileType: 'video', IsInner: 1, 'X-Amz-Expires': 604800, s: Math.random().toString(36).slice(2, 12), device_platform: 'web', business_tag: 'tiktok_video_submission_web' },
    creds,
    region
  );
  const node = address.InnerUploadAddress?.UploadNodes?.[0];
  const store = node?.StoreInfos?.[0];
  if (!store?.Auth) throw new Error('The video storage API gave no upload address.');
  const url = `https://${node.UploadHost}/upload/v1/${store.StoreUri}?uploadid=${crypto.randomUUID()}&device_platform=web`;
  const base = { Authorization: store.Auth, 'X-Storage-U': uid, 'X-Enable-Upload-Mode': 'stream' };
  const crcs = [];
  for (let start = 0, part = 1; start < file.size; start += SLICE_BYTES, part++) {
    const slice = file.slice(start, start + SLICE_BYTES);
    // The host computes each slice's CRC32 itself when told to ignore it, and the finish step quotes those back. The Content-Disposition is what Studio sends, file name included.
    const sent = await tos(
      url,
      { ...base, 'X-Phase': 'transfer', 'X-Part-Number': part, 'X-Part-Offset': start, 'X-Size': slice.size, 'X-Offset': 0, 'X-Enable-Omit-Init-Upload': 1, 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="undefined"', 'Content-CRC32': 'Ignore' },
      slice
    );
    crcs.push(`${part}:${sent.crc32}`);
  }
  // With post_upload_param the host also registers the upload as a video, which saves a separate commit call.
  const done = await tos(
    url,
    { ...base, 'X-Phase': 'finish', 'X-Size': file.size, 'X-Upload-With-PostUpload': 1, 'Content-Type': 'application/json' },
    JSON.stringify({ parts_crc: crcs.join(','), post_upload_param: { sts2_token: creds.session_token, sts2_secret: creds.secret_acess_key, session_key: node.SessionKey, functions: [] } })
  );
  const video = done?.post_upload_resp?.results?.[0];
  if (!video?.vid || !video.video_meta) throw new Error('The upload finished but TikTok returned no video id.');
  return video;
}

function captionFrom(args) {
  const description = String(args.description ?? '').replace(/\r\n?/g, '\n').trim();
  const tags = String(args.hashtags ?? '').split(/[\s,]+/).map((t) => t.replace(/^#+/, '')).filter(Boolean);
  return [description, tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join('\n\n');
}

const escapeMarkup = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// TikTok links a hashtag only when markup_text wraps it as <h id="N">#tag</h> and text_extra has entry N for it. A #tag in text alone stays plain text. Both are built the way Studio's editor builds them: offsets are JavaScript string indices, the text between hashtags is HTML-escaped, and line breaks become <br>.
function hashtagMarkup(text) {
  const textExtra = [];
  let markup = '';
  let at = 0;
  for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_]+)/gu)) {
    const start = m.index + m[1].length;
    const end = start + 1 + m[2].length;
    const id = textExtra.length;
    textExtra.push({ tag_id: String(id), start, end, user_id: '', type: 1, hashtag_name: m[2] });
    markup += `${escapeMarkup(text.slice(at, start))}<h id="${id}">#${m[2]}</h>`;
    at = end;
  }
  return { textExtra, markup: (markup + escapeMarkup(text.slice(at))).replace(/\n/g, '<br>') };
}

// Studio's creation_id: 21 random letters and digits.
function creationId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(21)), (b) => chars[b % chars.length]).join('');
}

// A video's id from its URL. A bare id passed with -a arrives as a number the CLI has already rounded, so it is refused rather than used.
function videoId(value) {
  if (typeof value === 'number') throw new Error('Pass the video URL (https://www.tiktok.com/@<handle>/video/<id>), not the bare id: the CLI turns a 19-digit number into a rounded one.');
  const id = /\/video\/(\d+)/.exec(String(value ?? ''))?.[1] ?? (/^\d+$/.test(String(value ?? '')) ? String(value) : null);
  if (!id) throw new Error('video is required: the video URL, e.g. -a video=https://www.tiktok.com/@<handle>/video/<id>');
  return id;
}

// Adds the hidden file input that fill puts the video in. It lasts until the page reloads.
async function prepare() {
  studio();
  if (!document.getElementById(INPUT_ID)) {
    document.body.append(Object.assign(document.createElement('input'), { type: 'file', id: INPUT_ID, accept: 'video/*', hidden: true }));
  }
  return { selector: `#${INPUT_ID}` };
}

async function post(ctx) {
  const input = document.getElementById(INPUT_ID);
  const file = input?.files?.[0];
  if (!file) throw new Error(`No video to post. In this tab, run prepare, then fill '#${INPUT_ID}' <video>.`);
  const text = captionFrom(ctx.args);
  if (!text) throw new Error('description or hashtags is required');
  const visibility = String(ctx.args.visibility ?? 'everyone');
  if (!(visibility in VISIBILITY)) throw new Error('visibility must be everyone, friends or only_me');
  const account = studio();

  const auth = await request('GET', '/api/v1/video/upload/auth/');
  if (!auth.video_token_v5) throw new Error(`TikTok gave no upload credentials: ${auth.status_msg || `status ${auth.status_code}`}`);
  const { vid, video_meta: meta } = await upload(file, auth.video_token_v5, account.region, account.uid);
  const music = await request('GET', '/tiktok/copyright/music/check/v1/', { video_id: vid });
  if (music.status_code !== 0 || !music.pre_check_id) throw new Error(`The music copyright check failed: ${music.status_msg || `status ${music.status_code}`}`);

  const { textExtra, markup } = hashtagMarkup(text);
  const res = await request(
    'POST',
    '/tiktok/web/project/post/v1/',
    { app_name: 'tiktok_web', channel: 'tiktok_web', device_platform: 'web', tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone },
    {
      post_common_info: { creation_id: creationId(), enter_post_page_from: 1, post_type: 3 },
      feature_common_info_list: [
        {
          geofencing_regions: [],
          playlist_name: '',
          playlist_id: '',
          tcm_params: '{"commerce_toggle_info":{}}',
          sound_exemption: 0,
          music_copyright: { result: music.copyright_detection_result },
          anchors: [],
          vedit_common_info: { draft: '', video_id: vid },
          privacy_setting_info: { visibility_type: VISIBILITY[visibility], allow_duet: 0, allow_stitch: 0, allow_comment: 1, allow_content_reuse: 0, allow_ai_remix: 1 },
          content_check_id: '',
        },
      ],
      single_post_req_list: [
        {
          batch_index: 0,
          video_id: vid,
          is_long_video: meta.Duration > 60 ? 1 : 0,
          single_post_feature_info: {
            text,
            text_extra: textExtra,
            markup_text: markup,
            music_info: { music_pre_check_id: music.pre_check_id, origin_volume: '100' },
            poster_delay: 0,
            cloud_edit_video_height: meta.Height,
            cloud_edit_video_width: meta.Width,
            cloud_edit_is_use_video_canvas: false,
            has_original_audio: 1,
            is_upload_audio_track: false,
            video_track_time_range_list: [{ start_time_in_ms: 0, end_time_in_ms: Math.round(meta.Duration * 1000) }],
            mature_theme_type: 0,
          },
        },
      ],
    }
  );
  const result = res.single_post_resp_list?.[0];
  if (res.status_code !== 0 || result?.status_code !== 0 || !result.item_id) {
    throw new Error(`TikTok refused the post: ${result?.status_msg || res.status_msg || `status ${result?.status_code ?? res.status_code}`}`);
  }
  input.value = '';
  const id = String(result.item_id);
  return { id, url: account.handle ? `https://www.tiktok.com/@${account.handle}/video/${id}` : null, visibility, caption: text };
}

// Comment as you on a video. Same request Studio sends from its Content page.
async function comment(ctx) {
  const id = videoId(ctx.args.video);
  const text = String(ctx.args.text ?? '').trim();
  if (!text) throw new Error('text is required');
  const res = await request('POST', '/api/comment/publish/', { app_name: 'tiktok_creator_center', device_platform: 'web_pc', scene: '156', aweme_id: id, text, text_extra: '[]' }, { aweme_id: id, text, text_extra: '[]' });
  if (res.status_code !== 0 || !res.comment?.cid) throw new Error(`TikTok refused the comment: ${res.status_msg || `status ${res.status_code}`}`);
  return { video: id, comment: String(res.comment.cid), text: res.comment.text };
}
