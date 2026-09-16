import { describe, it, expect } from 'vitest';
import { encodeConfig, decodeConfig, AddonConfig } from '../src/config.js';

describe('config', () => {
  const sampleConfig: AddonConfig = {
    streamUrl: 'https://example.com/stream/manifest.json',
    subUrl: 'https://example.com/sub/manifest.json',
    languages: '',
  };

  it('encodes and decodes config roundtrip (empty languages)', () => {
    const encoded = encodeConfig(sampleConfig);
    const decoded = decodeConfig(encoded);
    expect(decoded).toEqual(sampleConfig);
  });

  it('encodes and decodes with languages', () => {
    const config: AddonConfig = {
      ...sampleConfig,
      languages: 'en,vi,ja',
    };
    const encoded = encodeConfig(config);
    const decoded = decodeConfig(encoded);
    expect(decoded).toEqual(config);
  });

  it('defaults languages to empty string', () => {
    const encoded = encodeConfig(sampleConfig);
    const decoded = decodeConfig(encoded);
    expect(decoded?.languages).toBe('');
  });

  it('returns null for invalid encoded string', () => {
    expect(decodeConfig('garbage')).toBeNull();
  });

  it('returns null for missing required fields', () => {
    const incomplete = encodeConfig({ streamUrl: '', subUrl: '', languages: '' });
    const decoded = decodeConfig(incomplete);
    expect(decoded).toBeNull();
  });
});
