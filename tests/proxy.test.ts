import { describe, it, expect } from 'vitest';
import { fetchJson, fetchText } from '../src/lib/proxy.js';

describe('proxy', () => {
  it('fetchJson returns parsed JSON', async () => {
    const data = await fetchJson<{ slideshow?: { title?: string } }>(
      'https://httpbin.org/json'
    );
    expect(data).toBeTruthy();
  });

  it('fetchText returns string', async () => {
    const text = await fetchText('https://httpbin.org/robots.txt');
    expect(typeof text).toBe('string');
    expect(text!.length).toBeGreaterThan(0);
  });

  it(
    'fetchJson returns null on error',
    async () => {
      const data = await fetchJson('https://invalid.example.test/nope');
      expect(data).toBeNull();
    },
    { timeout: 20000 }
  );
});
