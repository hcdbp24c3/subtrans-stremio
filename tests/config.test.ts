import { describe, it, expect, afterEach } from 'vitest';
import {
  encodeConfig, decodeConfig, AddonConfig,
  resolveTranslateProvider, resolveTranslateKey,
  resolveTranslateBaseUrl, resolveTranslateModel,
} from '../src/config.js';

const baseConfig: AddonConfig = {
  streamUrls: ['https://example.com/stream/manifest.json'],
  subUrls: ['https://example.com/sub/manifest.json'],
  languages: '',
  translateProvider: '',
  translateKey: '',
  translateBaseUrl: '',
  translateModel: '',
  translateTargets: [],
};

describe('config', () => {
  it('encodes and decodes single addon roundtrip', () => {
    const encoded = encodeConfig(baseConfig);
    const decoded = decodeConfig(encoded);
    expect(decoded).toEqual(baseConfig);
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
      translateProvider: '',
      translateKey: '',
      translateBaseUrl: '',
      translateModel: '',
      translateTargets: [],
    };
    const encoded = encodeConfig(config);
    const decoded = decodeConfig(encoded);
    expect(decoded).toEqual(config);
  });

  it('encodes and decodes translate config (provider + key + baseUrl + model + targets)', () => {
    const config: AddonConfig = {
      ...baseConfig,
      translateProvider: 'openai',
      translateKey: 'sk-test',
      translateBaseUrl: 'https://api.openai.com',
      translateModel: 'gpt-4o-mini',
      translateTargets: ['vi', 'ja'],
    };
    const encoded = encodeConfig(config);
    const decoded = decodeConfig(encoded);
    expect(decoded).toEqual(config);
  });

  it('uses short param names to keep URL compact', () => {
    const encoded = encodeConfig({
      ...baseConfig,
      translateProvider: 'openai',
      translateKey: 'k',
      translateTargets: ['vi'],
    });
    expect(encoded).toContain('tp=openai');
    expect(encoded).toContain('tk=k');
    expect(encoded).toContain('translate=vi');
  });

  it('omits translate fields when empty (URL size economy)', () => {
    const encoded = encodeConfig(baseConfig);
    expect(encoded).not.toContain('tp=');
    expect(encoded).not.toContain('tk=');
    expect(encoded).not.toContain('tbu=');
    expect(encoded).not.toContain('tm=');
    expect(encoded).not.toContain('translate=');
  });

  it('preserves translateTargets order', () => {
    const config: AddonConfig = {
      ...baseConfig,
      translateTargets: ['ja', 'vi', 'ko', 'zh'],
    };
    const encoded = encodeConfig(config);
    const decoded = decodeConfig(encoded);
    expect(decoded?.translateTargets).toEqual(['ja', 'vi', 'ko', 'zh']);
  });

  it('filters empty translate target entries on decode', () => {
    const encoded = encodeConfig({
      ...baseConfig,
      translateTargets: ['vi', '', '  ', 'ja'],
    });
    const decoded = decodeConfig(encoded);
    expect(decoded?.translateTargets).toEqual(['vi', 'ja']);
  });

  it('returns null for invalid encoded string', () => {
    expect(decodeConfig('garbage')).toBeNull();
  });

  it('returns null for empty streamUrls', () => {
    const encoded = encodeConfig({ ...baseConfig, streamUrls: [] });
    expect(decodeConfig(encoded)).toBeNull();
  });

  it('returns null for empty subUrls', () => {
    const encoded = encodeConfig({ ...baseConfig, subUrls: [] });
    expect(decodeConfig(encoded)).toBeNull();
  });

  it('preserves URL order', () => {
    const urls = ['https://a.com', 'https://b.com', 'https://c.com'];
    const config: AddonConfig = {
      ...baseConfig,
      streamUrls: urls,
    };
    const encoded = encodeConfig(config);
    const decoded = decodeConfig(encoded);
    expect(decoded?.streamUrls).toEqual(urls);
  });
});

describe('resolveTranslateProvider', () => {
  const originalEnv = process.env.TRANSLATE_PROVIDER;
  afterEach(() => { process.env.TRANSLATE_PROVIDER = originalEnv; });

  it('prefers config over env', () => {
    process.env.TRANSLATE_PROVIDER = 'deepl';
    expect(resolveTranslateProvider({ ...baseConfig, translateProvider: 'openai' }))
      .toBe('openai');
  });

  it('falls back to env when config is empty', () => {
    process.env.TRANSLATE_PROVIDER = 'google';
    expect(resolveTranslateProvider(baseConfig)).toBe('google');
  });

  it('returns null when neither is set', () => {
    delete process.env.TRANSLATE_PROVIDER;
    expect(resolveTranslateProvider(baseConfig)).toBeNull();
  });
});

describe('resolveTranslateKey', () => {
  const originalGeneric = process.env.TRANSLATE_KEY;
  const originalGoogle = process.env.TRANSLATE_GOOGLE_KEY;
  afterEach(() => {
    process.env.TRANSLATE_KEY = originalGeneric;
    process.env.TRANSLATE_GOOGLE_KEY = originalGoogle;
  });

  it('prefers config key', () => {
    process.env.TRANSLATE_KEY = 'env-key';
    expect(resolveTranslateKey({ ...baseConfig, translateKey: 'config-key' }, 'google'))
      .toBe('config-key');
  });

  it('falls back to generic TRANSLATE_KEY env', () => {
    process.env.TRANSLATE_KEY = 'env-key';
    delete process.env.TRANSLATE_GOOGLE_KEY;
    expect(resolveTranslateKey(baseConfig, 'google')).toBe('env-key');
  });

  it('falls back to provider-specific env', () => {
    delete process.env.TRANSLATE_KEY;
    process.env.TRANSLATE_GOOGLE_KEY = 'google-key';
    expect(resolveTranslateKey(baseConfig, 'google')).toBe('google-key');
  });

  it('returns undefined when no key configured', () => {
    delete process.env.TRANSLATE_KEY;
    delete process.env.TRANSLATE_GOOGLE_KEY;
    expect(resolveTranslateKey(baseConfig, 'google')).toBeUndefined();
  });
});

describe('resolveTranslateBaseUrl / resolveTranslateModel', () => {
  it('falls back to env', () => {
    const originalBase = process.env.TRANSLATE_BASE_URL;
    const originalModel = process.env.TRANSLATE_MODEL;
    process.env.TRANSLATE_BASE_URL = 'http://ollama.local:11434';
    process.env.TRANSLATE_MODEL = 'qwen2.5:7b';
    try {
      expect(resolveTranslateBaseUrl(baseConfig)).toBe('http://ollama.local:11434');
      expect(resolveTranslateModel(baseConfig)).toBe('qwen2.5:7b');
    } finally {
      process.env.TRANSLATE_BASE_URL = originalBase;
      process.env.TRANSLATE_MODEL = originalModel;
    }
  });

  it('returns undefined when neither config nor env is set', () => {
    const originalBase = process.env.TRANSLATE_BASE_URL;
    const originalModel = process.env.TRANSLATE_MODEL;
    delete process.env.TRANSLATE_BASE_URL;
    delete process.env.TRANSLATE_MODEL;
    try {
      expect(resolveTranslateBaseUrl(baseConfig)).toBeUndefined();
      expect(resolveTranslateModel(baseConfig)).toBeUndefined();
    } finally {
      process.env.TRANSLATE_BASE_URL = originalBase;
      process.env.TRANSLATE_MODEL = originalModel;
    }
  });
});
