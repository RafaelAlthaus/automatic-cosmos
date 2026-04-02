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
