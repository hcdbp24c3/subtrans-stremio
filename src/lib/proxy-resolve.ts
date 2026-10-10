/**
 * Unwrap upstream "local proxy" URLs (SubSense convention) to their real source.
 *
 * SubSense returns `http://127.0.0.1:11470/subtitles.srt?from=<real-url>` —
 * the real URL is only reachable from the user's machine. This helper pulls
 * the `from` parameter out so we can fetch the real content server-side.
 */

export function resolveRealUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const from = parsed.searchParams.get('from');
    if (from && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
      return from;
    }
  } catch {}
  return url;
}
