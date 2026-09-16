import ffmpeg from 'fluent-ffmpeg';

export interface SubtitleEntry {
  start: number;
  end: number;
  text: string;
}

const OFFSET_THRESHOLD = 0.5; // seconds — ignore offsets smaller than this

export function getVideoDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(url, (err, metadata) => {
      if (err || !metadata?.format?.duration) {
        resolve(null);
        return;
      }
      resolve(metadata.format.duration);
    });
  });
}

export function calculateOffset(
  entries: SubtitleEntry[],
  videoDuration: number
): number {
  if (entries.length === 0 || videoDuration <= 0) return 0;

  const minStart = Math.min(...entries.map((e) => e.start));
  const maxEnd = Math.max(...entries.map((e) => e.end));
  const subRange = maxEnd - minStart;

  const rawOffset = videoDuration - subRange;

  // Ignore tiny offsets (likely not a real mismatch)
  if (Math.abs(rawOffset) < OFFSET_THRESHOLD) return 0;

  return rawOffset;
}

export function adjustEntries(
  entries: SubtitleEntry[],
  offset: number
): SubtitleEntry[] {
  return entries.map((e) => ({
    start: Math.max(0, e.start + offset),
    end: Math.max(0, e.end + offset),
    text: e.text,
  }));
}
