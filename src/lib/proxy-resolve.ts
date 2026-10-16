/**
 * Unwrap upstream "local proxy" URLs (SubSense convention) to their real source.
 *
 * SubSense returns `http://127.0.0.1:11470/subtitles.srt?from=<real-url>` —
 * the real URL is only reachable from the user's machine. This helper pulls
 * the `from` parameter out so we can fetch the real content server-side.
 *
 * Some sub addons (e.g. subsense) also return percent-encoded paths where
 * `/` is sent as `%2F` (sometimes multiple times). Calling fetch() with such
 * a URL would re-encode the `%` to `%25`, giving the server a double-encoded
 * path that 404s. Detect and decode in a loop until stable.
 */

export function resolveRealUrl(url: string): string {
  if (!url) return url;
  // 1. Unwrap SubSense 127.0.0.1?from=... convention (recursive)
  try {
    const parsed = new URL(url);
    const from = parsed.searchParams.get('from');
    if (from && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
      return resolveRealUrl(from);
    }
  } catch {}
  // 2. Loop-decode percent-encoded path components. Stop when no change
  //    or when a decoded form yields a valid fetchable URL. We test for
  //    both `%25` (encoded `%`, used in double/triple-encoding) and
  //    `%2F` (encoded `/`, common single-layer case).
  let current = url;
  for (let i = 0; i < 4; i++) {
    if (!current.includes('%25') && !current.includes('%2F') && !current.includes('%2f')) break;
    let decoded: string;
    try { decoded = decodeURIComponent(current); } catch { break; }
    if (decoded === current) break;
    current = decoded;
  }
  // 3. Add https:// when the URL has a host but no scheme
  if (!/^https?:\/\//i.test(current)) {
    // Heuristic: must look like host.tld/path
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(current)) {
      current = `https://${current}`;
    }
  }
  return current;
}
