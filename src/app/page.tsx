"use client";

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import Link from "next/link";
import type {
  DownloadBatchEvent,
  DownloadBatchInputVideo,
  DownloadProfileName,
  DownloadBatchSummary,
  ProgressEvent,
  ReplacementCandidate,
  ScrapeError,
  SearchResult,
  StoryblocksCookie,
  VideoInfo,
} from "@/lib/types";

type VideoSlot = { video: VideoInfo; originalIndex: number };
type DownloadError = {
  videoUrl: string;
  searchUrl: string;
  error: string;
  title?: string;
  suggestedFilename?: string;
  resultIndex?: number;
  slotIndex?: number;
  replacedWith?: ReplacementCandidate;
  originalError?: string;
  kind: "failure" | "replaced";
};
type DownloadCheckpoint = {
  signature: string;
  nextIndex: number;
  total: number;
  updatedAt: number;
};

const DOWNLOAD_CHECKPOINT_BASE_KEY = "automatic-cosmos.download-checkpoint.v1";
const generateSessionId = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
const CLIENT_DOWNLOAD_CONCURRENCY: Record<DownloadProfileName, number> = {
  fast: 10,
  balanced: 6,
  safe: 1,
  serial: 1,
  teste: 1,
};

const createBatchSignature = (videos: DownloadBatchInputVideo[], profile: DownloadProfileName) =>
  videos
    .map(
      (video) =>
        `${video.searchUrl}|${video.resultIndex}|${video.slotIndex}|${video.detailUrl}|${video.suggestedFilename || ""}`
    )
    .join("::") + `::profile=${profile}`;

