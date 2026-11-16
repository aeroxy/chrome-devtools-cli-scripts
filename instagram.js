// ==UserAdapter==
// @name         Instagram Reels and comments
// @domain       www.instagram.com
// ==/UserAdapter==

// Post a video as a Reel and comment on posts as you, through Instagram's own web code in a signed-in tab.
//
//   chrome-devtools --target <name> navigate https://www.instagram.com/
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/instagram.js prepare
//   chrome-devtools --target <name> fill '#ig-video' clip.mp4
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/instagram.js post -a caption="..."
//   chrome-devtools --target <name> adapter <skill-folder>/scripts/instagram.js comment -a post=<url from post> -a text="..."
//
// prepare adds a hidden file input for fill to put the video in.
//
// post uploads that video, publishes it as a Reel with caption, returns its id and url, and empties the input, so posting again needs a new fill. Hashtags and @mentions in caption work as typed. Comments and like counts stay on, Instagram's defaults. Instagram picks the cover frame itself.
//
// comment posts a comment on a post or Reel and returns its id. Pass the post's URL: comment works out the media id from the code in it.
//
// Run them on any signed-in www.instagram.com page.
//
// How it works: Instagram's web app is made of named modules that its global require returns, so this file calls the code the app itself uses. post reads the video's duration and size with Instagram's container parser rather than a video element, which Chrome doesn't load in a tab that has never been shown, uploads it with Instagram's uploader, asking Instagram to take the cover frame (extract_cover_frame, one of the app's own cover modes), and publishes with the composer's configure call, which retries while Instagram processes the video. The composer's code isn't on a page until the New post dialog opens, so post loads the dialog's resource first, without opening anything. comment runs the app's comment mutation through its Relay environment. That code adds the CSRF and session tokens itself, so this file never touches tokens or cookies. These are Instagram's internal endpoints and page internals, so an Instagram update can break them. The requests follow what the web app sent in November 2026.
//
// post and comment publish immediately as you, publicly unless the account is private, and cannot be undone from here. Agents: confirm the video, the caption and the text with the user first.

const INPUT_ID = 'ig-video';
// The composer's resource, which the New post button loads. Loading it defines the creation modules post uses.
const COMPOSER = 'PolarisCreationModal.next.react';
// Instagram's post codes are the media id written in base 64 with this alphabet.
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// One of Instagram's named modules. Its require returns undefined for a module the page hasn't loaded.
function ig(name) {
  if (typeof window.require !== 'function') throw new Error('This needs an Instagram page. Open https://www.instagram.com/ in this tab, signed in, first.');
  const module = window.require(name);
  if (!module || !Object.keys(module).length) throw new Error(`Instagram's ${name} module isn't on this page. Reload the tab and retry. If that doesn't help, Instagram has changed its web app and this adapter needs updating.`);
  return module;
}

