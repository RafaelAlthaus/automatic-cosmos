import { describe, expect, it } from "vitest";
import { classifyDownloadError, computeBackoffMs, groupVideosByResultIndex } from "./download-queue";
import type { DownloadBatchInputVideo } from "./types";

describe("groupVideosByResultIndex", () => {
  it("keeps strict ordering by resultIndex then slotIndex", () => {
    const input: DownloadBatchInputVideo[] = [
      { detailUrl: "/v3", title: "v3", searchUrl: "/s2", resultIndex: 2, slotIndex: 1, sequenceIndex: 4 },
      { detailUrl: "/v1", title: "v1", searchUrl: "/s1", resultIndex: 0, slotIndex: 1, sequenceIndex: 2 },
      { detailUrl: "/v0", title: "v0", searchUrl: "/s1", resultIndex: 0, slotIndex: 0, sequenceIndex: 1 },
      { detailUrl: "/v2", title: "v2", searchUrl: "/s2", resultIndex: 2, slotIndex: 0, sequenceIndex: 3 },
    ];

    const grouped = groupVideosByResultIndex(input);
    expect(grouped.map((group) => group.resultIndex)).toEqual([0, 2]);
    expect(grouped[0].videos.map((video) => video.slotIndex)).toEqual([0, 1]);
    expect(grouped[0].videos.map((video) => video.detailUrl)).toEqual(["/v0", "/v1"]);
    expect(grouped[1].videos.map((video) => video.slotIndex)).toEqual([0, 1]);
    expect(grouped[1].videos.map((video) => video.detailUrl)).toEqual(["/v2", "/v3"]);
  });
});

describe("classifyDownloadError", () => {
  it("classifies known transient failures", () => {
    expect(classifyDownloadError("Navigation timeout of 30000 ms exceeded")).toBe("transient");
    expect(classifyDownloadError("Protocol error (Page.navigate): Target closed")).toBe("transient");
  });

  it("classifies terminal failures", () => {
    expect(classifyDownloadError("Not logged in — cookies may be expired or invalid")).toBe("terminal");
    expect(classifyDownloadError("No supported HD format under 100 MB (HDMP4 or HDMOV)")).toBe("terminal");
  });
});

describe("computeBackoffMs", () => {
  it("grows up to max delay", () => {
    const low = computeBackoffMs(1, 200, 800, 0);
    const medium = computeBackoffMs(2, 200, 800, 0);
    const high = computeBackoffMs(6, 200, 800, 0);

    expect(low).toBe(200);
    expect(medium).toBe(400);
    expect(high).toBe(800);
  });
});

