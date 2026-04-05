import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { getDownloadProfile } from "@/lib/download-profiles";
import { getDownloadUrlWithRetry, MAX_DOWNLOAD_BYTES } from "@/lib/scraper";
import type { DownloadProfileName, StoryblocksCookie } from "@/lib/types";

export const maxDuration = 120; // 2 minutes max
const VIDEO_CONTENT_TYPE_PATTERN = /video\/|application\/octet-stream/i;

export async function POST(req: Request) {
  const {
    detailUrl,
    cookies,
    profile,
  }: {
    detailUrl: string;
    cookies: StoryblocksCookie[];
    profile?: DownloadProfileName;
  } = await req.json();

  if (!detailUrl || !cookies?.length) {
    return Response.json({ error: "detailUrl and cookies are required" }, { status: 400 });
  }

  try {
    const config = getDownloadProfile(profile);
    const result = await getDownloadUrlWithRetry(detailUrl, cookies, {
      maxAttempts: config.maxAttempts,
      baseDelayMs: config.retryBaseDelayMs,
      maxDelayMs: config.retryMaxDelayMs,
      captureTimeoutMs: config.captureTimeoutMs,
      downloadTimeoutMs: config.downloadTimeoutMs,
      loginVerified: true,
    });
    const { downloadUrl, error, loggedIn, localFilePath } = result;

    if (error || (!downloadUrl && !localFilePath)) {
      return Response.json(
        { error: error || "Failed to get download URL", loggedIn },
        { status: 500 }
      );
    }

    if (localFilePath) {
      const localStat = await stat(localFilePath);
      if (localStat.size > MAX_DOWNLOAD_BYTES) {
        await rm(path.dirname(localFilePath), { recursive: true, force: true }).catch(() => {});
        return Response.json({ error: "File exceeds 100 MB limit", loggedIn }, { status: 413 });
      }

      const filename = result.filename || path.basename(localFilePath) || "video.mp4";
      const stream = createReadStream(localFilePath);
      stream.on("close", () => {
        void rm(path.dirname(localFilePath), { recursive: true, force: true }).catch(() => {});
      });

      return new Response(Readable.toWeb(stream) as ReadableStream, {
        headers: {
          "Content-Type": "video/mp4",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": String(localStat.size),
        },
      });
    }

    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const fileResponse = await fetch(downloadUrl, {
      headers: {
        Cookie: cookieString,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Referer: "https://www.storyblocks.com/",
      },
      redirect: "follow",
    });

    if (!fileResponse.ok) {
      return Response.json({ downloadUrl, loggedIn }, { status: 200 });
    }

    const contentLength = Number(fileResponse.headers.get("content-length") ?? "0");
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      return Response.json({ error: "File exceeds 100 MB limit", loggedIn }, { status: 413 });
    }
    const remoteContentType = (fileResponse.headers.get("content-type") || "").toLowerCase();
    const looksLikeVideoType = VIDEO_CONTENT_TYPE_PATTERN.test(remoteContentType);
    const looksLikeVideoUrl = /\.mp4(\?|$)|\.mov(\?|$)|\.m4v(\?|$)/i.test(downloadUrl);
    if (!looksLikeVideoType && !looksLikeVideoUrl) {
      return Response.json(
        {
          error: `Unexpected content type from source: ${remoteContentType || "unknown"}`,
          loggedIn,
          downloadUrl,
        },
        { status: 502 }
      );
    }

    const contentDisposition = fileResponse.headers.get("content-disposition") ?? "";
    const cdMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    const cdFilename = cdMatch?.[1]?.replace(/['"]/g, "").trim();
    const urlFilename = (() => {
      try {
        const parts = new URL(downloadUrl).pathname.split("/");
        return parts[parts.length - 1] || "video.mp4";
      } catch {
        return "video.mp4";
      }
    })();
    const filename = (result.filename ?? cdFilename ?? urlFilename) || "video.mp4";

    return new Response(fileResponse.body, {
      headers: {
        "Content-Type": remoteContentType || "video/mp4",
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...(fileResponse.headers.get("content-length")
          ? { "Content-Length": fileResponse.headers.get("content-length")! }
          : {}),
      },
    });
  } catch (err) {
    return Response.json(
      { error: `Download failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
