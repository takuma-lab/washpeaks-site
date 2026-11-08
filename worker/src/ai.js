// AI（Gemini / OpenAI）で記事を生成する。env.AI_PROVIDER で切り替え。
import PROMPT from "./prompt.md";

const FIELDS = ["title", "slug", "category", "description", "tags", "cover_image", "body", "notes_for_reviewer"];

function systemPrompt(env) {
  return PROMPT.replace("{{CATEGORIES}}", categories(env).join(" / "));
}

export function categories(env) {
  return String(env.CATEGORIES || "お知らせ,導入事例,コラム,開業ノウハウ").split(",").map((s) => s.trim()).filter(Boolean);
}

function userText(draft, instruction) {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  let t = `今日の日付: ${today}\n写真の枚数: ${draft.images.length}\n\n担当者のメモ:\n${draft.notes.join("\n") || "（メモなし。写真から内容を読み取って書き、notes_for_reviewer で情報不足を伝える）"}`;
  if (instruction && draft.result) {
    t += `\n\n---\n前回作成した記事(JSON):\n${JSON.stringify(draft.result)}\n\n担当者からの修正依頼:\n${instruction}\n\n修正依頼を反映して、記事全体を出し直してください。`;
  }
  return t;
}

/** @param images {mime:string, b64:string}[] */
export async function generate(env, draft, images, instruction) {
  const provider = (env.AI_PROVIDER || "gemini").toLowerCase();
  const raw = provider === "openai"
    ? await openai(env, systemPrompt(env), userText(draft, instruction), images)
    : await gemini(env, systemPrompt(env), userText(draft, instruction), images);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("AIの応答を読み取れませんでした。もう一度お試しください。");
  }
  for (const f of FIELDS) if (!(f in data)) throw new Error(`AIの応答に「${f}」がありません。もう一度お試しください。`);
  data.tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
  data.notes_for_reviewer = Array.isArray(data.notes_for_reviewer) ? data.notes_for_reviewer.map(String) : [];
  data.cover_image = Number(data.cover_image) || 1;
  return data;
}

// ---------------------------------------------------------------- Gemini
async function gemini(env, system, text, images) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY が設定されていません");
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const S = (type, extra = {}) => ({ type, ...extra });
  const schema = S("OBJECT", {
    properties: {
      title: S("STRING"), slug: S("STRING"), category: S("STRING"), description: S("STRING"),
      tags: S("ARRAY", { items: S("STRING") }), cover_image: S("INTEGER"), body: S("STRING"),
      notes_for_reviewer: S("ARRAY", { items: S("STRING") }),
    },
    required: FIELDS,
    propertyOrdering: FIELDS,
  });
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text }, ...images.map((i) => ({ inlineData: { mimeType: i.mime, data: i.b64 } }))] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.7 },
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini APIエラー (${res.status}): ${j.error?.message || "不明"}`);
  const out = j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
  if (!out) throw new Error(`Geminiが記事を返しませんでした（${j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || "理由不明"}）`);
  return out;
}

// ---------------------------------------------------------------- OpenAI
async function openai(env, system, text, images) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY が設定されていません");
  const model = env.OPENAI_MODEL || "gpt-4.1-mini";
  const str = { type: "string" }, arr = { type: "array", items: { type: "string" } };
  const schema = {
    type: "object", additionalProperties: false, required: FIELDS,
    properties: { title: str, slug: str, category: str, description: str, tags: arr, cover_image: { type: "integer" }, body: str, notes_for_reviewer: arr },
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: [{ type: "text", text }, ...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.b64}` } }))] },
      ],
      response_format: { type: "json_schema", json_schema: { name: "blog_post", strict: true, schema } },
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI APIエラー (${res.status}): ${j.error?.message || "不明"}`);
  const msg = j.choices?.[0]?.message;
  if (!msg?.content) throw new Error(`OpenAIが記事を返しませんでした（${msg?.refusal || j.choices?.[0]?.finish_reason || "理由不明"}）`);
  return msg.content;
}
