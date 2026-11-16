// ==UserAdapter==
// @name         YouTube uploads and comments
// @domain       studio.youtube.com
// ==/UserAdapter==

// Upload a video and comment on your videos as you, through YouTube Studio's own web client, in a signed-in tab.
//
//   chrome-devtools --target <name> navigate https://studio.youtube.com/
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/youtube.js prepare
//   chrome-devtools --target <name> fill '#yt-video' clip.mp4
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/youtube.js post -a title="..." [-a description="..."] [-a visibility=public|unlisted|private]
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/youtube.js comment -a video=<url from post> -a text="..."
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/youtube.js recent [-a limit=10]
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/youtube.js comments -a video=<url>
//
// recent and comments only read. recent lists your latest uploads, newest first, with id, url, date, visibility, title and description, as Studio's Content page does. comments lists the newest published comments on one of your videos, marking yours with mine. A comment just posted can take about 20 seconds to show there.
//
// prepare adds a hidden file input for fill to put the video in.
//
// post uploads that video, publishes it with title and description, returns its id and url, and empties the input, so posting again needs a new fill. visibility is public unless given. The video is marked as not made for kids, the answer Studio requires before publishing. YouTube decides whether it's a Short and processes it after publishing, so it can take a few minutes to play.
//
// comment posts a comment as you on a video on your own channel and returns its id: it goes through Studio, which only lists comments for your own videos. YouTube refuses comments on private videos. Pass the video's URL or its 11-character id.
//
// Run them on a signed-in studio.youtube.com page.
//
// How it works: Studio's app element holds its services, so this file uses them. Calls go through Studio's own InnerTube client (secureRequestService), which signs them (SAPISIDHASH) and handles Google's re-authentication prompts, so this file never touches tokens or cookies. The video goes up to upload.youtube.com with Google's resumable upload protocol, then upload/createvideo registers it as a private draft and video_manager/metadata_update sets its details and publishes it. Studio attests those two calls with BotGuard; this file asks Studio's own attestation object, found in Studio's code by its attest method, as Studio does. comment reads the video's comment parameters from comment/get_comments and posts with comment/create_comment. These are YouTube's internal endpoints and page internals, so a YouTube update can break them. The requests follow what Studio sent in November 2026.
//
// post and comment publish immediately as you and cannot be undone from here (a private video is visible only to you). Agents: confirm the video, the title, the description, the visibility and the text with the user first.

const INPUT_ID = 'yt-video';
const VISIBILITY = { public: 'PUBLIC', unlisted: 'UNLISTED', private: 'PRIVATE' };

// Studio's app element, whose properties are its services.
function studio() {
  const app = document.querySelector('ytcp-app');
  if (!app?.secureRequestService?.makeRequest || !app.uploadManager?.metadataService?.baseContextFactory || typeof window.ytcfg?.get !== 'function') {
    throw new Error("This needs YouTube Studio. Open https://studio.youtube.com/ in this tab, signed in, first. If it's open, YouTube has changed Studio and this adapter needs updating.");
  }
  return app;
}

// Calls an InnerTube endpoint (youtubei/v1/<endpoint>) through Studio's client, with the request context Studio builds.
async function innertube(endpoint, body, contextExtra) {
  const app = studio();
  const context = app.uploadManager.metadataService.baseContextFactory();
  if (contextExtra) context.request = { ...context.request, ...contextExtra };
  try {
    return await app.secureRequestService.makeRequest({ path: `/v1/${endpoint}`, body: { context, ...body } });
  } catch (error) {
    let detail;
    try {
      detail = JSON.stringify(error?.error ?? error);
    } catch {
      detail = String(error);
    }
    throw new Error(`${endpoint} failed: ${error?.message || detail}`);
  }
}

// Studio attests uploads and metadata changes with BotGuard through one shared object with an attest method. Its name in Studio's code changes with each build, so it is found by that method.
async function attest(engagementType, binding) {
  const owner = Object.values(window.default_cs ?? {}).find((v) => {
    try {
      return typeof v?.instance?.attest === 'function';
    } catch {
      return false;
    }
  });
  if (!owner) throw new Error("Could not find Studio's attestation code in this page. Reload the tab and retry.");
  return owner.instance.attest(engagementType, binding, 1500);
}

