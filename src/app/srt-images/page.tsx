"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";

// ─── Types ────────────────────────────────────────────────────────────────────

type SrtEntry = { index: number; start: number; end: number; text: string };
type Segment = { startTime: number; endTime: number; text: string };
type Description = { segment: string; description: string };
type UsageSummary = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
type AspectRatio = "1:1" | "16:9" | "9:16" | "4:3";

type Step =
  | "upload"
  | "segments"
  | "analyzing"
  | "context"
  | "describing"
  | "descriptions"
  | "images";

const STORAGE_KEY = "srt-images-session-v1";

// ─── SRT parser ───────────────────────────────────────────────────────────────

function timeToSeconds(ts: string): number {
  const clean = ts.trim().replace(",", ".");
  const parts = clean.split(":");
  return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
}

function parseSrt(content: string): SrtEntry[] {
  const entries: SrtEntry[] = [];
  const blocks = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;
    const idx = parseInt(lines[0].trim(), 10);
    if (isNaN(idx)) continue;
    const timeParts = lines[1].trim().split("-->");
    if (timeParts.length !== 2) continue;
    const start = timeToSeconds(timeParts[0]);
    const end = timeToSeconds(timeParts[1]);
    const text = lines.slice(2).join(" ").trim();
    if (text) entries.push({ index: idx, start, end, text });
  }
  return entries;
}

// ─── Segment grouper ──────────────────────────────────────────────────────────

function groupIntoSegments(entries: SrtEntry[], targetSeconds: number): Segment[] {
  if (entries.length === 0) return [];
  const totalDuration = entries[entries.length - 1].end;
  const numBuckets = Math.ceil(totalDuration / targetSeconds);
  const bucketSize = totalDuration / numBuckets;
  const buckets: SrtEntry[][] = Array.from({ length: numBuckets }, () => []);
  for (const entry of entries) {
    const midpoint = (entry.start + entry.end) / 2;
    const bi = Math.min(Math.floor(midpoint / bucketSize), numBuckets - 1);
    buckets[bi].push(entry);
  }
  return buckets
    .map((bucket, i) => ({
      startTime: i * bucketSize,
      endTime: (i + 1) * bucketSize,
      text: bucket.map((e) => e.text).join(" "),
    }))
    .filter((seg) => seg.text.trim().length > 0);
}

// ─── Context window helper ────────────────────────────────────────────────────

const CONTEXT_WINDOW = 2; // segments before and after each focal segment

function buildWindowedBatchItem(segs: string[], index: number): string {
  const before = segs.slice(Math.max(0, index - CONTEXT_WINDOW), index);
  const focus = segs[index];
  const after = segs.slice(index + 1, Math.min(segs.length, index + 1 + CONTEXT_WINDOW));
  const parts: string[] = [];
  if (before.length > 0) parts.push(`[CONTEXT — preceding]:\n${before.join(" ")}`);
  parts.push(`[FOCUS — generate image for this]:\n${focus}`);
  if (after.length > 0) parts.push(`[CONTEXT — following]:\n${after.join(" ")}`);
  return parts.join("\n\n");
}

// ─── Cost helpers ─────────────────────────────────────────────────────────────

const PRICE_INPUT_PER_1M = 1.10;
const PRICE_OUTPUT_PER_1M = 4.40;

