import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { getDownloadUrl, MAX_DOWNLOAD_BYTES } from "@/lib/scraper";
import type { StoryblocksCookie } from "@/lib/types";

export const maxDuration = 120; // 2 minutes max

function getFilenameFromContentDisposition(contentDisposition: string) {
  const utf8Match = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]).replace(/['"]/g, "").trim();
  }

  const basicMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
  return basicMatch?.[1]?.replace(/['"]/g, "").trim() || "";
}

function getVideoContentType(filename: string, upstreamType?: string | null) {
  if (upstreamType?.toLowerCase().startsWith("video/")) return upstreamType;
  if (filename.toLowerCase().endsWith(".mov")) return "video/quicktime";
  return "video/mp4";
}

export async function POST(req: Request) {
  const { detailUrl, cookies }: { detailUrl: string; cookies: StoryblocksCookie[] } = await req.json();

  if (!detailUrl || !cookies?.length) {
    return Response.json({ error: "detailUrl and cookies are required" }, { status: 400 });
  }

  try {
    const result = await getDownloadUrl(detailUrl, cookies);
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

      const fileBuffer = await readFile(localFilePath);
      const filename = result.filename || path.basename(localFilePath) || "video.mp4";
      await rm(path.dirname(localFilePath), { recursive: true, force: true }).catch(() => {});

      return new Response(fileBuffer, {
        headers: {
          "Content-Type": getVideoContentType(filename),
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": String(fileBuffer.byteLength),
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

    const contentDisposition = fileResponse.headers.get("content-disposition") ?? "";
    const cdFilename = getFilenameFromContentDisposition(contentDisposition);
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
        "Content-Type": getVideoContentType(filename, fileResponse.headers.get("content-type")),
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
