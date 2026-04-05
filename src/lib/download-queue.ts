import type { DownloadBatchInputVideo } from "./types";

export type DownloadErrorClass = "transient" | "terminal";

const TRANSIENT_ERROR_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /net::/i,
  /navigation/i,
  /target closed/i,
  /session closed/i,
  /browser disconnected/i,
  /protocol error/i,
  /execution context was destroyed/i,
  /failed to fetch/i,
  /temporary/i,
  /too many requests/i,
  /rate limit/i,
  /captcha/i,
  /verify you are human/i,
  /download flow ran, but no hd mp4 url or file was captured/i,
  /download exceeded 60s timeout/i,
  /open page failed/i,
  /find format options failed/i,
  /find\/click download button failed/i,
  /could not find the download button on the page/i,
  /could not confirm the hd download/i,
  /invalid media candidate captured/i,
  /unexpected content type from source/i,
];

const TERMINAL_ERROR_PATTERNS = [
  /not logged in/i,
  /cookies may be expired or invalid/i,
  /no supported hd format/i,
  /file exceeds 100 mb limit/i,
  /failed to switch away from/i,
  /invalid localpath/i,
  /cached file not found/i,
];

export function classifyDownloadError(message: string): DownloadErrorClass {
  if (!message) return "transient";
  if (TERMINAL_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return "terminal";
  if (TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return "transient";
  return "terminal";
}

export function computeBackoffMs(
  attempt: number,
  baseDelayMs = 700,
  maxDelayMs = 6_000,
  jitterRatio = 0.25
) {
  const expDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(expDelay * jitterRatio * Math.random());
  return expDelay + jitter;
}

export function groupVideosByResultIndex(videos: DownloadBatchInputVideo[]) {
  const groups = new Map<number, DownloadBatchInputVideo[]>();

  for (const video of videos) {
    const key = video.resultIndex;
    const existing = groups.get(key);
    if (existing) existing.push(video);
    else groups.set(key, [video]);
  }

  return Array.from(groups.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([resultIndex, groupedVideos]) => ({
      resultIndex,
      videos: [...groupedVideos].sort((a, b) => a.slotIndex - b.slotIndex),
    }));
}

