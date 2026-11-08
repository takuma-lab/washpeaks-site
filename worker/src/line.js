// LINE Messaging API

export async function verifySignature(secret, body, signature) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function api(env, url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.log("LINE API error", url, res.status, await res.text());
  return res.ok;
}

export function reply(env, replyToken, messages) {
  const list = (Array.isArray(messages) ? messages : [messages]).map((m) => (typeof m === "string" ? { type: "text", text: m } : m));
  return api(env, "https://api.line.me/v2/bot/message/reply", { replyToken, messages: list });
}

export function linkButton(text, label, uri) {
  return {
    type: "template",
    altText: `${text} ${uri}`.slice(0, 400),
    template: { type: "buttons", text: text.slice(0, 160), actions: [{ type: "uri", label: label.slice(0, 20), uri }] },
  };
}

/** 画像本体を取得 */
export async function getContent(env, messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`LINE画像の取得に失敗 (${res.status})`);
  return { mime: res.headers.get("content-type") || "image/jpeg", data: await res.arrayBuffer() };
}
