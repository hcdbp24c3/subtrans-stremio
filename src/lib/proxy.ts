export async function fetchJson<T = unknown>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Stremio-SubAlign/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Stremio-SubAlign/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function fetchBuffer(
  url: string,
  range?: { start: number; end: number }
): Promise<Buffer | null> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Stremio-SubAlign/1.0',
    };
    if (range) {
      headers['Range'] = `bytes=${range.start}-${range.end}`;
    }
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch {
    return null;
  }
}
