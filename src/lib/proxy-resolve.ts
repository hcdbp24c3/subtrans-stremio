/**
 * Unwrap upstream "local proxy" URLs (SubSense convention) to their real source.
 *
 * SubSense returns `http://127.0.0.1:11470/subtitles.srt?from=<real-url>` —
 * the real URL is only reachable from the user's machine. This helper pulls
 * the `from` parameter out so we can fetch the real content server-side.
 *
 * Some sub addons (e.g. subsense) also return percent-encoded paths where
 * `/` is sent as `%2F`. Calling fetch() with such a URL would re-encode
 * the `%` to `%25`, giving the server a double-encoded path that 404s.
 * Detect this and decode once.
 */

export function resolveRealUrl(url: string): string {
  if (!url) return url;
  // 1. Unwrap SubSense 127.0.0.1?from=... convention
  try {
    const parsed = new URL(url);
    const from = parsed.searchParams.get('from');
    if (from && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
      return resolveRealUrl(from);
    }
  } catch {}
  // 2. Detect and undo upstream percent-encoding of path components
  //    (e.g. "ensubtitles.org%2Fen%2Fdownload%2F...").
  //    If decoding produces a string with `/` in the path, treat it as
  //    a path-encoded URL and return the decoded form. Add https://
  //    when no scheme is present so the URL is fetchable.
  if (url.includes('%2F') || url.includes('%2f')) {
    let decoded: string;
    try { decoded = decodeURIComponent(url); } catch { return url; }
    if (decoded === url) return url;
    // If decoded now contains `/`, it was definitely path-encoded
    if (decoded.includes('/')) {
      return /^https?:\/\//i.test(decoded) ? decoded : `https://${decoded}`;
    }
  }
  return url;
}
