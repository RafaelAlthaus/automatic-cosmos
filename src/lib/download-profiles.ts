import type { DownloadProfileName } from "./types";

export type DownloadProfileConfig = {
  name: DownloadProfileName;
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  basePacingMs: number;
  maxPacingMs: number;
  challengeCooldownMs: number;
  captureTimeoutMs: number;
  downloadTimeoutMs: number;
  groupLookahead: number;
  groupConcurrency: number;
};

export const DOWNLOAD_PROFILES: Record<DownloadProfileName, DownloadProfileConfig> = {
  fast: {
    name: "fast",
    maxAttempts: 3,
    retryBaseDelayMs: 350,
    retryMaxDelayMs: 2_200,
    basePacingMs: 70,
    maxPacingMs: 450,
    challengeCooldownMs: 2_500,
    captureTimeoutMs: 10_000,
    downloadTimeoutMs: 18_000,
    groupLookahead: 2,
    groupConcurrency: 10,
  },
  balanced: {
    name: "balanced",
    maxAttempts: 3,
    retryBaseDelayMs: 300,
    retryMaxDelayMs: 1_600,
    basePacingMs: 90,
    maxPacingMs: 450,
    challengeCooldownMs: 3_000,
    captureTimeoutMs: 10_000,
    downloadTimeoutMs: 18_000,
    groupLookahead: 2,
    groupConcurrency: 6,
  },
  safe: {
    name: "safe",
    maxAttempts: 4,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 10_000,
    basePacingMs: 420,
    maxPacingMs: 1_800,
    challengeCooldownMs: 12_000,
    captureTimeoutMs: 24_000,
    downloadTimeoutMs: 40_000,
    groupLookahead: 1,
    groupConcurrency: 1,
  },
  serial: {
    name: "serial",
    maxAttempts: 2,
    retryBaseDelayMs: 180,
    retryMaxDelayMs: 700,
    basePacingMs: 0,
    maxPacingMs: 80,
    challengeCooldownMs: 1_500,
    captureTimeoutMs: 10_000,
    downloadTimeoutMs: 18_000,
    groupLookahead: 1,
    groupConcurrency: 1,
  },
  teste: {
    name: "teste",
    maxAttempts: 2,
    retryBaseDelayMs: 180,
    retryMaxDelayMs: 700,
    basePacingMs: 0,
    maxPacingMs: 80,
    challengeCooldownMs: 1_500,
    captureTimeoutMs: 10_000,
    downloadTimeoutMs: 18_000,
    groupLookahead: 1,
    groupConcurrency: 1,
  },
};

export function getDownloadProfile(profile?: string): DownloadProfileConfig {
  if (!profile) return DOWNLOAD_PROFILES.balanced;
  if (profile === "fast" || profile === "balanced" || profile === "safe" || profile === "serial" || profile === "teste") {
    return DOWNLOAD_PROFILES[profile];
  }
  return DOWNLOAD_PROFILES.balanced;
}

