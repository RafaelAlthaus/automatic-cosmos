export interface StoryblocksCookie {
  domain: string;
  name: string;
  value: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  expirationDate?: number;
  hostOnly?: boolean;
  session?: boolean;
  storeId?: string;
}

export interface VideoInfo {
  title: string;
  thumbnail: string;
  detailUrl: string;
  previewVideoUrl: string;
}

export interface SearchResult {
  searchUrl: string;
  videos: VideoInfo[];
}

export interface ScrapeError {
  url: string;
  videoUrl?: string;
  error: string;
}

export interface ProgressEvent {
  type: "progress" | "result" | "error" | "done";
  message?: string;
  data?: SearchResult | ScrapeError | { results: SearchResult[]; errors: ScrapeError[] };
}

export interface ReplacementCandidate {
  detailUrl: string;
  title: string;
  originalIndex: number;
}

export interface DownloadBatchInputVideo {
  detailUrl: string;
  title: string;
  searchUrl: string;
  resultIndex: number;
  slotIndex: number;
  sequenceIndex: number;
  suggestedFilename?: string;
  replacements?: ReplacementCandidate[];
}

export type DownloadProfileName = "fast" | "balanced" | "safe" | "serial" | "teste";

export type DownloadBatchStatus = "queued" | "running" | "retrying" | "done" | "failed" | "summary";

export interface DownloadBatchSummary {
  total: number;
  success: number;
  failed: number;
  replaced: number;
  retriesUsed: number;
  orderViolations: number;
  stopped?: boolean;
  stopReason?: string;
}

export interface DownloadBatchEvent {
  status: DownloadBatchStatus;
  sequenceNumber: number;
  groupIndex?: number;
  slotIndex?: number;
  detailUrl?: string;
  title?: string;
  searchUrl?: string;
  resultIndex?: number;
  attempt?: number;
  maxAttempts?: number;
  downloadUrl?: string;
  proxyUrl?: string;
  suggestedFilename?: string;
  error?: string;
  loggedIn?: boolean;
  summary?: DownloadBatchSummary;
  replacedWith?: ReplacementCandidate;
  originalError?: string;
}
