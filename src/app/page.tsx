"use client";

import { useState, useRef, useCallback } from "react";
import type { SearchResult, ScrapeError, ProgressEvent, StoryblocksCookie, VideoInfo } from "@/lib/types";

type VideoSlot = { video: VideoInfo; originalIndex: number };

export default function Home() {
  const [cookiesJson, setCookiesJson] = useState("");
  const [urls, setUrls] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [errors, setErrors] = useState<ScrapeError[]>([]);
  const [downloadErrors, setDownloadErrors] = useState<{ videoUrl: string; searchUrl: string; error: string }[]>([]);
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
  const [downloadAllProgress, setDownloadAllProgress] = useState<{ done: number; total: number } | null>(null);

  const toDownloadFilename = useCallback((title: string) => {
    const safeBase = title.slice(0, 50).replace(/[^a-zA-Z0-9]/g, "_") || "video";
    return `${safeBase}.mp4`;
  }, []);

  const getFilenameFromContentDisposition = useCallback((contentDisposition: string | null) => {
    if (!contentDisposition) return "";

    const utf8Match = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      return decodeURIComponent(utf8Match[1]).replace(/['"]/g, "").trim();
    }

    const basicMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
    return basicMatch?.[1]?.replace(/['"]/g, "").trim() || "";
  }, []);

  const triggerBrowserDownload = useCallback(async (href: string, suggestedName?: string) => {
    const link = document.createElement("a");
    link.href = href;
    if (suggestedName) link.download = suggestedName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    await new Promise((resolve) => setTimeout(resolve, 650));
  }, []);

  const downloadViaAppRoute = useCallback(
    async (href: string, suggestedName: string) => {
      const response = await fetch(href);
      const contentType = response.headers.get("content-type") || "";
      const responseFilename = getFilenameFromContentDisposition(response.headers.get("content-disposition"));

      if (!response.ok || !contentType.includes("video/")) {
        let message = `Download failed with HTTP ${response.status}`;
        try {
          const payload = await response.json();
          if (payload?.error) message = payload.error;
        } catch {
          // Keep fallback message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      try {
        await triggerBrowserDownload(blobUrl, responseFilename || suggestedName);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    },
    [getFilenameFromContentDisposition, triggerBrowserDownload]
  );

  const downloadVideoFromDetail = useCallback(
    async (detailUrl: string, title: string) => {
      let parsedCookies: StoryblocksCookie[];
      try {
        parsedCookies = JSON.parse(cookiesJson);
      } catch {
        throw new Error("Invalid cookies JSON");
      }

      const response = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ detailUrl, cookies: parsedCookies }),
      });
      const contentType = response.headers.get("content-type") || "";
      const responseFilename = getFilenameFromContentDisposition(response.headers.get("content-disposition"));

      if (contentType.includes("video/")) {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        try {
          await triggerBrowserDownload(url, responseFilename || toDownloadFilename(title));
        } finally {
          URL.revokeObjectURL(url);
        }
        return;
      }

      const data = await response.json().catch(() => null);
      if (data?.downloadUrl) {
        const proxyHref = `/api/proxy-file?url=${encodeURIComponent(data.downloadUrl)}&title=${encodeURIComponent(title)}`;
        await downloadViaAppRoute(proxyHref, toDownloadFilename(title));
        return;
      }

      throw new Error(data?.error || `Download failed with HTTP ${response.status}`);
    },
    [cookiesJson, downloadViaAppRoute, getFilenameFromContentDisposition, toDownloadFilename, triggerBrowserDownload]
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

  const handleDownload = useCallback(
    async (detailUrl: string, searchUrl: string, title: string) => {
      setDownloading(detailUrl);
      try {
        await downloadVideoFromDetail(detailUrl, title);
      } catch (err) {
        setDownloadErrors((prev) => [...prev, { videoUrl: detailUrl, searchUrl, error: err instanceof Error ? err.message : String(err) }]);
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
    const allVideos = workingSlots.flatMap((slots, i) =>
      slots.map((slot, slotIndex) => ({
        detailUrl: slot.video.detailUrl,
        title: slot.video.title,
        searchUrl: results[i]?.searchUrl ?? "",
        resultIndex: i,
        slotIndex,
      }))
    );
    if (allVideos.length === 0) return;

    let parsedCookies: StoryblocksCookie[];
    try {
      parsedCookies = JSON.parse(cookiesJson);
    } catch {
      alert("Invalid cookies JSON");
      return;
    }

    setDownloadingAll(true);
    setDownloadAllProgress({ done: 0, total: allVideos.length });

    let batchResp: Response;
    try {
      batchResp = await fetch("/api/download-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videos: allVideos, cookies: parsedCookies }),
      });
    } catch (err) {
      setDownloadErrors((prev) => [
        ...prev,
        { videoUrl: "", searchUrl: "", error: `Batch fetch failed: ${err instanceof Error ? err.message : String(err)}` },
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
          error:
            payload?.error ||
            `Batch download failed with HTTP ${batchResp.status}${batchResp.body ? "" : " (empty response body)"}`,
        },
      ]);
      setDownloadingAll(false);
      setDownloadAllProgress(null);
      return;
    }

    // Stream NDJSON — download each file directly from CloudFront as its URL arrives
    const reader = batchResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = 0;
    const shouldAutoReplace = (message: string) =>
      message.includes("100 MB") || message.includes("No supported HD format under 100 MB");

    const syncWorkingSlots = () => {
      setAutoSelectedSlots(workingSlots.map((slots) => slots.map((slot) => ({ ...slot }))));
    };

    const autoReplaceAndDownload = async (resultIndex: number, slotIndex: number, initialError: string) => {
      let lastError = initialError;

      while (true) {
        const replacement = getNextReplacementSlot(workingSlots, resultIndex, slotIndex);
        if (!replacement) {
          setDownloadErrors((prev) => [
            ...prev,
            {
              videoUrl: workingSlots[resultIndex]?.[slotIndex]?.video.detailUrl ?? "",
              searchUrl: results[resultIndex]?.searchUrl ?? "",
              error: lastError,
            },
          ]);
          return;
        }

        workingSlots[resultIndex][slotIndex] = replacement;
        syncWorkingSlots();

        try {
          await downloadVideoFromDetail(replacement.video.detailUrl, replacement.video.title);
          return;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          if (!shouldAutoReplace(lastError)) {
            setDownloadErrors((prev) => [
              ...prev,
              {
                videoUrl: replacement.video.detailUrl,
                searchUrl: results[resultIndex]?.searchUrl ?? "",
                error: lastError,
              },
            ]);
            return;
          }
        }
      }
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
            const result: {
              detailUrl: string;
              title: string;
              searchUrl: string;
              resultIndex?: number;
              slotIndex?: number;
              downloadUrl?: string;
              proxyUrl?: string;
              error?: string;
            } = JSON.parse(line);
            try {
              if (result.proxyUrl) {
                await downloadViaAppRoute(result.proxyUrl, toDownloadFilename(result.title));
              } else if (result.downloadUrl) {
                const proxyHref = `/api/proxy-file?url=${encodeURIComponent(result.downloadUrl)}&title=${encodeURIComponent(result.title)}`;
                await downloadViaAppRoute(proxyHref, toDownloadFilename(result.title));
              } else if (result.error) {
                throw new Error(result.error);
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (
                shouldAutoReplace(message) &&
                typeof result.resultIndex === "number" &&
                typeof result.slotIndex === "number"
              ) {
                await autoReplaceAndDownload(result.resultIndex, result.slotIndex, message);
              } else {
                setDownloadErrors((prev) => [
                  ...prev,
                  { videoUrl: result.detailUrl, searchUrl: result.searchUrl, error: message },
                ]);
              }
            }
          } catch { /* malformed line */ }
          done++;
          setDownloadAllProgress({ done, total: allVideos.length });
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    setDownloadingAll(false);
    setDownloadAllProgress(null);
  }, [autoSelectedSlots, results, cookiesJson, downloadViaAppRoute, toDownloadFilename, getNextReplacementSlot, downloadVideoFromDetail]);

  const currentResult = results[currentIndex];
  const currentAutoResult = results[autoSelectIndex];
  const currentAutoSlots = autoSelectedSlots[autoSelectIndex] ?? [];
  const showAutoSelectView = autoSelect && results.length > 0 && !isLoading;
  const showManualView = !autoSelect && results.length > 0 && !isLoading;
  const totalAutoVideos = autoSelectedSlots.reduce((s, slots) => s + slots.length, 0);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-semibold">Storyblocks Video Scraper</h1>
          {results.length > 0 && (
            <button onClick={() => setShowConfig((prev) => !prev)} className="text-sm text-zinc-400 hover:text-zinc-200 transition">
              {showConfig ? "Hide Config" : "Show Config"}
            </button>
          )}
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
                <span className="text-xs text-zinc-600">{totalAutoVideos} videos total</span>
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
                              <div className="bg-blue-600/90 rounded-full px-4 py-2 text-sm font-medium">Click to Download HD Video</div>
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
                <p className="text-center text-xs text-zinc-600">Click videos to download the best HD format available. Use Next/Previous to navigate between URL groups.</p>
              </div>
            )}
          </section>
        )}

        {(errors.length > 0 || downloadErrors.length > 0) && (
          <section className="bg-red-950/30 rounded-xl p-4 border border-red-900/50 space-y-3">
            <h3 className="text-sm font-medium text-red-400">Errors</h3>
            {errors.map((err, i) => (
              <div key={`scrape-${i}`} className="text-xs space-y-0.5">
                <p className="text-red-300">Failed to scrape URL:</p>
                <p className="text-red-400/70 font-mono break-all">{err.url}</p>
                <p className="text-red-500/60">{err.error}</p>
              </div>
            ))}
            {downloadErrors.map((err, i) => (
              <div key={`dl-${i}`} className="text-xs space-y-0.5">
                <p className="text-red-300">Failed to download video:</p>
                <p className="text-red-400/70 font-mono break-all">{err.videoUrl}</p>
                <p className="text-red-500/60">From: {err.searchUrl}</p>
                <p className="text-red-500/60">{err.error}</p>
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