function calcCost(usage: UsageSummary) {
  const input = (usage.prompt_tokens / 1_000_000) * PRICE_INPUT_PER_1M;
  const output = (usage.completion_tokens / 1_000_000) * PRICE_OUTPUT_PER_1M;
  return { input, output, total: input + output };
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

// ─── Image model options ──────────────────────────────────────────────────────

type ImageModelId =
  | "sourceful/riverflow-v2-fast"
  | "black-forest-labs/flux.2-klein-4b"
  | "bytedance-seed/seedream-4.5"
  | "sourceful/riverflow-v2-fast-preview"
  | "black-forest-labs/flux.2-pro";

const IMAGE_MODEL_OPTIONS: { value: ImageModelId; label: string; note: string }[] = [
  { value: "sourceful/riverflow-v2-fast", label: "Riverflow V2 Fast", note: "~$0.02" },
  { value: "black-forest-labs/flux.2-klein-4b", label: "FLUX.2 Klein 4B", note: "~$0.014" },
  { value: "bytedance-seed/seedream-4.5",     label: "Seedream 4.5",    note: "~$0.04" },
  { value: "sourceful/riverflow-v2-fast-preview",           label: "Riverflow V2 Fast Preview", note: "~$0.03" },
  { value: "black-forest-labs/flux.2-pro",                 label: "FLUX.2 Pro", note: "~$0.03" },
];

// ─── Aspect ratio helpers ─────────────────────────────────────────────────────

const ASPECT_RATIO_OPTIONS: { value: AspectRatio; label: string }[] = [
  { value: "1:1",  label: "1:1 — Square" },
  { value: "16:9", label: "16:9 — Landscape" },
  { value: "9:16", label: "9:16 — Portrait / Reels" },
  { value: "4:3",  label: "4:3 — Classic" },
];

function aspectRatioStyle(ar: AspectRatio): React.CSSProperties {
  const map: Record<AspectRatio, string> = {
    "1:1": "1/1", "16:9": "16/9", "9:16": "9/16", "4:3": "4/3",
  };
  return { aspectRatio: map[ar] };
}

// ─── Export helpers ───────────────────────────────────────────────────────────

function exportJson(descriptions: Description[]) {
  const data = descriptions.map((d, i) => ({ index: i + 1, segment: d.segment, description: d.description }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  triggerDownload(blob, "descriptions.json");
}

function exportCsv(descriptions: Description[]) {
  const header = "#,Caption Segment,Image Description";
  const rows = descriptions.map((d, i) => {
    const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
    return `${i + 1},${escape(d.segment)},${escape(d.description)}`;
  });
  const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
  triggerDownload(blob, "descriptions.csv");
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STYLE_PRESETS: { key: string; label: string; style: string }[] = [
  {
    key: "jesus",
    label: "Jesus Style",
    style: "The style of this image is a hyper-detailed, modern digital illustration that emulates and reinterprets Classical Renaissance and Baroque religious painting. It combines the rich, saturated color palette (deep reds, ochres, golds) and dramatic chiaroscuro lighting of old masters with a very polished, clean, and highly defined digital execution. The brushwork, though digital, mimics the texture of old paint on a textured surface. The composition is formal and hierarchical, with a strong focus on dramatic light sources and a reverent tone. Lighting is exclusively warm — oil lamps, candles, and torches casting orange-amber glow. No cool, blue, or daylight tones anywhere in the image. The palette is always warm: deep burgundy reds, burnt ochres, golden ambers, dark earthy browns. Never cold, never desaturated.",
  },
  {
    key: "doctors",
    label: "Doctors Office",
    style: "Photorealistic medical documentary style. Clean, modern environments with soft, diffused lighting. The color palette is very diverse and colorful. The overall composition is clear, professional, and reassuring — suitable for broadcast health education content.",
  },
  {
    key: "family-guy",
    label: "Family Guy",
    style: "American adult animated sitcom style, directly inspired by the character style and visuals of Family Guy and American Dad. Clean 2D vector art with thick black outlines on every element — characters, objects, backgrounds. Flat solid colors with no gradients, no realistic shading, no 3D rendering. Characters have exaggerated facial expressions that communicate emotion instantly. Clothing is flat color blocks with no wrinkles or texture. Backgrounds are clean and minimal, with just enough detail to establish the setting. Objects important to the narrative (credit cards, money, phones, bills, cars) are drawn slightly larger than realistic scale. Floating icons and thought bubbles above characters' heads represent abstract concepts like debt, stress, or goals. The overall feeling is bold, readable, slightly humorous. No 3D, no anime, no painterly effects. Pure Western adult animation, simple and clean.",
  },
  {
	key: "disney",
	label: "Disney",
	style: "Warm 3D stylized cartoon in the style of modern animated shorts — think Pixar SparkShorts, Coco, or Disney+ animated shorts. Characters are Latino/Mexican with clearly Hispanic features: warm skin tones, dark hair, expressive brown eyes. Soft rounded shapes, friendly proportions, slightly stylized but realistic enough to feel relatable. Soft studio lighting with gentle shadows. Rich saturated colors with warm golden tones. Expressive faces that communicate emotion clearly. Clean modern settings (apartment kitchens, small offices, car dealerships) with just enough detail to establish context. Financial objects (credit cards, cash, phones, bills) rendered with slight emphasis to draw the eye. Overall feeling: warm, trustworthy, aspirational, like a financial advisor who's also family."
  }
];

const BATCH_SIZE = 20;

// ─── Component ────────────────────────────────────────────────────────────────

export default function SrtImagesPage() {
  const [step, setStep] = useState<Step>("upload");

  // Step 1
  const [targetSeconds, setTargetSeconds] = useState(15);
  const [imageStyle, setImageStyle] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [imageModel, setImageModel] = useState<ImageModelId>("sourceful/riverflow-v2-fast");
  const [srtEntries, setSrtEntries] = useState<SrtEntry[]>([]);
  const [fileName, setFileName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 2
  const [segments, setSegments] = useState<Segment[]>([]);
  const [editableSegments, setEditableSegments] = useState<string[]>([]);

  // Step 2.5
  const [videoContext, setVideoContext] = useState("");
  const [videoCast, setVideoCast] = useState("");
  const [analyzeError, setAnalyzeError] = useState("");
  const [analyzeUsage, setAnalyzeUsage] = useState<UsageSummary | null>(null);

  // Step 3
  const [descriptions, setDescriptions] = useState<Description[]>([]);
  const [describeProgress, setDescribeProgress] = useState({ done: 0, total: 0 });
  const [describeError, setDescribeError] = useState("");
  const [describeUsage, setDescribeUsage] = useState<UsageSummary | null>(null);
  const [describeBatches, setDescribeBatches] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [regeneratingIndex, setRegeneratingIndex] = useState<number | null>(null);

  // Step 4 – image generation
  const [generatedImages, setGeneratedImages] = useState<(string | null)[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatingIndices, setGeneratingIndices] = useState<number[]>([]);
  const [rewritingIndices, setRewritingIndices] = useState<number[]>([]);
  const [generationProgress, setGenerationProgress] = useState({ done: 0, total: 0 });
  const [imageLogs, setImageLogs] = useState<string[]>([]);
  const imageLogsContainerRef = useRef<HTMLDivElement>(null);

  const [hasRestoredSession, setHasRestoredSession] = useState(false);

  // ── Image log helpers ────────────────────────────────────────────
  const addImageLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setImageLogs((prev) => [...prev, `[${ts}] ${msg}`]);
  }, []);

  useEffect(() => {
    const container = imageLogsContainerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [imageLogs]);

  // ── localStorage: restore on mount ──────────────────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.step) setStep(saved.step);
      if (saved.targetSeconds) setTargetSeconds(saved.targetSeconds);
      if (saved.imageStyle) setImageStyle(saved.imageStyle);
      if (saved.aspectRatio) setAspectRatio(saved.aspectRatio);
      if (saved.imageModel) setImageModel(saved.imageModel);
      if (saved.fileName) setFileName(saved.fileName);
      if (saved.srtEntries) setSrtEntries(saved.srtEntries);
      if (saved.segments) setSegments(saved.segments);
      if (saved.editableSegments) setEditableSegments(saved.editableSegments);
      if (saved.videoContext) setVideoContext(saved.videoContext);
      if (saved.videoCast) setVideoCast(saved.videoCast);
      if (saved.descriptions) setDescriptions(saved.descriptions);
      if (saved.describeUsage) setDescribeUsage(saved.describeUsage);
      if (saved.describeBatches) setDescribeBatches(saved.describeBatches);
      if (saved.step && saved.step !== "upload") setHasRestoredSession(true);
    } catch {
      // corrupted — ignore
    }
  }, []);

  // ── localStorage: save on every relevant change ──────────────────
  useEffect(() => {
    if (step === "analyzing" || step === "describing") return; // don't save mid-flight states
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        step, targetSeconds, imageStyle, aspectRatio, imageModel, fileName,
        srtEntries, segments, editableSegments, videoContext, videoCast,
        descriptions, describeUsage, describeBatches,
      }));
    } catch { /* quota exceeded or SSR — ignore */ }
  }, [step, targetSeconds, imageStyle, aspectRatio, imageModel, videoCast, fileName, srtEntries, segments, editableSegments, videoContext, descriptions, describeUsage, describeBatches]);

  const handleStartFresh = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setStep("upload");
    setFileName("");
    setSrtEntries([]);
    setSegments([]);
    setEditableSegments([]);
    setVideoContext("");
    setVideoCast("");
    setAnalyzeError("");
    setAnalyzeUsage(null);
    setDescriptions([]);
    setDescribeUsage(null);
    setDescribeBatches(0);
    setDescribeError("");
    setLogs([]);
    setGeneratedImages([]);
    setImageLogs([]);
    setGenerationProgress({ done: 0, total: 0 });
    setHasRestoredSession(false);
    setImageStyle("");
    setTargetSeconds(15);
    setAspectRatio("16:9");
    setImageModel("sourceful/riverflow-v2-fast");
  }, []);

  // ── Step 1: parse uploaded SRT ───────────────────────────────────
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      setSrtEntries(parseSrt(content));
    };
    reader.readAsText(file);
  }, []);

  const handleUploadNext = useCallback(() => {
    if (srtEntries.length === 0) return;
    const segs = groupIntoSegments(srtEntries, targetSeconds);
    setSegments(segs);
    setEditableSegments(segs.map((s) => s.text));
    setStep("segments");
  }, [srtEntries, targetSeconds]);

  // ── Step 2: analyze ──────────────────────────────────────────────
  const handleSegmentsNext = useCallback(async () => {
    setSegments((prev) => prev.map((s, i) => ({ ...s, text: editableSegments[i] ?? s.text })));
    setStep("analyzing");
    setAnalyzeError("");

    const first50 = srtEntries.slice(0, 50).map((e) => e.text).join("\n");

    try {
      const res = await fetch("/api/generate-descriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "analyze", first50Lines: first50 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      setVideoContext(data.context);
      setVideoCast(data.cast ?? "");
      setAnalyzeUsage(data.usage);
      setStep("context");
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : String(err));
      setStep("segments");
    }
  }, [editableSegments, srtEntries]);

  // ── Step 2.5: generate descriptions (batched, concurrent) ────────
  const handleContextNext = useCallback(async () => {
    setStep("describing");
    setDescribeError("");
    setLogs([]);

    const segsToDescribe = segments.map((_, i) => editableSegments[i] ?? segments[i].text);
    const windowedSegs = segsToDescribe.map((_, i) => buildWindowedBatchItem(segsToDescribe, i));
    const systemPrompt = `${videoContext}\n\nImage style: ${imageStyle}`;

    const batches: string[][] = [];
    for (let i = 0; i < windowedSegs.length; i += BATCH_SIZE) {
      batches.push(windowedSegs.slice(i, i + BATCH_SIZE));
    }

    const totalBatches = batches.length;
    setDescribeBatches(totalBatches);
    setDescribeProgress({ done: 0, total: segsToDescribe.length });

    const addLog = (msg: string) => {
      const ts = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
      setLogs((prev) => [...prev, `[${ts}] ${msg}`]);
    };

    const allDescriptions: string[] = new Array(segsToDescribe.length).fill("");
    const totalUsage: UsageSummary = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    addLog(`Starting ${totalBatches} batch${totalBatches !== 1 ? "es" : ""} for ${segsToDescribe.length} segments`);

    const runBatch = async (batch: string[], batchIndex: number) => {
      const segStart = batchIndex * BATCH_SIZE + 1;
      const segEnd = segStart + batch.length - 1;
      const label = `Batch ${batchIndex + 1}/${totalBatches} (segments ${segStart}–${segEnd})`;

      addLog(`${label} → started`);
      const t0 = Date.now();

      const res = await fetch("/api/generate-descriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "describe-batch", batch, batchIndex, imageStyle: systemPrompt, cast: videoCast }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(`${label} failed: ${data.error ?? res.status}`);

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const retryNote = data.retriedSlots > 0 ? ` — retried ${data.retriedSlots} empty slot${data.retriedSlots > 1 ? "s" : ""}` : "";
      addLog(`${label} ✓ done in ${elapsed}s (${data.usage?.total_tokens ?? "?"} tokens${retryNote})`);

      const startIdx = batchIndex * BATCH_SIZE;
      (data.descriptions as string[]).forEach((desc, i) => { allDescriptions[startIdx + i] = desc; });

      totalUsage.prompt_tokens += data.usage?.prompt_tokens ?? 0;
      totalUsage.completion_tokens += data.usage?.completion_tokens ?? 0;
      totalUsage.total_tokens += data.usage?.total_tokens ?? 0;

      setDescribeProgress((prev) => ({ ...prev, done: prev.done + batch.length }));
    };

    try {
      await Promise.all(batches.map((batch, batchIndex) => runBatch(batch, batchIndex)));
      addLog(`All batches complete. Total tokens: ${totalUsage.total_tokens}`);
      setDescriptions(segsToDescribe.map((seg, i) => ({ segment: seg, description: allDescriptions[i] ?? "" })));
      setDescribeUsage(totalUsage);
      setStep("descriptions");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`ERROR: ${msg}`);
      setDescribeError(msg);
      setStep("context");
    }
  }, [segments, editableSegments, videoContext, imageStyle]);

  // ── Regenerate a single description ─────────────────────────────
  const handleRegenerateDescription = useCallback(async (index: number) => {
    setRegeneratingIndex(index);
    const systemPrompt = `${videoContext}\n\nImage style: ${imageStyle}`;
    const allSegs = descriptions.map((d) => d.segment);
    const windowedSeg = buildWindowedBatchItem(allSegs, index);
    try {
      const res = await fetch("/api/generate-descriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "describe-batch",
          batch: [windowedSeg],
          batchIndex: 0,
          imageStyle: systemPrompt,
          cast: videoCast,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      const newDesc = (data.descriptions as string[])[0] ?? "";
      setDescriptions((prev) => prev.map((d, i) => i === index ? { ...d, description: newDesc } : d));
    } catch {
      // silently fail — user can retry
    } finally {
      setRegeneratingIndex(null);
    }
  }, [descriptions, videoContext, imageStyle]);

  // ── Step 4: initialise image slots when entering ─────────────────
  const handleGoToImages = useCallback(() => {
    setGeneratedImages((prev) => {
      // Keep any already-generated images; pad/trim to current description count
      const next = [...prev];
      while (next.length < descriptions.length) next.push(null);
      return next.slice(0, descriptions.length);
    });
    setStep("images");
  }, [descriptions.length]);

  // ── Step 4: generate a single image ─────────────────────────────
  const generateOne = useCallback(async (
    index: number,
    log?: (msg: string) => void,
  ): Promise<void> => {
    const num = String(index + 1).padStart(3, "0");
    const prompt = `${imageStyle} The scene: ${descriptions[index].description}`;
    log?.(`Image ${num} → started`);
    const t0 = Date.now();
    const res = await fetch("/api/generate-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, aspectRatio, model: imageModel }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    if (data.imageUrl) {
      setGeneratedImages((prev) => {
        const next = [...prev];
        next[index] = data.imageUrl;
        return next;
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      log?.(`Image ${num} ✓ done in ${elapsed}s`);
    }
  }, [imageStyle, descriptions, aspectRatio, imageModel]);

  const handleGenerateOne = useCallback(async (index: number) => {
    setGeneratingIndices((prev) => [...prev, index]);
    try {
      await generateOne(index, addImageLog);
    } catch (err) {
      const num = String(index + 1).padStart(3, "0");
      addImageLog(`Image ${num} ✗ failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGeneratingIndices((prev) => prev.filter((i) => i !== index));
    }
  }, [generateOne, addImageLog]);

  // ── Step 4: generate all with a sliding concurrency window of 12 ──
  const handleGenerateAll = useCallback(async () => {
    setIsGenerating(true);
    setImageLogs([]);
    const total = descriptions.length;
    setGenerationProgress({ done: 0, total });

    const CONCURRENCY = 12;
    let succeeded = 0;
    let failed = 0;
    let nextIndex = 0;

    addImageLog(`Starting ${total} images with concurrency ${CONCURRENCY}`);

    const runWorker = async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= total) break;
        setGeneratingIndices((prev) => [...prev, index]);
        try {
          await generateOne(index, addImageLog);
          succeeded++;
        } catch (err) {
          failed++;
          const num = String(index + 1).padStart(3, "0");
          addImageLog(`Image ${num} ✗ failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setGeneratingIndices((prev) => prev.filter((i) => i !== index));
          setGenerationProgress((prev) => ({ ...prev, done: prev.done + 1 }));
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, runWorker));

    addImageLog(`Complete — ${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ""}`);
    setIsGenerating(false);
  }, [descriptions.length, generateOne, addImageLog]);

  // ── Step 4: rewrite description then regenerate image ───────────
  const handleRewriteAndRegenerate = useCallback(async (index: number) => {
    setRewritingIndices((prev) => [...prev, index]);
    const num = String(index + 1).padStart(3, "0");
    addImageLog(`Image ${num} — regenerating description…`);
    const systemPrompt = `${videoContext}\n\nImage style: ${imageStyle}`;
    const allSegsForRewrite = descriptions.map((d) => d.segment);
    const windowedSegForRewrite = buildWindowedBatchItem(allSegsForRewrite, index);
    try {
      const res = await fetch("/api/generate-descriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "describe-batch",
          batch: [windowedSegForRewrite],
          batchIndex: 0,
          imageStyle: systemPrompt,
          cast: videoCast,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Description failed");

      const newDesc = (data.descriptions as string[])[0] ?? "";
      addImageLog(`Image ${num} — new description ready, generating image…`);

      setDescriptions((prev) => prev.map((d, i) => i === index ? { ...d, description: newDesc } : d));

      const prompt = `${imageStyle} The scene: ${newDesc}`;
      const imgRes = await fetch("/api/generate-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, aspectRatio, model: imageModel }),
      });
      const imgData = await imgRes.json();
      if (!imgRes.ok) throw new Error(imgData.error ?? `HTTP ${imgRes.status}`);
      if (imgData.imageUrl) {
        setGeneratedImages((prev) => { const next = [...prev]; next[index] = imgData.imageUrl; return next; });
        addImageLog(`Image ${num} ✓ done`);
      }
    } catch (err) {
      addImageLog(`Image ${num} ✗ failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRewritingIndices((prev) => prev.filter((i) => i !== index));
    }
  }, [descriptions, videoContext, imageStyle, videoCast, aspectRatio, imageModel, addImageLog]);

  // ── Step 4: download one image as JPEG ──────────────────────────
  const downloadImage = useCallback(async (index: number) => {
    const url = generatedImages[index];
    if (!url) return;
    const filename = `${String(index + 1).padStart(3, "0")}.jpg`;
    const img = new window.Image();
    await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
    }, "image/jpeg", 0.92);
  }, [generatedImages]);

  // ── Step 4: download all generated images in batches ───────────
  const downloadAll = useCallback(async () => {
    const indices = generatedImages.map((url, i) => url ? i : -1).filter((i) => i >= 0);
    const DOWNLOAD_BATCH = 5;
    for (let start = 0; start < indices.length; start += DOWNLOAD_BATCH) {
      const batch = indices.slice(start, start + DOWNLOAD_BATCH);
      await Promise.all(batch.map((i) => downloadImage(i)));
      if (start + DOWNLOAD_BATCH < indices.length) {
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
  }, [generatedImages, downloadImage]);

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center gap-4">
          <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-200 transition">← Back</Link>
          <h1 className="text-xl font-semibold">SRT → Images</h1>
          <StepBreadcrumb step={step} />
          <div className="ml-auto flex items-center gap-3">
            {hasRestoredSession && (
              <span className="text-xs text-amber-400 bg-amber-950 px-2 py-0.5 rounded border border-amber-800">
                Session restored
              </span>
            )}
            {(step !== "upload" || hasRestoredSession) && (
              <button
                onClick={handleStartFresh}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition"
              >
                Start fresh
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-6 space-y-6">

        {/* ── STEP 1: Upload & Config ── */}
        {step === "upload" && (
          <section className="space-y-6 bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <h2 className="text-lg font-medium">Step 1 — Upload SRT & Configure</h2>

            <div>
              <label className="block text-sm text-zinc-400 mb-2">SRT File</label>
              <div
                className="border-2 border-dashed border-zinc-700 rounded-lg p-8 text-center cursor-pointer hover:border-zinc-500 transition"
                onClick={() => fileInputRef.current?.click()}
              >
                {fileName ? (
                  <p className="text-zinc-200 font-medium">
                    {fileName} <span className="text-zinc-500 font-normal">({srtEntries.length} captions parsed)</span>
                  </p>
                ) : (
                  <p className="text-zinc-500">Click to upload an .srt file</p>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept=".srt,.txt" className="hidden" onChange={handleFileChange} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1">
                <label className="block text-sm text-zinc-400">Seconds per segment</label>
                <input
                  type="number" min={1} max={60} value={targetSeconds}
                  onChange={(e) => setTargetSeconds(Math.max(1, Math.min(60, parseInt(e.target.value) || 15)))}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-sm text-zinc-400">Aspect ratio</label>
                <select
                  value={aspectRatio}
                  onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500"
                >
                  {ASPECT_RATIO_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="block text-sm text-zinc-400">Image model</label>
                <select
                  value={imageModel}
                  onChange={(e) => setImageModel(e.target.value as ImageModelId)}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500"
                >
                  {IMAGE_MODEL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <p className="text-xs text-zinc-500">
                  {IMAGE_MODEL_OPTIONS.find((o) => o.value === imageModel)?.note}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <label className="text-sm text-zinc-400">Image style</label>
                <select
                  onChange={(e) => {
                    const preset = STYLE_PRESETS.find((p) => p.key === e.target.value);
                    if (preset) setImageStyle(preset.style);
                    e.target.value = "";
                  }}
                  defaultValue=""
                  className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500"
                >
                  <option value="" disabled>Load preset…</option>
                  {STYLE_PRESETS.map((p) => (
                    <option key={p.key} value={p.key}>{p.label}</option>
                  ))}
                </select>
              </div>
              <textarea
                value={imageStyle}
                onChange={(e) => setImageStyle(e.target.value)}
                rows={5}
                className="w-full bg-zinc-950 border border-zinc-700 rounded-lg p-3 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500 resize-y"
              />
              <p className="text-xs text-zinc-500">
                Prepended to every image prompt as: <em>"[style] The scene: [description]"</em>
              </p>
            </div>

            <button
              onClick={handleUploadNext}
              disabled={srtEntries.length === 0}
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg text-sm font-medium transition"
            >
              Next →
            </button>
          </section>
        )}

        {/* ── STEP 2: Review Segments ── */}
        {step === "segments" && (
          <section className="space-y-4 bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">Step 2 — Review Segments</h2>
              <span className="text-sm text-zinc-400">{editableSegments.length} segments</span>
            </div>
            {analyzeError && <p className="text-red-400 text-sm bg-red-950 rounded-lg px-4 py-2">{analyzeError}</p>}
            <p className="text-sm text-zinc-400">Each segment is ~{targetSeconds}s. Edit if needed.</p>
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              {segments.map((seg, i) => (
                <div key={i} className="flex gap-3">
                  <div className="flex-shrink-0 text-xs text-zinc-500 font-mono pt-2 w-24">
                    <div>{formatSeconds(seg.startTime)}</div>
                    <div className="text-zinc-600">↓ {formatSeconds(seg.endTime - seg.startTime)}</div>
                  </div>
                  <textarea
                    value={editableSegments[i]}
                    onChange={(e) => { const n = [...editableSegments]; n[i] = e.target.value; setEditableSegments(n); }}
                    rows={2}
                    className="flex-1 bg-zinc-950 border border-zinc-700 rounded-lg p-3 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500 resize-y"
                  />
                </div>
              ))}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setStep("upload")} className="px-5 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm font-medium transition">← Back</button>
              <button onClick={handleSegmentsNext} className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition">Next → (analyze video context)</button>
            </div>
          </section>
        )}

        {/* ── STEP 2.5a: Analyzing ── */}
        {step === "analyzing" && (
          <section className="bg-zinc-900 rounded-xl p-6 border border-zinc-800 space-y-4">
            <h2 className="text-lg font-medium">Analyzing video context…</h2>
            <div className="flex items-center gap-3">
              <Spinner />
              <p className="text-sm text-zinc-400">Sending first 50 caption lines to the model…</p>
            </div>
          </section>
        )}

        {/* ── STEP 2.5b: Review Context ── */}
        {step === "context" && (
          <section className="space-y-4 bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <h2 className="text-lg font-medium">Step 2.5 — Review Video Context</h2>
            <p className="text-sm text-zinc-400">Auto-generated context used as system prompt for image descriptions. Edit as needed.</p>
            {analyzeUsage && (
              <p className="text-xs text-zinc-500">{analyzeUsage.prompt_tokens} input + {analyzeUsage.completion_tokens} output tokens</p>
            )}
            <div className="space-y-1">
              <label className="text-xs text-zinc-500 font-medium">Video context</label>
              <textarea
                value={videoContext}
                onChange={(e) => setVideoContext(e.target.value)}
                rows={4}
                className="w-full bg-zinc-950 border border-zinc-700 rounded-lg p-3 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500 resize-y"
              />
            </div>
            {videoCast && (
              <div className="space-y-1">
                <label className="text-xs text-zinc-500 font-medium">Persistent characters & setting <span className="text-zinc-600">(included in every image)</span></label>
                <textarea
                  value={videoCast}
                  onChange={(e) => setVideoCast(e.target.value)}
                  rows={5}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg p-3 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500 resize-y"
                />
              </div>
            )}
            <div className="flex gap-3">
              <button onClick={() => setStep("segments")} className="px-5 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm font-medium transition">← Back</button>
              <button onClick={handleContextNext} className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition">Next → (generate descriptions)</button>
            </div>
          </section>
        )}

        {/* ── STEP 3a: Generating ── */}
        {step === "describing" && (
          <section className="bg-zinc-900 rounded-xl p-6 border border-zinc-800 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">Generating image descriptions…</h2>
              <span className="text-sm text-zinc-400">{describeProgress.done} / {describeProgress.total} segments</span>
            </div>
            <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: describeProgress.total > 0 ? `${(describeProgress.done / describeProgress.total) * 100}%` : "0%" }}
              />
            </div>
            <div className="bg-zinc-950 rounded-lg border border-zinc-800 p-3 h-56 overflow-y-auto font-mono text-xs space-y-1">
              {logs.length === 0 && <p className="text-zinc-600">Waiting for first batch…</p>}
              {logs.map((line, i) => (
                <p key={i} className={
                  line.includes("ERROR") ? "text-red-400"
                  : line.includes("✓") ? "text-green-400"
                  : line.includes("started") ? "text-blue-400"
                  : "text-zinc-400"
                }>{line}</p>
              ))}
            </div>
            {describeError && <p className="text-red-400 text-sm bg-red-950 rounded-lg px-4 py-2">{describeError}</p>}
          </section>
        )}

        {/* ── STEP 3b: Review Descriptions ── */}
        {step === "descriptions" && (
          <section className="space-y-4 bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <h2 className="text-lg font-medium">Step 3 — Review Descriptions</h2>
              <div className="flex items-center gap-2">
                <button onClick={() => exportJson(descriptions)} className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs font-medium transition">Export JSON</button>
                <button onClick={() => exportCsv(descriptions)} className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs font-medium transition">Export CSV</button>
                <span className="text-sm text-zinc-400">{descriptions.length} descriptions</span>
              </div>
            </div>

            {describeUsage && <CostBreakdown usage={describeUsage} count={descriptions.length} batches={describeBatches} />}

            <p className="text-sm text-zinc-400">Edit any description or regenerate individually before proceeding.</p>

            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              <div className="grid grid-cols-[2rem_1fr_1fr_2rem] gap-2 text-xs text-zinc-500 font-medium pb-1 border-b border-zinc-800 sticky top-0 bg-zinc-900 py-1">
                <span>#</span>
                <span>Caption segment</span>
                <span>Image description</span>
                <span />
              </div>
              {descriptions.map((d, i) => (
                <div key={i} className="grid grid-cols-[2rem_1fr_1fr_2rem] gap-2 items-start">
                  <span className="text-xs text-zinc-500 font-mono pt-2">{i + 1}</span>
                  <textarea
                    readOnly
                    value={d.segment}
                    className="text-xs text-zinc-400 bg-zinc-950 rounded-lg p-2 leading-relaxed resize-none border border-transparent focus:outline-none"
                    style={{ height: "112px" }}
                  />
                  <textarea
                    value={d.description}
                    onChange={(e) => { const n = [...descriptions]; n[i] = { ...n[i], description: e.target.value }; setDescriptions(n); }}
                    className="text-xs bg-zinc-950 border border-zinc-700 rounded-lg p-2 text-zinc-300 focus:outline-none focus:border-zinc-500 resize-none"
                    style={{ height: "112px" }}
                  />
                  <button
                    onClick={() => handleRegenerateDescription(i)}
                    disabled={regeneratingIndex !== null}
                    title="Regenerate this description"
                    className="mt-1 w-7 h-7 flex items-center justify-center rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 transition text-zinc-400 hover:text-zinc-200"
                  >
                    {regeneratingIndex === i ? <Spinner size="sm" /> : <span className="text-sm leading-none">↺</span>}
                  </button>
                </div>
              ))}
            </div>

            <div className="flex gap-3">
              <button onClick={() => setStep("context")} className="px-5 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm font-medium transition">← Back</button>
              <button onClick={handleGoToImages} className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition">Next → (generate images)</button>
            </div>
          </section>
        )}

        {/* ── STEP 4: Image generation ── */}
        {step === "images" && (
          <section className="space-y-4 bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-lg font-medium">Step 4 — Generate Images</h2>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {aspectRatio} · {descriptions.length} images
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleGenerateAll}
                  disabled={isGenerating}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg text-sm font-medium transition"
                >
                  {isGenerating
                    ? `Generating… ${generationProgress.done}/${generationProgress.total}`
                    : "Generate All"}
                </button>
                <button
                  onClick={downloadAll}
                  disabled={!generatedImages.some(Boolean)}
                  className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-zinc-200 rounded-lg text-sm font-medium transition"
                >
                  Download All
                </button>
              </div>
            </div>

            {/* Generation progress bar */}
            {(isGenerating || imageLogs.length > 0) && (
              <div className="space-y-2">
                {isGenerating && (
                  <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 transition-all duration-300"
                      style={{ width: `${(generationProgress.done / generationProgress.total) * 100}%` }}
                    />
                  </div>
                )}
                <div ref={imageLogsContainerRef} className="bg-zinc-950 rounded-lg border border-zinc-800 p-3 h-44 overflow-y-auto font-mono text-xs space-y-1">
                  {imageLogs.length === 0 && <p className="text-zinc-600">Waiting…</p>}
                  {imageLogs.map((line, i) => (
                    <p key={i} className={
                      line.includes("✗") ? "text-red-400"
                      : line.includes("✓") && line.includes("Batch") ? "text-green-400"
                      : line.includes("✓") ? "text-emerald-300"
                      : line.includes("started") ? "text-blue-400"
                      : line.includes("Complete") ? "text-green-400"
                      : "text-zinc-400"
                    }>{line}</p>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-4 gap-3">
              {descriptions.map((d, i) => {
                const num = String(i + 1).padStart(3, "0");
                const imageUrl = generatedImages[i] ?? null;
                const isThisGenerating = generatingIndices.includes(i) || (isGenerating && !imageUrl);
                const isThisRewriting = rewritingIndices.includes(i);
                const isThisBusy = isThisGenerating || isThisRewriting;
                return (
                  <div key={i} className="bg-zinc-950 rounded-xl p-3 border border-zinc-800 flex flex-col gap-2">
                    {/* Image slot */}
                    <div
                      className="w-full bg-zinc-900 rounded-lg border border-zinc-700 overflow-hidden relative flex items-center justify-center"
                      style={aspectRatioStyle(aspectRatio)}
                    >
                      {imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={imageUrl} alt={`Image ${num}`} className="w-full h-full object-cover" />
                      ) : isThisBusy ? (
                        <Spinner />
                      ) : (
                        <button
                          onClick={() => handleGenerateOne(i)}
                          className="text-zinc-500 hover:text-zinc-300 text-xs transition flex flex-col items-center gap-1"
                        >
                          <span className="text-lg">+</span>
                          <span>Generate</span>
                        </button>
                      )}
                    </div>

                    {/* Footer */}
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-mono text-zinc-500">{num}.jpg</span>
                          <div className="relative group/seg">
                            <button className="text-zinc-600 hover:text-zinc-400 text-xs leading-none transition" aria-label="View segment text">☰</button>
                            <div className="absolute bottom-full left-0 mb-2 w-60 bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 rounded-lg p-2.5 hidden group-hover/seg:block z-20 leading-relaxed shadow-xl">
                              {d.segment}
                            </div>
                          </div>
                        </div>
                        {imageUrl && (
                          <button
                            onClick={() => handleGenerateOne(i)}
                            disabled={isThisBusy}
                            title="Re-generate with same prompt"
                            className="text-xs px-1.5 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-400 rounded transition"
                          >↺</button>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleRewriteAndRegenerate(i)}
                          disabled={isThisBusy}
                          title="Rewrite prompt to avoid moderation, then generate"
                          className={`flex-1 flex items-center justify-center text-xs py-1 rounded transition disabled:opacity-40 ${
                            isThisRewriting
                              ? "bg-amber-800 text-amber-200"
                              : "bg-zinc-800 hover:bg-amber-800 text-zinc-300 hover:text-amber-200"
                          }`}
                        >
                          {isThisRewriting ? <Spinner size="sm" /> : "New prompt"}
                        </button>
                        <button
                          onClick={() => downloadImage(i)}
                          disabled={!imageUrl}
                          className="flex-1 text-xs py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-300 rounded transition"
                        >
                          Download
                        </button>
                      </div>
                    </div>

                    <p className="text-xs text-zinc-500 leading-relaxed line-clamp-3">{d.description}</p>
                  </div>
                );
              })}
            </div>

            <button
              onClick={() => setStep("descriptions")}
              disabled={isGenerating}
              className="px-5 py-2.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-300 rounded-lg text-sm font-medium transition"
            >
              ← Back
            </button>
          </section>
        )}

      </main>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Spinner({ size = "md" }: { size?: "sm" | "md" }) {
  const cls = size === "sm"
    ? "w-3.5 h-3.5 border-[1.5px]"
    : "w-5 h-5 border-2";
  return <div className={`${cls} border-zinc-600 border-t-blue-500 rounded-full animate-spin flex-shrink-0`} />;
}

const STEP_LABELS: Record<Step, string> = {
  upload: "1. Upload",
  segments: "2. Segments",
  analyzing: "2.5. Analyzing",
  context: "2.5. Context",
  describing: "3. Generating",
  descriptions: "3. Descriptions",
  images: "4. Images",
};

function StepBreadcrumb({ step }: { step: Step }) {
  return (
    <span className="text-xs font-mono bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded">
      {STEP_LABELS[step]}
    </span>
  );
}

function CostBreakdown({ usage, count, batches }: { usage: UsageSummary; count: number; batches: number }) {
  const cost = calcCost(usage);
  const costPer100 = count > 0 ? (cost.total / count) * 100 : 0;
  return (
    <div className="bg-zinc-950 rounded-lg border border-zinc-800 p-4 space-y-3">
      <p className="text-xs font-medium text-zinc-400">Cost breakdown (o4-mini pricing)</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Batches" value={String(batches)} />
        <Stat label="Input tokens" value={usage.prompt_tokens.toLocaleString()} />
        <Stat label="Output tokens" value={usage.completion_tokens.toLocaleString()} />
        <Stat label="Total cost" value={`$${cost.total.toFixed(5)}`} />
      </div>
      <p className="text-xs text-zinc-500">
        Projected for 100 descriptions: <span className="text-zinc-300 font-medium">${costPer100.toFixed(4)}</span>
        {" · "}Rates: $0.05/1M input · $0.40/1M output.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-sm font-medium text-zinc-200">{value}</p>
    </div>
  );
}
