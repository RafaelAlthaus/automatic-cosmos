import path from "node:path";
import { getDownloadProfile } from "@/lib/download-profiles";
import { groupVideosByResultIndex } from "@/lib/download-queue";
import { getDownloadUrlWithRetry, launchScraperBrowser, verifyLogin } from "@/lib/scraper";
import type {
  DownloadBatchEvent,
  DownloadBatchInputVideo,
  DownloadBatchSummary,
  DownloadProfileName,
  StoryblocksCookie,
} from "@/lib/types";

export const maxDuration = 3600;
const challengePattern = /too many requests|rate limit|captcha|verify you are human|temporarily blocked|challenge/i;
const criticalStopPattern =
  /too many requests|rate limit|captcha|verify you are human|temporarily blocked|challenge|timeout|timed out|not logged in|cookies may be expired|browser disconnected|target closed|protocol error/i;
const WATCHDOG_TIMEOUT_MS = 45_000;
const WATCHDOG_REPROCESS_MAX = 1;
const WATCHDOG_TIMEOUT_TOKEN = "__watchdog_timeout__" as const;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const toSequentialFilename = (sequenceIndex: number) => `${String(sequenceIndex).padStart(4, "0")}.mp4`;
const resolveSuggestedFilename = (video: DownloadBatchInputVideo) =>
  video.suggestedFilename || toSequentialFilename(video.sequenceIndex);
const isAutoReplaceableError = (msg: string) =>
  msg.includes("100 MB") || msg.includes("No supported HD format under 100 MB");

