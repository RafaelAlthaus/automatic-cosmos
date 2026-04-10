import { NextRequest } from "next/server";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
// Our internal aspect ratios map 1:1 to OpenRouter's supported values
const ASPECT_RATIO_MAP: Record<string, string> = {
  "1:1":  "1:1",
  "16:9": "16:9",
  "9:16": "9:16",
  "4:3":  "4:3",
};

export async function POST(request: NextRequest) {
  if (!process.env.OPENROUTER_API_KEY) {
    return Response.json({ error: "OPENROUTER_API_KEY not configured" }, { status: 500 });
  }

  const { prompt, aspectRatio, model } = await request.json() as {
    prompt: string;
    aspectRatio: string;
    model: string;
  };

  if (!prompt) return Response.json({ error: "prompt required" }, { status: 400 });

  const safePrompt = prompt;

  const orAspectRatio = ASPECT_RATIO_MAP[aspectRatio] ?? "1:1";

  const orResponse = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || "sourceful/riverflow-v2-fast",
      messages: [{ role: "user", content: safePrompt }],
      modalities: ["image"],
      image_config: {
        aspect_ratio: orAspectRatio,
        image_size: "1K",
      },
    }),
  });

  const data = await orResponse.json().catch(() => null);

  if (!orResponse.ok || !data) {
    const message = data?.error?.message ?? `OpenRouter error ${orResponse.status}`;
    const metadata = data?.error?.metadata;
    // metadata may contain provider-level detail, e.g. { raw: "...", provider_name: "..." }
    const detail = metadata?.raw ?? metadata?.provider_name ?? null;
    const fullError = detail ? `${message} — ${detail}` : message;
    console.error("[generate-images] OpenRouter error:", JSON.stringify(data?.error ?? data));
    return Response.json({ error: fullError }, { status: orResponse.status || 502 });
  }

  const imageUrl = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? null;

  if (!imageUrl) {
    console.error("[generate-images] Unexpected response shape:", JSON.stringify(data));
    return Response.json({ error: "No image in response" }, { status: 502 });
  }

  return Response.json({ imageUrl });
}
