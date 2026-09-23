export type SubtitleFormat = 'srt' | 'vtt' | 'ass';

export interface SubtitleEntry {
  start: number;
  end: number;
  text: string;
}

export function detectFormat(filename: string): SubtitleFormat | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'srt') return 'srt';
  if (ext === 'vtt') return 'vtt';
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  return null;
}

/**
 * Detect format from content first, then extension hint.
 * OpenSubtitles URLs often lack a file extension — sniff [Script Info]/Dialogue
 * so ASS is never mistaken for SRT (Nuvio's Android ICU regex crashes on ASS).
 */
export function sniffFormat(content: string, extHint?: string | null): SubtitleFormat | null {
  const head = content.replace(/^﻿/, '').slice(0, 1024);
  if (head.includes('[Script Info]') || /^\s*Dialogue:/m.test(content)) return 'ass';
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (extHint === 'ass' || extHint === 'ssa') return 'ass';
  if (extHint === 'srt' || extHint === 'vtt') return extHint;
  if (content.includes('-->')) return 'srt';
  return null;
}

export function parseSrtTime(time: string): number {
  const match = time.trim().match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) return 0;
  const [, hh, mm, ss, mmm] = match;
  return parseInt(hh) * 3600 + parseInt(mm) * 60 + parseInt(ss) + parseInt(mmm) / 1000;
}

export function parseVttTime(time: string): number {
  const t = time.trim();
  const matchHH = t.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
  if (matchHH) {
    const [, hh, mm, ss, mmm] = matchHH;
    return parseInt(hh) * 3600 + parseInt(mm) * 60 + parseInt(ss) + parseInt(mmm) / 1000;
  }
  const matchMM = t.match(/(\d{2}):(\d{2})\.(\d{3})/);
  if (matchMM) {
    const [, mm, ss, mmm] = matchMM;
    return parseInt(mm) * 60 + parseInt(ss) + parseInt(mmm) / 1000;
  }
  return 0;
}

export function parseAssTime(time: string): number {
  const match = time.trim().match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
  if (!match) return 0;
  const [, h, mm, ss, cs] = match;
  return parseInt(h) * 3600 + parseInt(mm) * 60 + parseInt(ss) + parseInt(cs) / 100;
}

export function parseSrt(content: string): SubtitleEntry[] {
  const entries: SubtitleEntry[] = [];
  const blocks = content.trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const arrowLine = lines.findIndex(l => l.includes('-->'));
    if (arrowLine === -1) continue;
    const parts = lines[arrowLine].split('-->');
    if (parts.length < 2) continue;
    const start = parseSrtTime(parts[0]);
    const end = parseSrtTime(parts[1]);
    const text = lines.slice(arrowLine + 1).join('\n').trim();
    if (text) entries.push({ start, end, text });
  }
  return entries;
}

export function parseVtt(content: string): SubtitleEntry[] {
  const lines = content.split('\n');
  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('-->')) {
      startIdx = i;
      break;
    }
  }
  const body = lines.slice(startIdx).join('\n');
  return parseSrt(body);
}

export function parseAss(content: string): SubtitleEntry[] {
  const entries: SubtitleEntry[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    if (!line.startsWith('Dialogue:')) continue;
    const afterDialogue = line.substring('Dialogue:'.length).trim();
    const fields = afterDialogue.split(',');
    if (fields.length < 10) continue;
    const start = parseAssTime(fields[1]);
    const end = parseAssTime(fields[2]);
    const textRaw = fields.slice(9).join(',');
    const text = textRaw.replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n').replace(/\\n/g, '\n').trim();
    if (text) entries.push({ start, end, text });
  }
  return entries;
}

export function parseSubtitle(content: string, format: SubtitleFormat): SubtitleEntry[] {
  switch (format) {
    case 'srt': return parseSrt(content);
    case 'vtt': return parseVtt(content);
    case 'ass': return parseAss(content);
    default: return [];
  }
}