// Uploads the file with Google's resumable protocol, as Studio does: start a session, then send the file and finalize in one request.
async function upload(file, frontendUploadId) {
  const authuser = window.ytcfg.get('SESSION_INDEX') ?? 0;
  const started = await fetch(`https://upload.youtube.com/upload/studio?authuser=${authuser}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-File-Name': file.name,
      'X-Goog-Upload-Header-Content-Length': String(file.size),
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: JSON.stringify({ frontendUploadId }),
  });
  const url = started.headers.get('X-Goog-Upload-URL');
  if (!started.ok || !url) throw new Error(`YouTube did not start the upload: HTTP ${started.status}`);
  const done = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-File-Name': file.name, 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: file,
  });
  const result = await done.json().catch(() => null);
  if (!done.ok || result?.status !== 'STATUS_SUCCESS' || !result.scottyResourceId) throw new Error(`YouTube did not take the video: HTTP ${done.status} ${JSON.stringify(result).slice(0, 200)}`);
  return result.scottyResourceId;
}

// A video's 11-character id from its URL (watch?v=, youtu.be/, /shorts/, Studio's /video/) or the id itself. An all-digit id passed with -a arrives as a number, so it is refused rather than used.
function videoId(value) {
  if (typeof value === 'number') throw new Error('Pass the video URL: the CLI turned this id into a number.');
  const text = String(value ?? '').trim();
  const id = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/video\/|\/embed\/|\/live\/)([\w-]{11})/.exec(text)?.[1] ?? (/^[\w-]{11}$/.test(text) ? text : null);
  if (!id) throw new Error('video is required: the video URL, e.g. -a video=https://youtu.be/<id>');
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
  studio();
  const input = document.getElementById(INPUT_ID);
  const file = input?.files?.[0];
  if (!file) throw new Error(`No video to post. In this tab, run prepare, then fill '#${INPUT_ID}' <video>.`);
  const title = String(ctx.args.title ?? '').trim();
  if (!title) throw new Error('title is required');
  const description = String(ctx.args.description ?? '').replace(/\r\n?/g, '\n').trim();
  const visibility = String(ctx.args.visibility ?? 'public');
  if (!Object.hasOwn(VISIBILITY, visibility)) throw new Error('visibility must be public, unlisted or private');

  const frontendUploadId = `innertube_studio:${crypto.randomUUID().toUpperCase()}:0`;
  const scottyResourceId = await upload(file, frontendUploadId);

  // Registers the upload as a private draft, as Studio does before you have filled in the details.
  const created = await innertube(
    'upload/createvideo',
    {
      channelId: window.ytcfg.get('CHANNEL_ID'),
      resourceId: { scottyResourceId: { id: scottyResourceId } },
      frontendUploadId,
      initialMetadata: { title: { newTitle: title }, privacy: { newPrivacy: 'PRIVATE' }, draftState: { isDraft: true } },
      contentLevelProtection: { enableRequiresContentLevelProtection: false },
      // Studio sends false when it hasn't measured the file, and YouTube decides about Shorts itself.
      presumedShort: false,
    },
    { attestationResponseData: await attest('ENGAGEMENT_TYPE_VIDEO_UPLOAD', { scottyResourceId }) }
  );
  const id = created?.videoId;
  if (!id) throw new Error(`YouTube did not create the video: ${JSON.stringify(created).slice(0, 200)}`);

  // Sets the details and publishes, as Studio's Publish button does.
  const updated = await innertube('video_manager/metadata_update', {
    encryptedVideoId: id,
    videoReadMask: { title: true, privacy: true, draftStatus: true },
    flowType: 'MDE_FLOW_TYPE_UPLOAD',
    title: { newTitle: title, titleOperation: 'MDE_TEXT_UPDATE_OPERATION_SET' },
    description: { newDescription: description, descriptionOperation: 'MDE_TEXT_UPDATE_OPERATION_SET' },
    privacyState: { newPrivacy: VISIBILITY[visibility] },
    draftState: { operation: 'MDE_DRAFT_STATE_UPDATE_OPERATION_REMOVE_DRAFT_STATE' },
    madeForKids: { operation: 'MDE_MADE_FOR_KIDS_UPDATE_OPERATION_SET', newMfk: 'MDE_MADE_FOR_KIDS_TYPE_NOT_MFK' },
    attestationResponseData: await attest('ENGAGEMENT_TYPE_VIDEO_METADATA_UPDATE', { encryptedVideoId: id }),
  });
  if (updated?.overallResult?.resultCode !== 'UPDATE_SUCCESS') {
    throw new Error(`YouTube kept video ${id} as a private draft and refused the details: ${JSON.stringify(updated?.overallResult ?? updated).slice(0, 300)}. Fix them in Studio or delete the draft there.`);
  }
  input.value = '';
  return { id, url: `https://youtu.be/${id}`, visibility, title };
}

// How many items a list function returns: limit, from 1 to 50, 10 unless given.
const limitFrom = (value) => Math.min(Math.max(Math.trunc(Number(value)) || 10, 1), 50);

// Your latest uploads, newest first, as Studio's Content page lists them.
async function recent(ctx) {
  const res = await innertube('creator/list_creator_videos', {
    filter: { and: { operands: [{ channelIdIs: { value: window.ytcfg.get('CHANNEL_ID') } }, { videoOriginIs: { value: 'VIDEO_ORIGIN_UPLOAD' } }] } },
    order: 'VIDEO_ORDER_DISPLAY_TIME_DESC',
    pageSize: limitFrom(ctx.args.limit),
    mask: { videoId: true, title: true, description: true, timeCreatedSeconds: true, timePublishedSeconds: true, privacy: true },
  });
  return (res?.videos ?? []).map((v) => ({
    id: v.videoId,
    url: `https://youtu.be/${v.videoId}`,
    date: new Date(Number(v.timePublishedSeconds || v.timeCreatedSeconds) * 1000).toISOString(),
    visibility: String(v.privacy ?? '').replace('VIDEO_PRIVACY_', '').toLowerCase(),
    title: v.title,
    text: v.description,
  }));
}

// The newest comments on one of your videos, marking yours. Studio lists comments only for your own videos, and only published ones.
async function comments(ctx) {
  const id = videoId(ctx.args.video);
  const res = await innertube('comment/get_comments', { sortOrder: 'MOST_RELEVANT', searchQuery: '', maxReplies: 10, videoId: id, moderationState: 'PUBLISHED', commentsFilter: { sortBy: 'SORT_BY_NEWEST' } });
  const items = res?.contents?.itemSectionRenderer?.contents ?? [];
  return {
    video: id,
    comments: items
      .map((item) => item.commentThreadRenderer?.comment?.commentRenderer)
      .filter(Boolean)
      .map((c) => ({ id: c.commentId, author: c.authorText?.simpleText, mine: Boolean(c.viewerIsAuthor), text: (c.contentText?.runs ?? []).map((r) => r.text).join('') })),
  };
}

// Comment as you on one of your videos, the way Studio's Comments page does.
async function comment(ctx) {
  const id = videoId(ctx.args.video);
  const text = String(ctx.args.text ?? '').trim();
  if (!text) throw new Error('text is required');
  const listed = await innertube('comment/get_comments', {
    sortOrder: 'MOST_RELEVANT',
    searchQuery: '',
    maxReplies: 10,
    videoId: id,
    moderationState: 'PUBLISHED',
    commentsFilter: { sortBy: 'SORT_BY_MOST_RELEVANT', commentCategoryIn: { values: ['COMMENT_CATEGORY_NOT_ENGAGED'] } },
  });
  const createCommentParams = /"createCommentParams":"([^"]+)"/.exec(JSON.stringify(listed))?.[1];
  if (!createCommentParams) throw new Error(`YouTube gave no way to comment on ${id}. comment works on videos on your own channel that allow comments.`);
  // Sent exactly as get_comments returns it, still URL-encoded, as Studio does.
  const res = await innertube('comment/create_comment', { commentText: text, createCommentParams });
  const commentId = /"commentId":"([^"]+)"/.exec(JSON.stringify(res))?.[1];
  if (!commentId) throw new Error(`YouTube did not post the comment: ${JSON.stringify(res).slice(0, 200)}`);
  return { video: id, comment: commentId, text };
}