function within(promise, seconds, what) {
  return Promise.race([promise, new Promise((resolve, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${seconds} seconds. Reload the tab and retry.`)), seconds * 1000))]);
}

async function composer() {
  const loaded = window.require?.('PolarisCreationAPI');
  if (!loaded || !Object.keys(loaded).length) await within(ig('JSResourceForInteraction')(COMPOSER).load(), 30, "Loading Instagram's composer");
  return { api: ig('PolarisCreationAPI'), parser: ig('PolarisCreationVideoSourceMetadata'), uploader: ig('PolarisAPIRuploadVideo'), helpers: ig('PolarisUploadHelpers') };
}

// A post's media id from its URL (/p/<code>/, /reel/<code>/, /reels/<code>/, /<user>/p/<code>/). Longer codes carry extra data after the first 11 characters, which hold the id.
function mediaId(value) {
  const code = /instagram\.com\/(?:[\w.]+\/)?(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/.exec(String(value ?? ''))?.[1];
  if (!code) throw new Error('post is required: the post URL, e.g. -a post=https://www.instagram.com/reel/<code>/');
  let id = 0n;
  for (const ch of code.slice(0, 11)) id = id * 64n + BigInt(CODE_ALPHABET.indexOf(ch));
  return id.toString();
}

// Adds the hidden file input that fill puts the video in. It lasts until the page reloads.
async function prepare() {
  ig('PolarisAPIRuploadVideo');
  if (!document.getElementById(INPUT_ID)) {
    document.body.append(Object.assign(document.createElement('input'), { type: 'file', id: INPUT_ID, accept: 'video/*', hidden: true }));
  }
  return { selector: `#${INPUT_ID}` };
}

async function post(ctx) {
  const input = document.getElementById(INPUT_ID);
  const file = input?.files?.[0];
  if (!file) throw new Error(`No video to post. In this tab, run prepare, then fill '#${INPUT_ID}' <video>.`);
  if (!file.type.startsWith('video/')) throw new Error(`A Reel needs a video; this file's type is ${file.type || 'unknown'}`);
  const caption = String(ctx.args.caption ?? '').replace(/\r\n?/g, '\n').trim();
  const { api, parser, uploader, helpers } = await composer();

  const info = await parser.getVideoSourceMetadataFromFile(file, null, false);
  if (!info?.durationSeconds || !info.width || !info.height) throw new Error("Instagram's parser could not read this video's duration and size. Reels take MP4 or MOV files.");
  const uploadId = helpers.createUploadId();
  // The composer's own parameters for a single Reel, in the mode where Instagram takes the cover frame.
  const uploaded = await uploader.ruploadVideo({
    entityName: `fb_uploader_${uploadId}`,
    extractCoverFrame: true,
    file: new File([file], `video_${uploadId}`, { type: file.type }),
    isIgtvVideo: true,
    isLinkedClip: false,
    isSidecar: false,
    isUnifiedVideo: true,
    uploadId,
    uploadMediaDurationMs: Math.floor(info.durationSeconds * 1000),
    uploadMediaHeight: info.height,
    uploadMediaWidth: info.width,
  });
  if (uploaded?.status !== 'ok') throw new Error(`Instagram did not take the video: ${JSON.stringify(uploaded).slice(0, 200)}`);

  const res = await api.configure({ type: 'video', uploadId, caption, archiveOnly: false, disableComments: false, disableLikeViewCounts: false, disableOaReuse: false, usertags: [], videoSubtitlesEnabled: false });
  if (res?.status !== 'ok' || !res.media?.pk) throw new Error(`Instagram did not publish the Reel: ${res?.message || res?.error_title || `status ${res?.status}`}`);
  input.value = '';
  return { id: String(res.media.pk), url: `https://www.instagram.com/reel/${res.media.code}/`, caption };
}

// Comment as you on a post. Same mutation the post page sends.
async function comment(ctx) {
  const id = mediaId(ctx.args.post);
  const text = String(ctx.args.text ?? '').trim();
  if (!text) throw new Error('text is required');
  const relay = ig('CometRelay');
  const mutation = ig('usePolarisCommentCreateMutation.graphql');
  const environment = ig('CometRelayEnvironmentFactory').defaultEnvironment;
  const res = await within(
    new Promise((resolve, reject) => {
      relay.commitMutation(environment, {
        mutation,
        variables: { data: { comment_text: text, media_id: id }, root_connections: [] },
        onCompleted: (response, errors) => (errors?.length ? reject(new Error(`Instagram refused the comment: ${errors.map((e) => e.message).join('; ')}`)) : resolve(response)),
        onError: (error) => reject(new Error(`Instagram refused the comment: ${error?.message ?? error}`)),
      });
    }),
    60,
    'Posting the comment'
  );
  const created = res?.xig_comment_create;
  if (!created?.comment?.pk) throw new Error(`Instagram did not post the comment: ${JSON.stringify(created ?? res).slice(0, 200)}`);
  return { post: id, comment: String(created.comment.pk), text: created.comment.text };
}
