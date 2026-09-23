/**
 * Proxy URL extension for Nuvio.
 *
 * NEVER return .ass/.ssa: Nuvio's Android ICU regex rejects unescaped `}`
 * in `\{[^}]*}` (PatternSyntaxException near index 8) when entering its ASS
 * parser. handleSubDownload always converts ASS→SRT, so advertise .srt.
 */
export function detectFileExt(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.vtt') || pathname.includes('.vtt?')) return '.vtt';
    // .ass/.ssa intentionally fall through to .srt (converted on download)
  } catch {}
  return '.srt';
}
