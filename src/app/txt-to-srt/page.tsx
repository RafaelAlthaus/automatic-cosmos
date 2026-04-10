"use client";

import { useState, useCallback } from "react";
import Link from "next/link";

const MAX_CHARS = 500;
const DURATION_SECONDS = 50;

function formatSrtTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},000`;
}

function splitIntoChunks(text: string): string[] {
  // Normalize: collapse all whitespace into single spaces
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHARS) {
      chunks.push(remaining);
      break;
    }

    const slice = remaining.slice(0, MAX_CHARS);
    let breakAt = -1;

    // 1. Prefer sentence-ending punctuation (. ! ?) followed by a space
    for (let i = slice.length - 1; i >= 0; i--) {
      if (".!?".includes(slice[i]) && slice[i + 1] === " ") {
        breakAt = i + 1;
        break;
      }
    }

    // 2. Fall back to comma followed by a space
    if (breakAt === -1) {
      for (let i = slice.length - 1; i >= 0; i--) {
        if (slice[i] === "," && slice[i + 1] === " ") {
          breakAt = i + 1;
          break;
        }
      }
    }

    // 3. Fall back to any space
    if (breakAt === -1) {
      const lastSpace = slice.lastIndexOf(" ");
      breakAt = lastSpace > 0 ? lastSpace + 1 : MAX_CHARS;
    }

    chunks.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }

  return chunks;
}

function buildSrt(chunks: string[]): string {
  return chunks
    .map((chunk, i) => {
      const start = formatSrtTime(i * DURATION_SECONDS);
      const end = formatSrtTime((i + 1) * DURATION_SECONDS);
      return `${i + 1}\n${start} --> ${end}\n${chunk}`;
    })
    .join("\n\n");
}

export default function TxtToSrtPage() {
  const [text, setText] = useState("");
  const [chunks, setChunks] = useState<string[]>([]);
  const [srtContent, setSrtContent] = useState("");

  const handleConvert = useCallback(() => {
    const result = splitIntoChunks(text);
    setChunks(result);
    setSrtContent(buildSrt(result));
  }, [text]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([srtContent], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "subtitles.srt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [srtContent]);

  const totalDuration = chunks.length * DURATION_SECONDS;
  const totalMinutes = Math.floor(totalDuration / 60);
  const totalSecs = totalDuration % 60;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-semibold">TXT to SRT</h1>
          <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-200 transition">
            ← Home
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10 space-y-6">

        {/* Input */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 space-y-4">
          <h2 className="text-base font-medium">Input Text</h2>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={12}
            placeholder="Paste your full script or text here..."
            className="w-full bg-zinc-950 border border-zinc-700 rounded-lg p-4 text-sm text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 resize-y font-mono leading-relaxed"
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-zinc-500">
              Each caption: max {MAX_CHARS} chars · {DURATION_SECONDS}s duration · splits at phrase boundaries
            </p>
            <button
              onClick={handleConvert}
              disabled={!text.trim()}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded-lg transition"
            >
              Convert
            </button>
          </div>
        </section>

        {/* Output */}
        {chunks.length > 0 && (
          <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-medium">Result</h2>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {chunks.length} entries · {totalMinutes}m {totalSecs}s total
                </p>
              </div>
              <button
                onClick={handleDownload}
                className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white text-sm font-medium rounded-lg transition"
              >
                Download .srt
              </button>
            </div>

            <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
              {chunks.map((chunk, i) => {
                const start = formatSrtTime(i * DURATION_SECONDS);
                const end = formatSrtTime((i + 1) * DURATION_SECONDS);
                return (
                  <div key={i} className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 space-y-1">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono text-zinc-500">#{i + 1}</span>
                      <span className="text-xs font-mono text-zinc-500">{start} → {end}</span>
                      <span className="text-xs text-zinc-600 ml-auto">{chunk.length} chars</span>
                    </div>
                    <p className="text-sm text-zinc-300 leading-relaxed">{chunk}</p>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
