import { scrapeSearchUrls } from "@/lib/scraper";
import type { StoryblocksCookie, ProgressEvent } from "@/lib/types";

export const maxDuration = 300; // 5 minutes max

export async function POST(req: Request) {
  const { urls, cookies }: { urls: string[]; cookies: StoryblocksCookie[] } = await req.json();

  if (!urls?.length || !cookies?.length) {
    return Response.json({ error: "URLs and cookies are required" }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ProgressEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // Stream may have been closed
        }
      };

      try {
        await scrapeSearchUrls(urls, cookies, send);
      } catch (err) {
        send({
          type: "error",
          message: `Fatal error: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "Transfer-Encoding": "chunked",
    },
  });
}
