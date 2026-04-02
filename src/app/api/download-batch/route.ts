import { getDownloadUrl } from "@/lib/scraper";
import type { StoryblocksCookie } from "@/lib/types";

export const maxDuration = 300;
const DOWNLOAD_BATCH_CONCURRENCY = 6;

export async function POST(req: Request) {
  try {
    const { videos, cookies }: {
      videos: { detailUrl: string; title: string; searchUrl: string; resultIndex: number; slotIndex: number }[];
      cookies: StoryblocksCookie[];
    } = await req.json();

    if (!videos?.length || !cookies?.length) {
      return Response.json({ error: "videos and cookies are required" }, { status: 400 });
    }

    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const sendLine = (payload: object) => {
          controller.enqueue(enc.encode(`${JSON.stringify(payload)}\n`));
        };

        try {
          for (let start = 0; start < videos.length; start += DOWNLOAD_BATCH_CONCURRENCY) {
            const batch = videos.slice(start, start + DOWNLOAD_BATCH_CONCURRENCY);
            const batchResults = await Promise.all(
              batch.map(async (video) => {
                try {
                  // Each concurrent item gets its own isolated browser session.
                  // Sharing a browser here causes download-path collisions and can
                  // mix up files between videos.
                  const result = await getDownloadUrl(video.detailUrl, cookies);
                  const proxyUrl = result.localFilePath
                    ? `/api/proxy-file?localPath=${encodeURIComponent(result.localFilePath)}&filename=${encodeURIComponent(
                        result.filename || `${video.title || "video"}.mp4`
                      )}`
                    : undefined;

                  return {
                    detailUrl: video.detailUrl,
                    title: video.title,
                    searchUrl: video.searchUrl,
                    resultIndex: video.resultIndex,
                    slotIndex: video.slotIndex,
                    downloadUrl: result.downloadUrl || undefined,
                    proxyUrl,
                    error: result.error,
                    loggedIn: result.loggedIn,
                  };
                } catch (err) {
                  return {
                    detailUrl: video.detailUrl,
                    title: video.title,
                    searchUrl: video.searchUrl,
                    resultIndex: video.resultIndex,
                    slotIndex: video.slotIndex,
                    error: `Batch item failed: ${err instanceof Error ? err.message : String(err)}`,
                  };
                }
              })
            );

            for (const batchResult of batchResults) {
              sendLine(batchResult);
            }
          }
        } catch (err) {
          sendLine({
            detailUrl: "",
            title: "",
            searchUrl: "",
            error: `Batch startup failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        } finally {
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
