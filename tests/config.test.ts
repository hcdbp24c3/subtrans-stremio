import { describe, it, expect } from 'vitest';
import { encodeConfig, decodeConfig, AddonConfig } from '../src/config.js';

describe('config', () => {
  const sampleConfig: AddonConfig = {
    streamUrls: ['https://example.com/stream/manifest.json'],
    subUrls: ['https://example.com/sub/manifest.json'],
    languages: '',
  };

  it('encodes and decodes single addon roundtrip', () => {
    const encoded = encodeConfig(sampleConfig);
    const decoded = decodeConfig(encoded);
    expect(decoded).toEqual(sampleConfig);
  });

  it('encodes and decodes multiple addons', () => {
    const config: AddonConfig = {
      streamUrls: [
        'https://addon1.com/manifest.json',
        'https://addon2.com/manifest.json',
      ],
      subUrls: [
        'https://sub1.com/manifest.json',
        'https://sub2.com/manifest.json',
        'https://sub3.com/manifest.json',
      ],
      languages: 'en,vi',
    };
    const encoded = encodeConfig(config);
    const decoded = decodeConfig(encoded);
    expect(decoded).toEqual(config);
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

  it('returns null for empty streamUrls', () => {
    const encoded = encodeConfig({
      streamUrls: [],
      subUrls: ['https://example.com/sub/manifest.json'],
      languages: '',
    });
    expect(decodeConfig(encoded)).toBeNull();
  });

  it('returns null for empty subUrls', () => {
    const encoded = encodeConfig({
      streamUrls: ['https://example.com/stream/manifest.json'],
      subUrls: [],
      languages: '',
    });
    expect(decodeConfig(encoded)).toBeNull();
  });

  it('preserves URL order', () => {
    const urls = ['https://a.com', 'https://b.com', 'https://c.com'];
    const config: AddonConfig = {
      streamUrls: urls,
      subUrls: ['https://sub.com'],
      languages: '',
    };
    const encoded = encodeConfig(config);
    const decoded = decodeConfig(encoded);
    expect(decoded?.streamUrls).toEqual(urls);
  });
});
