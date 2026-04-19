import OpenAI from "openai";
import { NextRequest } from "next/server";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = "o4-mini";

const DESCRIBE_SYSTEM_PROMPT = (context: string, cast?: string) => `You are a visual art director creating detailed image prompts for an AI image generator.

Video context:
${context}${cast ? `\n\nPersistent characters and setting — the primary subject MUST appear in every image:\n${cast}\n\nCharacter rules:\n- The primary subject must be present and visible in every single image, dressed exactly as described above.\n- Their pose, expression, and action must directly reflect what is happening in the specific caption.\n- The time period and geographic setting listed above are fixed for ALL images. No modern clothes, no modern objects, no suits, no contemporary interiors unless stated.\n- Never include a host, narrator, presenter, or on-camera talking head. There is no presenter — only the people in the story.\n- If a caption is abstract or philosophical (e.g. "but they were all wrong"), depict the primary subject in a dramatically lit scene that reflects the concept — do not invent modern characters or settings.` : ""}

ABSOLUTE RULES — apply to every image regardless of context:
- Never include a host, narrator, or presenter character. No one speaks to camera.

Some batch items may be wrapped in context markers:
  [CONTEXT — preceding]: text from earlier segments
  [FOCUS — generate image for this]: the exact moment this image must depict
  [CONTEXT — following]: text from later segments
When these markers are present, generate a description that depicts ONLY the FOCUS moment. Use the CONTEXT sections to understand narrative flow and avoid generic scenes — but never depict the context segments themselves in the image.

CRITICAL — Depict what is LITERALLY described in each caption, not the video's general theme:
- Read each caption as an isolated moment. Ask: what specific action, emotion, or event is happening RIGHT NOW?
- The character's body language, expression, and what they are doing must match the caption exactly.
- Example: if the caption says "she looked in the mirror and noticed her tired, puffy eyes", the image must show her face reflected in a mirror with visible fatigue — NOT a product, NOT a generic portrait.
- Example: if the caption says "this ingredient repairs the skin barrier overnight", show the character examining a product label or holding a bottle, engaged with that object — NOT a generic standing pose.
- If the caption mentions a specific object or product, it must be prominently visible and the character must be interacting with it.
- If the caption describes an emotion or realization, show it on the character's face and body — what does that look like concretely?
- Never skip ahead to conclusions, products, or themes that come later in the video.

For each caption segment write a detailed image description covering:
- The character's exact pose, action, and facial expression as it relates to THIS caption's moment
- What the character is holding, touching, looking at, or interacting with
- Clothing and accessories: fabric, color, style
- Background and setting: location, surfaces, environment, time of day
- Objects and props in the scene and their relationship to the character
- Lighting: direction, quality, color temperature
- Color palette and mood
Do NOT describe abstract feelings — only concrete visible elements an image generator can render.
Always write descriptions in English, regardless of the language of the caption segments.

Image moderation guidelines (the image generator has strict content filters — follow these exactly):
- All figures must be fully clothed in period-appropriate robes, mantles, or garments. Describe garments in full detail.
- Convey spiritual or emotional closeness through composition, lighting, halos, and facial expressions — not through physical contact between figures.
- If a caption implies a kiss or any touch between two people, describe instead: figures standing apart facing each other, light emanating between them, a shared gaze, a raised hand in blessing, or a symbolic object (scroll, light, vessel) held between them.
- Describe people by their role, clothing, and expression. Avoid describing skin in racial or ethnic terms; use garment and setting details instead.
- Avoid the words: "bodies", "lips", "romantic", "intimate", "embrace", "kiss", "touch", "contact". Replace these with compositional and symbolic alternatives.
- Frame every scene as a formal, dignified, reverent, and appropriate for all audiences.

You will receive a JSON array of caption segments. Return ONLY a valid JSON array of strings of the exact same length, one description per segment. No extra text, no markdown, just the JSON array.`;

