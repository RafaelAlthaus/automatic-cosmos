import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { DOWNLOAD_CACHE_ROOT, MAX_DOWNLOAD_BYTES } from "@/lib/scraper";

export const maxDuration = 120;

function sanitizeFilename(filename: string) {
  return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim() || "video.mp4";
}

function isWithinDownloadCache(targetPath: string) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(DOWNLOAD_CACHE_ROOT);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");
  const localPath = searchParams.get("localPath");
  const title = searchParams.get("title") ?? "video";
  const filenameParam = searchParams.get("filename");

  if (!url && !localPath) {
    return Response.json({ error: "url or localPath is required" }, { status: 400 });
  }

  if (localPath) {
    const resolvedLocalPath = path.resolve(localPath);
    if (!isWithinDownloadCache(resolvedLocalPath)) {
      return Response.json({ error: "Invalid localPath" }, { status: 400 });
    }

    const fileStat = await stat(resolvedLocalPath).catch(() => null);
    if (!fileStat?.isFile()) {
      return Response.json({ error: "Cached file not found" }, { status: 404 });
    }
    if (fileStat.size > MAX_DOWNLOAD_BYTES) {
      void rm(path.dirname(resolvedLocalPath), { recursive: true, force: true }).catch(() => {});
      return Response.json({ error: "File exceeds 100 MB limit" }, { status: 413 });
    }

    const stream = createReadStream(resolvedLocalPath);
    stream.on("close", () => {
      void rm(path.dirname(resolvedLocalPath), { recursive: true, force: true }).catch(() => {});
    });

    const filename = sanitizeFilename(filenameParam || path.basename(resolvedLocalPath));
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(fileStat.size),
      },
    });
  }

  try {
    const fileResponse = await fetch(url!, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Referer: "https://www.storyblocks.com/",
      },
      redirect: "follow",
    });

    if (!fileResponse.ok) {
      return Response.json({ error: `Failed to fetch file: ${fileResponse.status}` }, { status: 502 });
    }

    const contentLength = Number(fileResponse.headers.get("content-length") ?? "0");
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      return Response.json({ error: "File exceeds 100 MB limit" }, { status: 413 });
    }

    const safeTitle = sanitizeFilename(title.slice(0, 80)).replace(/\.mp4$/i, "");
    return new Response(fileResponse.body, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="${safeTitle}.mp4"`,
        ...(fileResponse.headers.get("content-length")
          ? { "Content-Length": fileResponse.headers.get("content-length")! }
          : {}),
      },
    });
  } catch (err) {
    return Response.json({ error: `Proxy error: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
}