export async function POST(req: Request) {
  try {
    const {
      videos,
      cookies,
      profile,
      stopOnCriticalError,
    }: {
      videos: DownloadBatchInputVideo[];
      cookies: StoryblocksCookie[];
      profile?: DownloadProfileName;
      stopOnCriticalError?: boolean;
    } = await req.json();

    if (!videos?.length || !cookies?.length) {
      return Response.json({ error: "videos and cookies are required" }, { status: 400 });
    }
    const config = getDownloadProfile(profile);

    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let sequenceNumber = 0;
        let completed = 0;
        let failed = 0;
        let replaced = 0;
        let retriesUsed = 0;
        let adaptivePacingMs = config.basePacingMs;
        let recentIssueScore = 0;
        let stopRequested = false;
        let stopReason = "";
        let sharedBrowser: Awaited<ReturnType<typeof launchScraperBrowser>> | undefined;

        const sendLine = (payload: object) => {
          controller.enqueue(enc.encode(`${JSON.stringify(payload)}\n`));
        };
        const sendEvent = (event: Omit<DownloadBatchEvent, "sequenceNumber">) => {
          sequenceNumber += 1;
          sendLine({ ...event, sequenceNumber });
        };

        const orderedGroups = groupVideosByResultIndex(videos);
        const total = videos.length;
        const orderViolations = 0;

        try {
          sharedBrowser = await launchScraperBrowser();

          const loginCheck = await verifyLogin(sharedBrowser, cookies);
          if (!loginCheck.loggedIn) {
            sendEvent({
              status: "failed",
              error: `Login verification failed: ${loginCheck.error || "unknown"}`,
            });
            const summary: DownloadBatchSummary = {
              total,
              success: 0,
              failed: total,
              replaced: 0,
              retriesUsed: 0,
              orderViolations: 0,
            };
            sendEvent({ status: "summary", summary });
            return;
          }

          const orderedVideos = orderedGroups.flatMap((group) => group.videos);
          for (const video of orderedVideos) {
            const suggestedFilename = resolveSuggestedFilename(video);
            sendEvent({
              status: "queued",
              detailUrl: video.detailUrl,
              title: video.title,
              searchUrl: video.searchUrl,
              resultIndex: video.resultIndex,
              groupIndex: video.resultIndex,
              slotIndex: video.slotIndex,
              maxAttempts: config.maxAttempts,
              suggestedFilename,
            });
          }

          const prepareVideo = async (video: DownloadBatchInputVideo, groupIndex: number): Promise<void> => {
            if (stopRequested) {
              sendEvent({
                status: "failed",
                detailUrl: video.detailUrl,
                title: video.title,
                searchUrl: video.searchUrl,
                resultIndex: video.resultIndex,
                groupIndex,
                slotIndex: video.slotIndex,
                error: "Skipped due to critical-stop request",
              });
              failed += 1;
              return;
            }
            const suggestedFilename = resolveSuggestedFilename(video);
            const maxWatchdogAttempts = WATCHDOG_REPROCESS_MAX + 1;
            let watchdogAttempt = 1;

            const runDownloadAttempt = async () => {
              const attemptPromise = getDownloadUrlWithRetry(video.detailUrl, cookies, {
                sharedBrowser,
                maxAttempts: config.maxAttempts,
                baseDelayMs: config.retryBaseDelayMs,
                maxDelayMs: config.retryMaxDelayMs,
                captureTimeoutMs: config.captureTimeoutMs,
                downloadTimeoutMs: config.downloadTimeoutMs,
                loginVerified: true,
                onRetry: ({ attempt, maxAttempts, error, backoffMs }) => {
                  sendEvent({
                    status: "retrying",
                    detailUrl: video.detailUrl,
                    title: video.title,
                    searchUrl: video.searchUrl,
                    resultIndex: video.resultIndex,
                    groupIndex,
                    slotIndex: video.slotIndex,
                    attempt,
                    maxAttempts,
                    error,
                  });
                  retriesUsed += 1;
                  recentIssueScore += 1;
                  adaptivePacingMs = Math.min(config.maxPacingMs, adaptivePacingMs + Math.floor(backoffMs * 0.15));
                },
              });

              return await Promise.race([
                attemptPromise,
                delay(WATCHDOG_TIMEOUT_MS).then(() => WATCHDOG_TIMEOUT_TOKEN),
              ]);
            };

            while (watchdogAttempt <= maxWatchdogAttempts) {
              sendEvent({
                status: "running",
                detailUrl: video.detailUrl,
                title: video.title,
                searchUrl: video.searchUrl,
                resultIndex: video.resultIndex,
                groupIndex,
                slotIndex: video.slotIndex,
                attempt: watchdogAttempt,
                maxAttempts: maxWatchdogAttempts,
                suggestedFilename,
              });

              try {
                const runResult = await runDownloadAttempt();
                if (runResult === WATCHDOG_TIMEOUT_TOKEN) {
                  if (watchdogAttempt < maxWatchdogAttempts) {
                    sendEvent({
                      status: "retrying",
                      detailUrl: video.detailUrl,
                      title: video.title,
                      searchUrl: video.searchUrl,
                      resultIndex: video.resultIndex,
                      groupIndex,
                      slotIndex: video.slotIndex,
                      attempt: watchdogAttempt,
                      maxAttempts: maxWatchdogAttempts,
                      error: `Watchdog timeout after ${Math.floor(WATCHDOG_TIMEOUT_MS / 1000)}s. Reprocessing item...`,
                    });
                    retriesUsed += 1;
                    recentIssueScore += 1;
                    watchdogAttempt += 1;
                    await delay(250);
                    continue;
                  }

                  const watchdogErrorMessage = `Watchdog timeout after ${Math.floor(WATCHDOG_TIMEOUT_MS / 1000)}s. Max reprocess attempts reached.`;
                  sendEvent({
                    status: "failed",
                    detailUrl: video.detailUrl,
                    title: video.title,
                    searchUrl: video.searchUrl,
                    resultIndex: video.resultIndex,
                    groupIndex,
                    slotIndex: video.slotIndex,
                    attempt: watchdogAttempt,
                    maxAttempts: maxWatchdogAttempts,
                    error: watchdogErrorMessage,
                    suggestedFilename,
                  });
                  failed += 1;
                  return;
                }

                const result = runResult;
                const proxyUrl = result.localFilePath
                  ? `/api/proxy-file?localPath=${encodeURIComponent(result.localFilePath)}&filename=${encodeURIComponent(
                      suggestedFilename || result.filename || path.basename(result.localFilePath) || `${video.title || "video"}.mp4`
                    )}`
                  : undefined;

                if (result.error || (!result.downloadUrl && !proxyUrl)) {
                  const errorMessage = result.error || "Failed to obtain a download URL";
                  recentIssueScore += 1;
                  adaptivePacingMs = Math.min(config.maxPacingMs, adaptivePacingMs + 120);

                  if (isAutoReplaceableError(errorMessage) && video.replacements?.length) {
                    const originalError = errorMessage;
                    let replacementSucceeded = false;
                    for (const candidate of video.replacements) {
                      try {
                        const replResult = await getDownloadUrlWithRetry(candidate.detailUrl, cookies, {
                          sharedBrowser,
                          maxAttempts: config.maxAttempts,
                          baseDelayMs: config.retryBaseDelayMs,
                          maxDelayMs: config.retryMaxDelayMs,
                          captureTimeoutMs: config.captureTimeoutMs,
                          downloadTimeoutMs: config.downloadTimeoutMs,
                          loginVerified: true,
                        });
                        if (replResult.error) {
                          if (!isAutoReplaceableError(replResult.error)) break;
                          continue;
                        }
                        const replProxy = replResult.localFilePath
                          ? `/api/proxy-file?localPath=${encodeURIComponent(replResult.localFilePath)}&filename=${encodeURIComponent(
                              suggestedFilename || replResult.filename || `${candidate.title || "video"}.mp4`
                            )}`
                          : undefined;
                        if (!replResult.downloadUrl && !replProxy) continue;

                        sendEvent({
                          status: "done",
                          detailUrl: candidate.detailUrl,
                          title: candidate.title,
                          searchUrl: video.searchUrl,
                          resultIndex: video.resultIndex,
                          groupIndex,
                          slotIndex: video.slotIndex,
                          attempt: replResult.attemptsUsed,
                          maxAttempts: config.maxAttempts,
                          downloadUrl: replResult.downloadUrl || undefined,
                          proxyUrl: replProxy,
                          loggedIn: replResult.loggedIn,
                          suggestedFilename,
                          replacedWith: candidate,
                          originalError,
                        });
                        completed += 1;
                        replaced += 1;
                        replacementSucceeded = true;
                        break;
                      } catch {
                        continue;
                      }
                    }
                    if (replacementSucceeded) return;
                  }

                  if (challengePattern.test(errorMessage)) {
                    sendEvent({
                      status: "retrying",
                      detailUrl: video.detailUrl,
                      title: video.title,
                      searchUrl: video.searchUrl,
                      resultIndex: video.resultIndex,
                      groupIndex,
                      slotIndex: video.slotIndex,
                      error: `Cooldown after challenge/rate-limit signal (${config.challengeCooldownMs}ms)`,
                    });
                    await delay(config.challengeCooldownMs);
                  }
                  if (stopOnCriticalError && criticalStopPattern.test(errorMessage)) {
                    stopRequested = true;
                    stopReason = `Stopped after critical error on ${video.title || video.detailUrl}: ${errorMessage}`;
                  }
                  sendEvent({
                    status: "failed",
                    detailUrl: video.detailUrl,
                    title: video.title,
                    searchUrl: video.searchUrl,
                    resultIndex: video.resultIndex,
                    groupIndex,
                    slotIndex: video.slotIndex,
                    attempt: result.attemptsUsed,
                    maxAttempts: config.maxAttempts,
                    error: errorMessage,
                    loggedIn: result.loggedIn,
                    suggestedFilename,
                  });
                  failed += 1;
                  return;
                }

                recentIssueScore = Math.max(0, recentIssueScore - 1);
                const successDecay = config.name === "fast" ? 60 : 30;
                adaptivePacingMs = Math.max(config.basePacingMs, adaptivePacingMs - successDecay);
                sendEvent({
                  status: "done",
                  detailUrl: video.detailUrl,
                  title: video.title,
                  searchUrl: video.searchUrl,
                  resultIndex: video.resultIndex,
                  groupIndex,
                  slotIndex: video.slotIndex,
                  attempt: result.attemptsUsed,
                  maxAttempts: config.maxAttempts,
                  downloadUrl: result.downloadUrl || undefined,
                  proxyUrl,
                  loggedIn: result.loggedIn,
                  suggestedFilename,
                });
                completed += 1;
                return;
              } catch (err) {
                const errMessage = err instanceof Error ? err.message : String(err);
                recentIssueScore += 1;
                adaptivePacingMs = Math.min(config.maxPacingMs, adaptivePacingMs + 150);

                if (isAutoReplaceableError(errMessage) && video.replacements?.length) {
                  let replacementSucceeded = false;
                  for (const candidate of video.replacements) {
                    try {
                      const replResult = await getDownloadUrlWithRetry(candidate.detailUrl, cookies, {
                        sharedBrowser,
                        maxAttempts: config.maxAttempts,
                        baseDelayMs: config.retryBaseDelayMs,
                        maxDelayMs: config.retryMaxDelayMs,
                        captureTimeoutMs: config.captureTimeoutMs,
                        downloadTimeoutMs: config.downloadTimeoutMs,
                        loginVerified: true,
                      });
                      if (replResult.error) {
                        if (!isAutoReplaceableError(replResult.error)) break;
                        continue;
                      }
                      const replProxy = replResult.localFilePath
                        ? `/api/proxy-file?localPath=${encodeURIComponent(replResult.localFilePath)}&filename=${encodeURIComponent(
                            suggestedFilename || replResult.filename || `${candidate.title || "video"}.mp4`
                          )}`
                        : undefined;
                      if (!replResult.downloadUrl && !replProxy) continue;
                      sendEvent({
                        status: "done",
                        detailUrl: candidate.detailUrl,
                        title: candidate.title,
                        searchUrl: video.searchUrl,
                        resultIndex: video.resultIndex,
                        groupIndex,
                        slotIndex: video.slotIndex,
                        downloadUrl: replResult.downloadUrl || undefined,
                        proxyUrl: replProxy,
                        loggedIn: replResult.loggedIn,
                        suggestedFilename,
                        replacedWith: candidate,
                        originalError: errMessage,
                      });
                      completed += 1;
                      replaced += 1;
                      replacementSucceeded = true;
                      break;
                    } catch {
                      continue;
                    }
                  }
                  if (replacementSucceeded) return;
                }

                if (challengePattern.test(errMessage)) {
                  sendEvent({
                    status: "retrying",
                    detailUrl: video.detailUrl,
                    title: video.title,
                    searchUrl: video.searchUrl,
                    resultIndex: video.resultIndex,
                    groupIndex,
                    slotIndex: video.slotIndex,
                    error: `Cooldown after challenge/rate-limit signal (${config.challengeCooldownMs}ms)`,
                  });
                  await delay(config.challengeCooldownMs);
                }
                if (stopOnCriticalError && criticalStopPattern.test(errMessage)) {
                  stopRequested = true;
                  stopReason = `Stopped after critical error on ${video.title || video.detailUrl}: ${errMessage}`;
                }
                sendEvent({
                  status: "failed",
                  detailUrl: video.detailUrl,
                  title: video.title,
                  searchUrl: video.searchUrl,
                  resultIndex: video.resultIndex,
                  groupIndex,
                  slotIndex: video.slotIndex,
                  error: errMessage,
                  maxAttempts: config.maxAttempts,
                });
                failed += 1;
                return;
              }
            }
          };

          let nextVideoIndex = 0;
          const workerCount = Math.max(1, config.groupConcurrency);
          const workers = Array.from({ length: workerCount }, async () => {
            while (true) {
              if (stopRequested && stopOnCriticalError) return;
              const currentIndex = nextVideoIndex;
              nextVideoIndex += 1;
              if (currentIndex >= orderedVideos.length) return;
              const video = orderedVideos[currentIndex];
              await prepareVideo(video, video.resultIndex);
            }
          });
          await Promise.all(workers);

          const summary: DownloadBatchSummary = {
            total,
            success: completed,
            failed,
            replaced,
            retriesUsed,
            orderViolations,
            stopped: stopRequested,
            stopReason: stopReason || undefined,
          };
          sendEvent({ status: "summary", summary });
        } catch (err) {
          const summary: DownloadBatchSummary = {
            total,
            success: completed,
            failed,
            replaced,
            retriesUsed,
            orderViolations,
          };
          sendEvent({
            status: "failed",
            error: `Batch startup failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          sendEvent({ status: "summary", summary });
        } finally {
          await sharedBrowser?.close().catch(() => {});
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    return Response.json(
      { error: `Batch route failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
