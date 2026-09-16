export async function fetchJson<T = unknown>(
  url: string,
  extraHeaders?: Record<string, string>
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Stremio/5.0',
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchText(
  url: string,
  extraHeaders?: Record<string, string>
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Stremio/5.0',
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
