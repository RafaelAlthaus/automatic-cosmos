import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { DOWNLOAD_CACHE_ROOT, MAX_DOWNLOAD_BYTES } from "@/lib/scraper";

export const maxDuration = 120;

function sanitizeFilename(filename: string) {
  return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim() || "video.mp4";
}

function getFilenameFromContentDisposition(contentDisposition: string) {
  const utf8Match = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return sanitizeFilename(decodeURIComponent(utf8Match[1]).replace(/['"]/g, "").trim());
  }

  const basicMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
  if (basicMatch?.[1]) {
    return sanitizeFilename(basicMatch[1].replace(/['"]/g, "").trim());
  }

  return "";
}

function getVideoContentType(filename: string, upstreamType?: string | null) {
  if (upstreamType?.toLowerCase().startsWith("video/")) return upstreamType;
  if (filename.toLowerCase().endsWith(".mov")) return "video/quicktime";
  return "video/mp4";
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
        "Content-Type": getVideoContentType(filename),
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

    const contentDisposition = fileResponse.headers.get("content-disposition") ?? "";
    const upstreamFilename =
      getFilenameFromContentDisposition(contentDisposition) ||
      (() => {
        try {
          const parts = new URL(url!).pathname.split("/");
          return sanitizeFilename(parts[parts.length - 1] || "");
        } catch {
          return "";
        }
      })();
    const safeFilename =
      upstreamFilename ||
      `${sanitizeFilename(title.slice(0, 80)).replace(/\.(mp4|mov)$/i, "")}.mp4`;
    return new Response(fileResponse.body, {
      headers: {
        "Content-Type": getVideoContentType(safeFilename, fileResponse.headers.get("content-type")),
        "Content-Disposition": `attachment; filename="${safeFilename}"`,
        ...(fileResponse.headers.get("content-length")
          ? { "Content-Length": fileResponse.headers.get("content-length")! }
          : {}),
      },
    });
  } catch (err) {
    return Response.json({ error: `Proxy error: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
}
