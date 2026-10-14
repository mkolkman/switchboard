/**
 * preview-urls.js: the pages in a session's terminal output worth opening
 * beside it: a local dev server (http://localhost:5173, 127.0.0.1:8000, ...)
 * and claude.ai artifact links. Both plain text and OSC 8 hyperlinks count.
 */

const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s"'<>`)\]]*)?/gi;
const ARTIFACT_URL = /\bhttps:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+(?:\/[^\s"'<>`)\]]*)?/gi;

// CSI and other escape sequences, after OSC 8 targets have been taken out.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** A found URL as it should be opened: 0.0.0.0 is not an address to browse to. */
function normalizePreviewUrl(url) {
  return url.replace(/[.,;:!?]+$/, '').replace('://0.0.0.0', '://localhost');
}

function isPreviewUrl(url) {
  LOCAL_URL.lastIndex = 0;
  ARTIFACT_URL.lastIndex = 0;
  return LOCAL_URL.test(url) || ARTIFACT_URL.test(url);
}

/**
 * Every preview URL in a chunk of terminal output, in order, once each. With
 * `partialEnd`, a URL that runs to the very end may be cut off ("…:51" of
 * ":5173"), so it waits for the next chunk.
 */
function findPreviewUrls(text, { partialEnd = false } = {}) {
  const found = [];
  const add = (url) => {
    const clean = normalizePreviewUrl(url);
    if (!found.includes(clean)) found.push(clean);
  };
  // OSC 8: ESC ] 8 ; params ; URL ST. The link text may be shortened, the target is whole.
  for (const m of text.matchAll(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g)) {
    if (isPreviewUrl(m[1])) add(m[1]);
  }
  const plain = text.replace(ANSI, '');
  for (const re of [LOCAL_URL, ARTIFACT_URL]) {
    re.lastIndex = 0;
    for (const m of plain.matchAll(re)) {
      if (partialEnd && m.index + m[0].length >= plain.length) continue;
      add(m[0]);
    }
  }
  return found;
}

/**
 * Per session: what has been seen, and the end of the last chunk, since a URL
 * can be split across two. What shows in the first seconds is the replay of
 * a resumed conversation: remembered, but not opened.
 */
function createPreviewWatcher({ quietMs = 4000, now = Date.now } = {}) {
  const startedAt = now();
  const seen = new Set();
  let tail = '';
  return {
    /** The URLs in this chunk to open now. */
    feed(chunk) {
      const text = tail + chunk;
      tail = text.slice(-300);
      const fresh = findPreviewUrls(text, { partialEnd: true }).filter(u => !seen.has(u));
      fresh.forEach(u => seen.add(u));
      return now() - startedAt < quietMs ? [] : fresh;
    },
  };
}

module.exports = { findPreviewUrls, normalizePreviewUrl, isPreviewUrl, createPreviewWatcher };
