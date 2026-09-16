import { describe, it, expect } from 'vitest';
import { encodeConfig, decodeConfig, AddonConfig } from '../src/config.js';

describe('config', () => {
  const sampleConfig: AddonConfig = {
    streamUrl: 'https://example.com/stream/manifest.json',
    subUrl: 'https://example.com/sub/manifest.json',
  };

  it('encodes and decodes config roundtrip', () => {
    const encoded = encodeConfig(sampleConfig);
    const decoded = decodeConfig(encoded);
    expect(decoded).toEqual(sampleConfig);
  });

  it('returns null for invalid encoded string', () => {
    expect(decodeConfig('garbage')).toBeNull();
  });

  it('returns null for missing required fields', () => {
    const incomplete = encodeConfig({ streamUrl: '', subUrl: '' });
    const decoded = decodeConfig(incomplete);
    expect(decoded).toBeNull();
  });
});