export async function POST(request: NextRequest) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });
  }

  const body = await request.json();
  const { action } = body as { action: string };

  // ── action: analyze ──────────────────────────────────────────────
  if (action === "analyze") {
    const { first50Lines } = body as { first50Lines: string };
    if (!first50Lines) return Response.json({ error: "first50Lines required" }, { status: 400 });

    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a visual art director and video analyst. Your job is to read caption lines from a video and extract information that will be used to generate consistent image descriptions across the entire video. Always respond in English, regardless of the language of the captions. Return only valid JSON with no extra text.",
        },
        {
          role: "user",
          content: `Here are the first lines of captions from a video:\n\n${first50Lines}\n\nReturn a JSON object with exactly two fields:\n\n1. "context": A concise paragraph (3-5 sentences) covering what this video is fundamentally teaching, its tone, and the visual style image descriptions should follow.\n\n2. "cast": A detailed paragraph describing the PRIMARY SUBJECT and persistent visual elements for ALL images:\n- Who is this video's primary subject? (the person, situation, or character being illustrated — not a presenter or host)\n- Primary subject: their name/role, physical appearance (hair, build, age), and exact clothing/style for their setting\n- Secondary characters who are part of the story alongside the primary subject\n- The time period and geographic setting of all images\n- Recurring locations and environments typical of the story\n- Any recurring props or objects central to the narrative\n\nCRITICAL: Do NOT include any host, narrator, presenter, or on-camera talking head in the cast — only people who appear inside the story being told. Do NOT include text overlays, price tags, or graphic elements as recurring visual symbols. Images are always pure visual scenes with no on-screen text.\n\nBe specific enough that an AI image generator can render the same characters in the correct setting consistently across every scene.`,
        },
      ],
    });

    const raw = completion.choices[0].message.content ?? "{}";
    let context = "";
    let cast = "";
    try {
      const parsed = JSON.parse(raw);
      context = parsed.context ?? raw;
      cast = parsed.cast ?? "";
    } catch {
      // model didn't return JSON — treat the whole thing as context
      context = raw;
    }

    return Response.json({
      context,
      cast,
      usage: completion.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  // ── action: describe-batch ───────────────────────────────────────
  // Called once per batch from the client. The client fires all batches
  // concurrently and writes results into pre-allocated slots by batchIndex.
  if (action === "describe-batch") {
    const { batch, batchIndex, imageStyle, cast } = body as {
      batch: string[];
      batchIndex: number;
      imageStyle: string;
      cast?: string;
    };
    if (!batch || batch.length === 0) return Response.json({ error: "batch required" }, { status: 400 });
    if (!imageStyle) return Response.json({ error: "imageStyle required" }, { status: 400 });

    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: DESCRIBE_SYSTEM_PROMPT(imageStyle, cast) },
        { role: "user", content: JSON.stringify(batch) },
      ],
    });

    const raw = completion.choices[0].message.content ?? "[]";
    let descriptions: string[];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      // Accept partial arrays — fill missing trailing slots below
      descriptions = parsed;
    } catch {
      descriptions = [];
    }

    // Ensure we always have exactly batch.length entries.
    // Retry any slot that is missing or empty with a single-segment call.
    const totalUsage = { ...(completion.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }) };
    const retryIndices = batch.map((_, i) => i).filter((i) => !descriptions[i]?.trim());

    if (retryIndices.length > 0) {
      await Promise.all(retryIndices.map(async (i) => {
        const retry = await openai.chat.completions.create({
          model: MODEL,
          messages: [
            { role: "system", content: DESCRIBE_SYSTEM_PROMPT(imageStyle, cast) },
            { role: "user", content: JSON.stringify([batch[i]]) },
          ],
        });
        const retryRaw = retry.choices[0].message.content ?? "[]";
        try {
          const retryParsed = JSON.parse(retryRaw);
          descriptions[i] = Array.isArray(retryParsed) ? (retryParsed[0] ?? "") : "";
        } catch {
          descriptions[i] = "";
        }
        if (retry.usage) {
          totalUsage.prompt_tokens += retry.usage.prompt_tokens;
          totalUsage.completion_tokens += retry.usage.completion_tokens;
          totalUsage.total_tokens += retry.usage.total_tokens;
        }
      }));
    }

    return Response.json({
      descriptions: batch.map((_, i) => descriptions[i] ?? ""),
      batchIndex,
      usage: totalUsage,
      retriedSlots: retryIndices.length,
    });
  }

  // ── action: rewrite ──────────────────────────────────────────────
  // Rewrite a single description that was rejected by the image model's
  // content moderation, producing a safer alternative while keeping the theme.
  if (action === "rewrite") {
    const { description, segment } = body as { description: string; segment: string };
    if (!description) return Response.json({ error: "description required" }, { status: 400 });

    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: `You are a visual art director. An image description was rejected by an AI image generator's content moderation system. Your job is to rewrite it so it passes moderation while preserving the visual theme and narrative intent.

Rewriting rules:
- Keep all setting details (architecture, lighting, props, color palette).
- Replace any physical proximity or contact between figures with symbolic alternatives: a beam of light between them, a shared glowing object, a raised hand in blessing, figures looking toward the same light source.
- Replace any intimate, romantic, or ambiguous posture language with formal, ceremonial posture language.
- All figures must be clearly fully clothed and stationary.
- Do not use the words: bodies, lips, romantic, intimate, embrace, kiss, touch, contact, breath between, rising between.
- Return ONLY the rewritten description as plain text. No explanation, no preamble.`,
        },
        {
          role: "user",
          content: `Caption segment: "${segment}"\n\nOriginal description (rejected by moderation):\n${description}\n\nWrite a moderation-safe alternative:`,
        },
      ],
    });

    const rewritten = completion.choices[0].message.content?.trim() ?? description;
    return Response.json({
      description: rewritten,
      usage: completion.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  return Response.json({ error: "Invalid action" }, { status: 400 });
}
