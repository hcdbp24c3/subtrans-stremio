import { describe, it, expect, afterEach } from 'vitest';
import {
  encodeConfig, decodeConfig, AddonConfig,
  resolveLingarrUrl, resolveLingarrApiKey,
} from '../src/config.js';

describe('config', () => {
  const sampleConfig: AddonConfig = {
    streamUrls: ['https://example.com/stream/manifest.json'],
    subUrls: ['https://example.com/sub/manifest.json'],
    languages: '',
    lingarrUrl: '',
    lingarrApiKey: '',
    translateTargets: [],
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
      lingarrUrl: '',
      lingarrApiKey: '',
      translateTargets: [],
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

  it('encodes and decodes lingarr config (url + key + targets)', () => {
    const config: AddonConfig = {
      ...sampleConfig,
      lingarrUrl: 'http://lingarr.local:9876',
      lingarrApiKey: 'sk-test-1234',
      translateTargets: ['vi', 'ja', 'ko'],
    };
    const encoded = encodeConfig(config);
    const decoded = decodeConfig(encoded);
    expect(decoded).toEqual(config);
  });

  it('omits lingarr fields when empty (URL size economy)', () => {
    const encoded = encodeConfig(sampleConfig);
    expect(encoded).not.toContain('lingarr=');
    expect(encoded).not.toContain('lingarrKey=');
    expect(encoded).not.toContain('translate=');
    const decoded = decodeConfig(encoded);
    expect(decoded?.lingarrUrl).toBe('');
    expect(decoded?.lingarrApiKey).toBe('');
    expect(decoded?.translateTargets).toEqual([]);
  });

  it('preserves translateTargets order', () => {
    const config: AddonConfig = {
      ...sampleConfig,
      translateTargets: ['ja', 'vi', 'ko', 'zh'],
    };
    const encoded = encodeConfig(config);
    const decoded = decodeConfig(encoded);
    expect(decoded?.translateTargets).toEqual(['ja', 'vi', 'ko', 'zh']);
  });

  it('filters empty translate target entries on decode', () => {
    const encoded = encodeConfig({
      ...sampleConfig,
      translateTargets: ['vi', '', '  ', 'ja'],
    });
    const decoded = decodeConfig(encoded);
    expect(decoded?.translateTargets).toEqual(['vi', 'ja']);
  });

  it('returns null for invalid encoded string', () => {
    expect(decodeConfig('garbage')).toBeNull();
  });

  it('returns null for empty streamUrls', () => {
    const encoded = encodeConfig({
      streamUrls: [],
      subUrls: ['https://example.com/sub/manifest.json'],
      languages: '',
      lingarrUrl: '',
      lingarrApiKey: '',
      translateTargets: [],
    });
    expect(decodeConfig(encoded)).toBeNull();
  });

  it('returns null for empty subUrls', () => {
    const encoded = encodeConfig({
      streamUrls: ['https://example.com/stream/manifest.json'],
      subUrls: [],
      languages: '',
      lingarrUrl: '',
      lingarrApiKey: '',
      translateTargets: [],
    });
    expect(decodeConfig(encoded)).toBeNull();
  });

  it('preserves URL order', () => {
    const urls = ['https://a.com', 'https://b.com', 'https://c.com'];
    const config: AddonConfig = {
      streamUrls: urls,
      subUrls: ['https://sub.com'],
      languages: '',
      lingarrUrl: '',
      lingarrApiKey: '',
      translateTargets: [],
    };
    const encoded = encodeConfig(config);
    const decoded = decodeConfig(encoded);
    expect(decoded?.streamUrls).toEqual(urls);
  });
});

describe('resolveLingarrUrl', () => {
  const originalEnv = process.env.LINGARR_URL;
  afterEach(() => { process.env.LINGARR_URL = originalEnv; });

  it('prefers config.lingarrUrl over env', () => {
    process.env.LINGARR_URL = 'http://env-host:9876';
    expect(resolveLingarrUrl({
      streamUrls: [], subUrls: [], languages: '',
      lingarrUrl: 'http://config-host:9876',
      lingarrApiKey: '', translateTargets: [],
    })).toBe('http://config-host:9876');
  });

  it('falls back to env when config is empty', () => {
    process.env.LINGARR_URL = 'http://env-host:9876';
    expect(resolveLingarrUrl({
      streamUrls: [], subUrls: [], languages: '',
      lingarrUrl: '', lingarrApiKey: '', translateTargets: [],
    })).toBe('http://env-host:9876');
  });

  it('returns null when neither is set', () => {
    delete process.env.LINGARR_URL;
    expect(resolveLingarrUrl({
      streamUrls: [], subUrls: [], languages: '',
      lingarrUrl: '', lingarrApiKey: '', translateTargets: [],
    })).toBeNull();
  });

  it('strips trailing slashes from config URL', () => {
    process.env.LINGARR_URL = '';
    expect(resolveLingarrUrl({
      streamUrls: [], subUrls: [], languages: '',
      lingarrUrl: 'http://h:9876///',
      lingarrApiKey: '', translateTargets: [],
    })).toBe('http://h:9876');
  });
});

describe('resolveLingarrApiKey', () => {
  const originalEnv = process.env.LINGARR_API_KEY;
  afterEach(() => { process.env.LINGARR_API_KEY = originalEnv; });

  it('prefers config key over env', () => {
    process.env.LINGARR_API_KEY = 'env-key';
    expect(resolveLingarrApiKey({
      streamUrls: [], subUrls: [], languages: '',
      lingarrUrl: '', lingarrApiKey: 'config-key', translateTargets: [],
    })).toBe('config-key');
  });

  it('falls back to env when config is empty', () => {
    process.env.LINGARR_API_KEY = 'env-key';
    expect(resolveLingarrApiKey({
      streamUrls: [], subUrls: [], languages: '',
      lingarrUrl: '', lingarrApiKey: '', translateTargets: [],
    })).toBe('env-key');
  });

  it('returns undefined when neither is set', () => {
    delete process.env.LINGARR_API_KEY;
    expect(resolveLingarrApiKey({
      streamUrls: [], subUrls: [], languages: '',
      lingarrUrl: '', lingarrApiKey: '', translateTargets: [],
    })).toBeUndefined();
  });
});