export default function Home() {
  const [cookiesJson, setCookiesJson] = useState("");
  const [urls, setUrls] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [errors, setErrors] = useState<ScrapeError[]>([]);
  const [downloadErrors, setDownloadErrors] = useState<DownloadError[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-select state
  const [autoSelect, setAutoSelect] = useState(true);
  const [videosPerLink, setVideosPerLink] = useState(2);
  const [autoSelectedSlots, setAutoSelectedSlots] = useState<VideoSlot[][]>([]);
  const [autoSelectIndex, setAutoSelectIndex] = useState(0);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [downloadProfile, setDownloadProfile] = useState<DownloadProfileName>("balanced");
  const [stopOnCriticalError, setStopOnCriticalError] = useState(true);
  const [reScrapingIndex, setReScrapingIndex] = useState<number | null>(null);
  const [sessionPrefix, setSessionPrefix] = useState("A");
  const [mounted, setMounted] = useState(false);
  const checkpointKey = useMemo(() => `${DOWNLOAD_CHECKPOINT_BASE_KEY}.${sessionPrefix}`, [sessionPrefix]);

  useEffect(() => {
    setSessionPrefix(generateSessionId());
    setMounted(true);
  }, []);
  const [downloadAllProgress, setDownloadAllProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchSummary, setBatchSummary] = useState<DownloadBatchSummary | null>(null);
  const [orderAudit, setOrderAudit] = useState<{ lastSequence: number; violations: number }>({
    lastSequence: 0,
    violations: 0,
  });

  const toDownloadFilename = useCallback((title: string) => {
    const safeBase = title.slice(0, 50).replace(/[^a-zA-Z0-9]/g, "_") || "video";
    return `${safeBase}.mp4`;
  }, []);

  const triggerBrowserDownload = useCallback(async (href: string, suggestedName?: string) => {
    const link = document.createElement("a");
    link.href = href;
    if (suggestedName) link.download = suggestedName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    const postClickDelayMs =
      downloadProfile === "safe" ? 650 :
      downloadProfile === "teste" ? 500 :
      downloadProfile === "balanced" ? 220 :
      downloadProfile === "serial" ? 40 :
      140;
    await new Promise((resolve) => setTimeout(resolve, postClickDelayMs));
  }, [downloadProfile]);

  const downloadViaAppRoute = useCallback(
    async (href: string, suggestedName: string) => {
      // Prefer direct browser download to avoid buffering files into JS memory.
      await triggerBrowserDownload(href, suggestedName);
    },
    [triggerBrowserDownload]
  );

  const downloadVideoFromDetail = useCallback(
    async (detailUrl: string, title: string, forcedFilename?: string) => {
      let parsedCookies: StoryblocksCookie[];
      try {
        parsedCookies = JSON.parse(cookiesJson);
      } catch {
        throw new Error("Invalid cookies JSON");
      }

      const response = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ detailUrl, cookies: parsedCookies, profile: downloadProfile }),
      });
      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("video/mp4")) {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        try {
          await triggerBrowserDownload(url, forcedFilename || toDownloadFilename(title));
        } finally {
          URL.revokeObjectURL(url);
        }
        return;
      }

      const data = await response.json().catch(() => null);
      if (data?.downloadUrl) {
        const suggested = forcedFilename || toDownloadFilename(title);
        const proxyHref = `/api/proxy-file?url=${encodeURIComponent(data.downloadUrl)}&title=${encodeURIComponent(
          title
        )}&filename=${encodeURIComponent(suggested)}`;
        await downloadViaAppRoute(proxyHref, suggested);
        return;
      }

      throw new Error(data?.error || `Download failed with HTTP ${response.status}`);
    },
    [cookiesJson, downloadViaAppRoute, downloadProfile, toDownloadFilename, triggerBrowserDownload]
  );

  const startScraping = useCallback(async () => {
    let parsedCookies: StoryblocksCookie[];
    try {
      parsedCookies = JSON.parse(cookiesJson);
      if (!Array.isArray(parsedCookies)) throw new Error("Cookies must be an array");
    } catch {
      alert("Invalid cookies JSON. Please paste the cookies array.");
      return;
    }

    const urlList = urls.split("\n").map((u) => u.trim()).filter(Boolean);
    if (urlList.length === 0) {
      alert("Please enter at least one URL.");
      return;
    }

    setIsLoading(true);
    setProgress([]);
    setResults([]);
    setErrors([]);
    setDownloadErrors([]);
    setCurrentIndex(0);
    setAutoSelectedSlots([]);
    setAutoSelectIndex(0);
    setDownloadAllProgress(null);
    setBatchSummary(null);
    setOrderAudit({ lastSequence: 0, violations: 0 });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: urlList, cookies: parsedCookies }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event: ProgressEvent = JSON.parse(line);
            if (event.message) setProgress((prev) => [...prev, event.message!]);
            if (event.type === "result" && event.data && "searchUrl" in event.data) {
              const result = event.data as SearchResult;
              setResults((prev) => [...prev, result]);
              if (autoSelect) {
                const initialSlots: VideoSlot[] = result.videos
                  .slice(0, videosPerLink)
                  .map((video, i) => ({ video, originalIndex: i }));
                setAutoSelectedSlots((prev) => [...prev, initialSlots]);
              }
            }
            if (event.type === "error" && event.data && "url" in event.data)
              setErrors((prev) => [...prev, event.data as ScrapeError]);
            if (event.type === "done") setShowConfig(false);
          } catch {}
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError")
        setProgress((prev) => [...prev, `Fatal error: ${(err as Error).message}`]);
    } finally {
      setIsLoading(false);
    }
  }, [cookiesJson, urls, autoSelect, videosPerLink]);

  const reScrapeSingleUrl = useCallback(async (resultIndex: number) => {
    const searchUrl = results[resultIndex]?.searchUrl;
    if (!searchUrl) return;

    let parsedCookies: StoryblocksCookie[];
    try {
      parsedCookies = JSON.parse(cookiesJson);
    } catch {
      return;
    }

    setReScrapingIndex(resultIndex);
    try {
      const response = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: [searchUrl], cookies: parsedCookies }),
      });
      if (!response.ok || !response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let newResult: SearchResult | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event: ProgressEvent = JSON.parse(line);
            if (event.type === "result" && event.data && "searchUrl" in event.data) {
              newResult = event.data as SearchResult;
            }
          } catch {}
        }
      }

      if (newResult && newResult.videos.length > 0) {
        setResults((prev) => {
          const updated = [...prev];
          updated[resultIndex] = newResult!;
          return updated;
        });
        const newSlots: VideoSlot[] = newResult.videos
          .slice(0, videosPerLink)
          .map((video, i) => ({ video, originalIndex: i }));
        setAutoSelectedSlots((prev) => {
          const updated = [...prev];
          updated[resultIndex] = newSlots;
          return updated;
        });
      }
    } finally {
      setReScrapingIndex(null);
    }
  }, [results, cookiesJson, videosPerLink]);

  const handleDownload = useCallback(
    async (detailUrl: string, searchUrl: string, title: string, forcedFilename?: string) => {
      setDownloading(detailUrl);
      try {
        await downloadVideoFromDetail(detailUrl, title, forcedFilename);
      } catch (err) {
        setDownloadErrors((prev) => [...prev, { videoUrl: detailUrl, searchUrl, error: err instanceof Error ? err.message : String(err), kind: "failure" }]);
      } finally {
        setDownloading(null);
      }
    },
    [downloadVideoFromDetail]
  );

  const getNextReplacementSlot = useCallback(
    (slotsState: VideoSlot[][], resultIndex: number, slotIndex: number) => {
      const allVideos = results[resultIndex]?.videos ?? [];
      const slots = slotsState[resultIndex] ?? [];
      const usedIndexes = new Set(slots.map((s) => s.originalIndex));
      const currentOriginalIndex = slots[slotIndex]?.originalIndex ?? -1;
      let nextIndex = -1;

      for (let i = currentOriginalIndex + 1; i < allVideos.length; i++) {
        if (!usedIndexes.has(i)) { nextIndex = i; break; }
      }
      if (nextIndex === -1) {
        for (let i = 0; i < currentOriginalIndex; i++) {
          if (!usedIndexes.has(i)) { nextIndex = i; break; }
        }
      }
      if (nextIndex === -1) return null;

      return { video: allVideos[nextIndex], originalIndex: nextIndex };
    },
    [results]
  );

  const replaceVideo = useCallback(
    (resultIndex: number, slotIndex: number) => {
      setAutoSelectedSlots((prev) => {
        const replacement = getNextReplacementSlot(prev, resultIndex, slotIndex);
        if (!replacement) return prev;
        const newSlots = prev.map((slots) => [...slots]);
        newSlots[resultIndex][slotIndex] = replacement;
        return newSlots;
      });
    },
    [getNextReplacementSlot]
  );

  const handleDownloadAll = useCallback(async () => {
    const workingSlots = autoSelectedSlots.map((slots) => slots.map((slot) => ({ ...slot })));
    let sequenceCounter = 0;
    const allVideos = workingSlots.flatMap((slots, i) => {
      const usedIndexes = new Set(slots.map((s) => s.originalIndex));
      const allResultVideos = results[i]?.videos ?? [];
      return slots.map((slot, slotIndex) => {
        sequenceCounter += 1;
        const suggestedFilename = `${sessionPrefix}-${String(sequenceCounter).padStart(4, "0")}.mp4`;
        const replacements: ReplacementCandidate[] = allResultVideos
          .map((v, idx) => ({ detailUrl: v.detailUrl, title: v.title, originalIndex: idx }))
          .filter((r) => !usedIndexes.has(r.originalIndex) && r.originalIndex !== slot.originalIndex);
        return {
          detailUrl: slot.video.detailUrl,
          title: slot.video.title,
          searchUrl: results[i]?.searchUrl ?? "",
          resultIndex: i,
          slotIndex,
          sequenceIndex: sequenceCounter,
          suggestedFilename,
          replacements,
        };
      });
    });
    if (allVideos.length === 0) return;

    let parsedCookies: StoryblocksCookie[];
    try {
      parsedCookies = JSON.parse(cookiesJson);
    } catch {
      alert("Invalid cookies JSON");
      return;
    }

    const signature = createBatchSignature(allVideos, downloadProfile);
    let resumeIndex = 0;
    try {
      const raw = localStorage.getItem(checkpointKey);
      if (raw) {
        const checkpoint = JSON.parse(raw) as DownloadCheckpoint;
        const isMatchingRun =
          checkpoint?.signature === signature &&
          checkpoint.total === allVideos.length &&
          checkpoint.nextIndex > 0 &&
          checkpoint.nextIndex < allVideos.length;
        if (isMatchingRun) {
          const shouldResume = window.confirm(
            `Resume previous batch from item ${checkpoint.nextIndex + 1} of ${checkpoint.total}?`
          );
          if (shouldResume) {
            resumeIndex = checkpoint.nextIndex;
          } else {
            localStorage.removeItem(checkpointKey);
          }
        }
      }
    } catch {
      localStorage.removeItem(checkpointKey);
    }

    const persistCheckpoint = (nextIndex: number) => {
      const checkpoint: DownloadCheckpoint = {
        signature,
        total: allVideos.length,
        nextIndex,
        updatedAt: Date.now(),
      };
      localStorage.setItem(checkpointKey, JSON.stringify(checkpoint));
    };

    persistCheckpoint(resumeIndex);

    const queuedVideos = allVideos.slice(resumeIndex);
    if (queuedVideos.length === 0) {
      setDownloadAllProgress({ done: allVideos.length, total: allVideos.length });
      localStorage.removeItem(checkpointKey);
      return;
    }

    setDownloadingAll(true);
    setDownloadAllProgress({ done: resumeIndex, total: allVideos.length });
    setBatchSummary(null);
    setOrderAudit({ lastSequence: 0, violations: 0 });

    let batchResp: Response;
    try {
      batchResp = await fetch("/api/download-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videos: queuedVideos,
          cookies: parsedCookies,
          profile: downloadProfile,
          stopOnCriticalError,
        }),
      });
    } catch (err) {
      setDownloadErrors((prev) => [
        ...prev,
        { videoUrl: "", searchUrl: "", error: `Batch fetch failed: ${err instanceof Error ? err.message : String(err)}`, kind: "failure" as const },
      ]);
      setDownloadingAll(false);
      setDownloadAllProgress(null);
      return;
    }

    if (!batchResp.ok || !batchResp.body) {
      const payload = await batchResp.json().catch(() => null);
      setDownloadErrors((prev) => [
        ...prev,
        {
          videoUrl: "",
          searchUrl: "",
          kind: "failure" as const,
          error:
            payload?.error ||
            `Batch download failed with HTTP ${batchResp.status}${batchResp.body ? "" : " (empty response body)"}`,
        },
      ]);
      setDownloadingAll(false);
      setDownloadAllProgress(null);
      return;
    }

    // Stream NDJSON and preserve deterministic order visibility.
    const reader = batchResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = resumeIndex;
    let expectedSequence = 1;
    let localOrderViolations = 0;
    const activeDownloadTasks = new Set<Promise<void>>();
    const maxConcurrentDownloads = CLIENT_DOWNLOAD_CONCURRENCY[downloadProfile];
    const filenameBySlot = new Map<string, string>();
    for (const video of allVideos) {
      filenameBySlot.set(`${video.resultIndex}:${video.slotIndex}`, video.suggestedFilename || "video.mp4");
    }
    const syncWorkingSlots = () => {
      setAutoSelectedSlots(workingSlots.map((slots) => slots.map((slot) => ({ ...slot }))));
    };

    const applyServerReplacement = (event: DownloadBatchEvent) => {
      if (
        event.replacedWith &&
        typeof event.resultIndex === "number" &&
        typeof event.slotIndex === "number"
      ) {
        const allResultVideos = results[event.resultIndex]?.videos ?? [];
        const replacementVideo = allResultVideos[event.replacedWith.originalIndex];
        if (replacementVideo && workingSlots[event.resultIndex]?.[event.slotIndex]) {
          workingSlots[event.resultIndex][event.slotIndex] = {
            video: replacementVideo,
            originalIndex: event.replacedWith.originalIndex,
          };
          syncWorkingSlots();
        }

        setDownloadErrors((prev) => [
          ...prev,
          {
            videoUrl: event.detailUrl || "",
            searchUrl: event.searchUrl || "",
            error: event.originalError || "Auto-replaced (original exceeded size limit)",
            title: event.title,
            suggestedFilename: event.suggestedFilename,
            resultIndex: event.resultIndex,
            slotIndex: event.slotIndex,
            replacedWith: event.replacedWith,
            originalError: event.originalError,
            kind: "replaced",
          },
        ]);
      }
    };

    const markItemCompleted = () => {
      done += 1;
      setDownloadAllProgress({ done, total: allVideos.length });
      persistCheckpoint(done);
    };

    const enqueueDownloadTask = async (task: () => Promise<void>) => {
      while (activeDownloadTasks.size >= maxConcurrentDownloads) {
        await Promise.race(activeDownloadTasks);
      }
      const wrappedTask = task().finally(() => {
        activeDownloadTasks.delete(wrappedTask);
      });
      activeDownloadTasks.add(wrappedTask);
    };

    try {
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as DownloadBatchEvent;

            if (typeof event.sequenceNumber === "number") {
              if (event.sequenceNumber !== expectedSequence) {
                localOrderViolations += 1;
                expectedSequence = event.sequenceNumber + 1;
              } else {
                expectedSequence += 1;
              }
              setOrderAudit({
                lastSequence: event.sequenceNumber,
                violations: localOrderViolations,
              });
            }

            if (event.status === "retrying" && event.error) {
              setProgress((prev) => [
                ...prev,
                `Retrying ${event.title || "video"} (${event.attempt ?? "?"}/${event.maxAttempts ?? "?"}): ${event.error}`,
              ]);
              continue;
            }

            if (event.status === "summary") {
              setBatchSummary(event.summary ?? null);
              if ((event.summary?.orderViolations ?? 0) > 0) {
                setOrderAudit((prev) => ({
                  lastSequence: prev.lastSequence,
                  violations: prev.violations + (event.summary?.orderViolations ?? 0),
                }));
              }
              if (event.summary?.stopped) {
                setProgress((prev) => [
                  ...prev,
                  event.summary?.stopReason || "Batch stopped due to critical error. Resume is available.",
                ]);
              }
              continue;
            }

            if (event.status === "done" || event.status === "failed") {
              await enqueueDownloadTask(async () => {
                try {
                  if (event.status === "done" && event.proxyUrl) {
                    if (event.replacedWith) applyServerReplacement(event);
                    await downloadViaAppRoute(
                      event.proxyUrl,
                      event.suggestedFilename || toDownloadFilename(event.title || "video")
                    );
                  } else if (event.status === "done" && event.downloadUrl) {
                    if (event.replacedWith) applyServerReplacement(event);
                    const proxyHref = `/api/proxy-file?url=${encodeURIComponent(event.downloadUrl)}&title=${encodeURIComponent(
                      event.title || "video"
                    )}&filename=${encodeURIComponent(event.suggestedFilename || toDownloadFilename(event.title || "video"))}`;
                    await downloadViaAppRoute(
                      proxyHref,
                      event.suggestedFilename || toDownloadFilename(event.title || "video")
                    );
                  } else if (event.error) {
                    throw new Error(event.error);
                  }
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err);
                  setDownloadErrors((prev) => [
                    ...prev,
                    {
                      videoUrl: event.detailUrl || "",
                      searchUrl: event.searchUrl || "",
                      error: message,
                      title: event.title,
                      suggestedFilename: event.suggestedFilename,
                      resultIndex: event.resultIndex,
                      slotIndex: event.slotIndex,
                      kind: "failure",
                    },
                  ]);
                } finally {
                  markItemCompleted();
                }
              });
            }
          } catch {
            // Ignore malformed lines.
          }
        }
      }
    } catch (err) {
      setDownloadErrors((prev) => [
        ...prev,
        {
          videoUrl: "",
          searchUrl: "",
          error: `Batch stream interrupted: ${err instanceof Error ? err.message : String(err)}`,
          kind: "failure",
        },
      ]);
      setProgress((prev) => [
        ...prev,
        "Batch stream interrupted. You can retry or resume from checkpoint.",
      ]);
    } finally {
      reader.cancel().catch(() => {});
    }
    await Promise.all(activeDownloadTasks);

    setDownloadingAll(false);
    setDownloadAllProgress(null);
    if (done >= allVideos.length) {
      localStorage.removeItem(checkpointKey);
    }
  }, [
    autoSelectedSlots,
    results,
    cookiesJson,
    downloadViaAppRoute,
    downloadProfile,
    stopOnCriticalError,
    toDownloadFilename,
    sessionPrefix,
    checkpointKey,
  ]);

  const currentResult = results[currentIndex];
  const currentAutoResult = results[autoSelectIndex];
  const currentAutoSlots = autoSelectedSlots[autoSelectIndex] ?? [];
  const showAutoSelectView = autoSelect && results.length > 0 && !isLoading;
  const showManualView = !autoSelect && results.length > 0 && !isLoading;
  const totalAutoVideos = autoSelectedSlots.reduce((s, slots) => s + slots.length, 0);
  const shortGroups = autoSelectedSlots
    .map((slots, i) => ({ index: i, count: slots.length, url: results[i]?.searchUrl ?? "" }))
    .filter((g) => g.count < videosPerLink);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">Storyblocks Video Scraper</h1>
            {mounted && (
              <span className="text-xs font-mono bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded">
                Session {sessionPrefix}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <Link href="/srt-images" className="text-sm text-zinc-400 hover:text-zinc-200 transition">
              SRT → Images
            </Link>
            {results.length > 0 && (
              <button onClick={() => setShowConfig((prev) => !prev)} className="text-sm text-zinc-400 hover:text-zinc-200 transition">
                {showConfig ? "Hide Config" : "Show Config"}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 space-y-6">
        {showConfig && (
          <section className="space-y-4 bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <h2 className="text-lg font-medium">Configuration</h2>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Cookies JSON (paste the full array from browser extension)</label>
              <textarea value={cookiesJson} onChange={(e) => setCookiesJson(e.target.value)}
                placeholder='[{"domain":".storyblocks.com","name":"...","value":"..."}, ...]'
                className="w-full h-32 bg-zinc-950 border border-zinc-700 rounded-lg p-3 text-sm font-mono text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 resize-y" />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Search URLs (one per line)</label>
              <textarea value={urls} onChange={(e) => setUrls(e.target.value)}
                placeholder={"https://www.storyblocks.com/all-video/search/night-lights-glare?max_duration=15&search-origin=filters\nhttps://www.storyblocks.com/all-video/search/sleeping-eyes-closed?max_duration=15&search-origin=filters"}
                onPaste={(e) => {
                  const pasted = e.clipboardData.getData("text");
                  // Detect CSV: has commas and at least one header-like row or multiple columns
                  const lines = pasted.split("\n").map((l) => l.trim()).filter(Boolean);
                  const looksLikeCsv = lines.length > 1 && lines[0].includes(",") && lines[0].toLowerCase().includes("http") === false;
                  if (!looksLikeCsv) return; // let default paste handle plain URLs
                  e.preventDefault();
                  const extracted: string[] = [];
                  for (const line of lines) {
                    // Parse CSV columns, respecting quoted fields
                    const cols: string[] = [];
                    let col = "";
                    let inQuotes = false;
                    for (let i = 0; i < line.length; i++) {
                      const ch = line[i];
                      if (ch === '"') { inQuotes = !inQuotes; }
                      else if (ch === "," && !inQuotes) { cols.push(col); col = ""; }
                      else { col += ch; }
                    }
                    cols.push(col);
                    // Find the first column that contains a URL
                    const urlCol = cols.find((c) => c.trim().startsWith("http"));
                    if (urlCol) extracted.push(urlCol.trim());
                  }
                  if (extracted.length > 0) setUrls(extracted.join("\n"));
                }}
                className="w-full h-40 bg-zinc-950 border border-zinc-700 rounded-lg p-3 text-sm font-mono text-zinc-300 focus:outline-none focus:border-zinc-500 resize-y" />
            </div>
            <div className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer select-none">
                <input type="checkbox" checked={autoSelect} onChange={(e) => setAutoSelect(e.target.checked)} className="w-4 h-4 rounded accent-blue-500" />
                <span className="text-sm text-zinc-300">Auto select videos</span>
              </label>
              {autoSelect && (
                <div className="flex items-center gap-3 pl-7">
                  <label className="text-sm text-zinc-400">Videos per link</label>
                  <input type="number" min={1} max={5} value={videosPerLink}
                    onChange={(e) => setVideosPerLink(Math.min(5, Math.max(1, parseInt(e.target.value) || 1)))}
                    className="w-16 bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500" />
                </div>
              )}
            </div>
            <div className="flex items-end gap-4 flex-wrap">
              <div className="flex-1 min-w-[180px]">
                <label className="block text-sm text-zinc-400 mb-1">Session prefix</label>
                <input
                  type="text"
                  value={sessionPrefix}
                  onChange={(e) => setSessionPrefix(e.target.value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase() || "A")}
                  className="w-24 bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm font-mono text-zinc-300 focus:outline-none focus:border-zinc-500"
                />
                <p className="text-xs text-zinc-500 mt-1">
                  Files: {sessionPrefix}-0001.mp4, {sessionPrefix}-0002.mp4, ...
                </p>
              </div>
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Download profile</label>
              <select
                value={downloadProfile}
                onChange={(e) => setDownloadProfile(e.target.value as DownloadProfileName)}
                className="w-full sm:w-72 bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500"
              >
                <option value="fast">Fast - minimum delays/retries</option>
                <option value="balanced">Balanced - recommended default</option>
                <option value="safe">Safe - maximum stability</option>
                <option value="serial">Serial - one by one, immediately next</option>
                <option value="teste">Teste - serial with 0.5s delay</option>
              </select>
              <p className="text-xs text-zinc-500 mt-1">
                Use Fast for speed, Safe for stability, Balanced as default.
              </p>
            </div>
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={stopOnCriticalError}
                onChange={(e) => setStopOnCriticalError(e.target.checked)}
                className="w-4 h-4 rounded accent-amber-500"
              />
              <span className="text-sm text-zinc-300">Stop batch on critical errors (resume later)</span>
            </label>
            <div className="flex gap-3">
              <button onClick={startScraping} disabled={isLoading}
                className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg font-medium transition">
                {isLoading ? "Scraping..." : "Start Scraping"}
              </button>
              {isLoading && (
                <button onClick={() => abortRef.current?.abort()}
                  className="px-6 py-2.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-lg font-medium transition">
                  Cancel
                </button>
              )}
            </div>
          </section>
        )}

        {progress.length > 0 && (isLoading || showConfig) && (
          <section className="bg-zinc-900 rounded-xl p-4 border border-zinc-800 max-h-48 overflow-y-auto">
            <h3 className="text-sm font-medium text-zinc-400 mb-2">Progress</h3>
            <div className="space-y-1">
              {progress.map((msg, i) => <p key={i} className="text-xs text-zinc-500 font-mono">{msg}</p>)}
              {isLoading && <p className="text-xs text-blue-400 font-mono animate-pulse">Working...</p>}
            </div>
          </section>
        )}

        {/* Auto Select Review */}
        {showAutoSelectView && (
          <section className="space-y-4">
            {/* Navigation */}
            <div className="flex items-center justify-between bg-zinc-900 rounded-xl p-4 border border-zinc-800">
              <button onClick={() => setAutoSelectIndex((prev) => Math.max(0, prev - 1))}
                disabled={autoSelectIndex === 0}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-sm transition">
                Previous
              </button>
              <div className="text-center space-y-0.5">
                <span className="text-sm text-zinc-400 block">{autoSelectIndex + 1} / {results.length} URLs</span>
                <span className="text-xs text-zinc-600">
                  {totalAutoVideos} videos total
                  {shortGroups.length > 0 && (
                    <span className="text-amber-500 ml-1">
                      ({shortGroups.length} URL{shortGroups.length > 1 ? "s" : ""} with fewer than {videosPerLink} videos)
                    </span>
                  )}
                </span>
              </div>
              <button onClick={() => setAutoSelectIndex((prev) => Math.min(results.length - 1, prev + 1))}
                disabled={autoSelectIndex === results.length - 1}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-sm transition">
                Next
              </button>
            </div>

            {currentAutoResult && (
              <div className="space-y-3">
                <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
                  <p className="text-xs text-zinc-500 mb-1">Search URL:</p>
                  <a href={currentAutoResult.searchUrl} target="_blank" rel="noopener noreferrer"
                    className="text-sm text-blue-400 hover:text-blue-300 break-all">
                    {currentAutoResult.searchUrl}
                  </a>
                  {currentAutoSlots.length < videosPerLink && (
                    <div className="flex items-center gap-3 mt-2">
                      <p className="text-xs text-amber-500">
                        This search returned only {currentAutoResult.videos.length} video{currentAutoResult.videos.length !== 1 ? "s" : ""} (expected {videosPerLink})
                      </p>
                      <button
                        onClick={() => reScrapeSingleUrl(autoSelectIndex)}
                        disabled={reScrapingIndex !== null}
                        className="text-xs px-3 py-1 bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-md transition whitespace-nowrap"
                      >
                        {reScrapingIndex === autoSelectIndex ? "Re-scraping..." : "Retry scrape"}
                      </button>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                  {currentAutoSlots.map((slot, slotIndex) => {
                    const usedIndexes = new Set(currentAutoSlots.map((s) => s.originalIndex));
                    const canReplace = usedIndexes.size < currentAutoResult.videos.length;
                    return (
                      <div key={slotIndex} className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden">
                        <div className="relative aspect-video bg-zinc-950">
                          {slot.video.previewVideoUrl ? (
                            <video src={slot.video.previewVideoUrl} poster={slot.video.thumbnail} muted loop playsInline
                              className="w-full h-full object-cover"
                              onMouseEnter={(e) => { e.currentTarget.play().catch(() => {}); }}
                              onMouseLeave={(e) => { const v = e.currentTarget; setTimeout(() => { v.pause(); v.currentTime = 0; }, 50); }} />
                          ) : slot.video.thumbnail ? (
                            <img src={slot.video.thumbnail} alt={slot.video.title} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-zinc-600 text-xs">No preview</div>
                          )}
                        </div>
                        <div className="p-3 space-y-2">
                          <p className="text-xs text-zinc-300 line-clamp-2 leading-relaxed">{slot.video.title || "Untitled"}</p>
                          <div className="flex items-center justify-between gap-2">
                            <a href={slot.video.detailUrl.startsWith("http") ? slot.video.detailUrl : `https://www.storyblocks.com${slot.video.detailUrl}`}
                              target="_blank" rel="noopener noreferrer" className="text-xs text-zinc-600 hover:text-blue-400 transition" title="Open on Storyblocks">
                              View
                            </a>
                            <div className="flex items-center gap-2">
                              <button onClick={() => handleDownload(slot.video.detailUrl, currentAutoResult.searchUrl, slot.video.title)}
                                disabled={downloading === slot.video.detailUrl}
                                className="text-xs px-2.5 py-1 bg-blue-700 hover:bg-blue-600 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-md transition">
                                {downloading === slot.video.detailUrl ? "Downloading..." : "Download"}
                              </button>
                              <button onClick={() => replaceVideo(autoSelectIndex, slotIndex)} disabled={!canReplace}
                                title={canReplace ? "Replace with next result" : "No more results available"}
                                className="text-xs px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-300 rounded-md transition">
                                Replace
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Download All */}
            <div className="flex items-center gap-4 pt-4 border-t border-zinc-800">
              <button onClick={handleDownloadAll} disabled={downloadingAll}
                className="px-6 py-2.5 bg-green-700 hover:bg-green-600 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg font-medium transition">
                {downloadingAll ? "Downloading..." : `Download All (${totalAutoVideos} videos)`}
              </button>
              {downloadAllProgress && (
                <div className="flex items-center gap-3">
                  <div className="w-40 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div className="h-full bg-green-600 rounded-full transition-all"
                      style={{ width: `${(downloadAllProgress.done / downloadAllProgress.total) * 100}%` }} />
                  </div>
                  <span className="text-sm text-zinc-400">{downloadAllProgress.done} / {downloadAllProgress.total}</span>
                </div>
              )}
            </div>
            {(orderAudit.lastSequence > 0 || batchSummary) && (
              <div className="text-xs text-zinc-500 space-y-1">
                <p>
                  Stream order audit: last sequence #{orderAudit.lastSequence} | violations: {orderAudit.violations}
                </p>
                {batchSummary && (
                  <p>
                    Run summary: {batchSummary.success}/{batchSummary.total} succeeded
                    {batchSummary.replaced > 0 && ` (${batchSummary.replaced} auto-replaced)`}
                    , {batchSummary.failed} failed,
                    retries {batchSummary.retriesUsed}, backend order violations {batchSummary.orderViolations}
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {/* Manual Gallery */}
        {showManualView && (
          <section className="space-y-4">
            <div className="flex items-center justify-between bg-zinc-900 rounded-xl p-4 border border-zinc-800">
              <button onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))} disabled={currentIndex === 0}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-sm transition">
                Previous
              </button>
              <span className="text-sm text-zinc-400">{currentIndex + 1} / {results.length}</span>
              <button onClick={() => setCurrentIndex((prev) => Math.min(results.length - 1, prev + 1))} disabled={currentIndex === results.length - 1}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-sm transition">
                Next
              </button>
            </div>
            {currentResult && (
              <div className="space-y-4">
                <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
                  <p className="text-xs text-zinc-500 mb-1">Search URL:</p>
                  <a href={currentResult.searchUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-400 hover:text-blue-300 break-all">
                    {currentResult.searchUrl}
                  </a>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                  {currentResult.videos.map((video, idx) => (
                    <div key={idx} className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden hover:border-zinc-600 transition group cursor-pointer"
                      onClick={() => handleDownload(video.detailUrl, currentResult.searchUrl, video.title)}>
                      <div className="relative aspect-video bg-zinc-950">
                        {video.previewVideoUrl ? (
                          <video src={video.previewVideoUrl} poster={video.thumbnail} muted loop playsInline
                            className="w-full h-full object-cover"
                            onMouseEnter={(e) => { e.currentTarget.play().catch(() => {}); }}
                            onMouseLeave={(e) => { const v = e.currentTarget; setTimeout(() => { v.pause(); v.currentTime = 0; }, 50); }} />
                        ) : video.thumbnail ? (
                          <img src={video.thumbnail} alt={video.title} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-zinc-600">No preview</div>
                        )}
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition flex items-center justify-center">
                          <div className="opacity-0 group-hover:opacity-100 transition">
                            {downloading === video.detailUrl ? (
                              <div className="bg-zinc-900/90 rounded-full px-4 py-2 text-sm">Downloading...</div>
                            ) : (
                              <div className="bg-blue-600/90 rounded-full px-4 py-2 text-sm font-medium">Click to Download HD MP4</div>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="p-3">
                        <p className="text-sm text-zinc-300 line-clamp-2">{video.title || "Untitled"}</p>
                        <a href={video.detailUrl.startsWith("http") ? video.detailUrl : `https://www.storyblocks.com${video.detailUrl}`}
                          target="_blank" rel="noopener noreferrer" className="text-xs text-zinc-500 hover:text-blue-400 mt-1 block"
                          onClick={(e) => e.stopPropagation()}>
                          Open on Storyblocks
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-center text-xs text-zinc-600">Click videos to download HD MP4. Use Next/Previous to navigate between URL groups.</p>
              </div>
            )}
          </section>
        )}

        {errors.length > 0 && (
          <section className="bg-red-950/30 rounded-xl p-4 border border-red-900/50 space-y-3">
            <h3 className="text-sm font-medium text-red-400">Scrape Errors</h3>
            {errors.map((err, i) => (
              <div key={`scrape-${i}`} className="text-xs space-y-0.5">
                <p className="text-red-300">Failed to scrape URL:</p>
                <p className="text-red-400/70 font-mono break-all">{err.url}</p>
                <p className="text-red-500/60">{err.error}</p>
              </div>
            ))}
          </section>
        )}

        {downloadErrors.length > 0 && (() => {
          const failures = downloadErrors.filter((e) => e.kind === "failure");
          const replacements = downloadErrors.filter((e) => e.kind === "replaced");
          return (
            <section className="bg-zinc-900 rounded-xl p-5 border border-amber-900/50 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-amber-400">
                  {batchSummary && !downloadingAll
                    ? `Batch Report — ${failures.length} failed${replacements.length > 0 ? `, ${replacements.length} auto-replaced` : ""}`
                    : `Download Issues (${downloadErrors.length})`}
                </h3>
                <button
                  onClick={() => setDownloadErrors([])}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition"
                >
                  Clear
                </button>
              </div>

              {failures.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-red-400">Failed</p>
                  {failures.map((err, i) => (
                    <div
                      key={`fail-${i}`}
                      className="flex items-start gap-3 bg-zinc-950 rounded-lg p-3 border border-red-900/30"
                    >
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          {err.suggestedFilename && (
                            <span className="text-xs font-mono font-semibold text-red-400/90 bg-red-400/10 px-1.5 py-0.5 rounded">
                              {err.suggestedFilename}
                            </span>
                          )}
                          <span className="text-xs text-zinc-300 truncate">
                            {err.title || err.videoUrl || "Unknown video"}
                          </span>
                        </div>
                        <p className="text-xs text-red-400/70 truncate" title={err.error}>
                          {err.error}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {typeof err.resultIndex === "number" && (
                          <button
                            onClick={() => setAutoSelectIndex(err.resultIndex!)}
                            className="text-xs px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition whitespace-nowrap"
                            title={`Navigate to URL group ${err.resultIndex + 1}`}
                          >
                            Group {err.resultIndex + 1}
                          </button>
                        )}
                        {err.videoUrl && (
                          <a
                            href={err.videoUrl.startsWith("http") ? err.videoUrl : `https://www.storyblocks.com${err.videoUrl}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-blue-400 rounded-md transition"
                          >
                            View
                          </a>
                        )}
                        {err.videoUrl && (
                          <button
                            onClick={() => {
                              setDownloadErrors((prev) => prev.filter((_, idx) => idx !== downloadErrors.indexOf(err)));
                              handleDownload(err.videoUrl, err.searchUrl, err.title || "video", err.suggestedFilename);
                            }}
                            disabled={downloading === err.videoUrl}
                            className="text-xs px-2.5 py-1 bg-blue-700 hover:bg-blue-600 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-md transition"
                          >
                            {downloading === err.videoUrl ? "..." : "Retry"}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {replacements.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-green-400">Auto-replaced (downloaded a substitute)</p>
                  {replacements.map((err, i) => (
                    <div
                      key={`repl-${i}`}
                      className="flex items-start gap-3 bg-zinc-950 rounded-lg p-3 border border-green-900/30"
                    >
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          {err.suggestedFilename && (
                            <span className="text-xs font-mono font-semibold text-green-400/90 bg-green-400/10 px-1.5 py-0.5 rounded">
                              {err.suggestedFilename}
                            </span>
                          )}
                          <span className="text-xs text-zinc-500 line-through truncate">
                            {err.title || "Original video"}
                          </span>
                          <span className="text-xs text-zinc-600 mx-0.5">&rarr;</span>
                          <span className="text-xs text-zinc-300 truncate">
                            {err.replacedWith?.title || "Replacement"}
                          </span>
                        </div>
                        <p className="text-xs text-zinc-500 truncate" title={err.originalError || err.error}>
                          Reason: {err.originalError || err.error}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {typeof err.resultIndex === "number" && (
                          <button
                            onClick={() => setAutoSelectIndex(err.resultIndex!)}
                            className="text-xs px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition whitespace-nowrap"
                            title={`Navigate to URL group ${err.resultIndex + 1}`}
                          >
                            Group {err.resultIndex + 1}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })()}
      </main>
    </div>
  );
}
