// Wash Peaks ブログ投稿ボット（Cloudflare Workers）
//
//  LINE で写真とメモを送る →「送信」→ 確認ページのリンクが届く
//  → 確認ページで AI が記事を作成 → 内容を確認して「公開」
//  → GitHub にコミット → Cloudflare Pages が自動でビルド・公開
//
// ルート:
//  POST /line/webhook                 LINE からの受信
//  GET  /d/:id?t=…                    確認ページ
//  GET  /api/d/:id?t=…                下書きの状態
//  POST /api/d/:id/generate?t=…       記事生成（修正依頼も）
//  GET  /api/d/:id/img/:n?t=…         写真
//  POST /api/d/:id/publish?t=…        公開
//  POST /api/d/:id/discard?t=…        破棄

import { verifySignature, reply, linkButton, getContent } from "./line.js";
import { generate, categories } from "./ai.js";
import { commitFiles, listBlogFiles } from "./github.js";
import { markdown, usedImageNumbers, sanitizeSlug, validatePost } from "./markdown.js";
import { previewPage } from "./page.js";

const DAY = 86400;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;   // LINE から受け取る元画像の上限
const MAX_PUBLISH_B64 = 2.6 * 1024 * 1024;  // 公開時（縮小後）の1枚あたり上限 ≒ 2MB
const GEN_LOCK_SEC = 150;

const HELP = [
  "【ブログ投稿の使い方】",
  "1. 記事にしたい写真を送る（最大8枚。1枚目がアイキャッチ候補）",
  "2. 内容のメモを送る（いつ・どこで・何を・お客様の声・カテゴリなど）",
  "3.「送信」と送る → 確認ページのボタンが届きます",
  "4. 確認ページで記事を確認し「公開する」",
  "",
  "その他:「取消」= 送った写真・メモを破棄 /「状態」= 受付状況",
].join("\n");

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/line/webhook" && request.method === "POST") return await webhook(request, env, url);
      let m = url.pathname.match(/^\/d\/([0-9a-f-]{36})$/);
      if (m && request.method === "GET") return html(previewPage(env, m[1], url.searchParams.get("t") || ""));
      m = url.pathname.match(/^\/api\/d\/([0-9a-f-]{36})(?:\/(generate|publish|discard|img\/(\d+)))?$/);
      if (m) return await draftApi(request, env, url, m[1], m[2], m[3]);
      if (url.pathname === "/") return new Response("ok");
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.log("error", e && e.stack);
      return json({ error: e.message || String(e) }, 500);
    }
  },
};

// ================================================================ LINE
async function webhook(request, env, url) {
  const body = await request.text();
  if (!(await verifySignature(env.LINE_CHANNEL_SECRET, body, request.headers.get("x-line-signature")))) {
    return new Response("bad signature", { status: 401 });
  }
  const events = JSON.parse(body).events || [];
  const pending = new Map(); // userId -> { token, kind } 写真・メモ受付の返信は1回にまとめる

  for (const ev of events) {
    if (ev.source?.type !== "user") continue; // グループ・複数人トークは対象外
    const uid = ev.source.userId;

    if (ev.type === "follow") {
      await reply(env, ev.replyToken, "友だち追加ありがとうございます。\nブログ投稿を使うには「登録 合言葉」と送ってください。");
      continue;
    }
    if (ev.type !== "message") continue;
    const msg = ev.message;
    const text = msg.type === "text" ? msg.text.trim() : "";

    const reg = text.match(/^登録\s*(.+)$/);
    if (reg) {
      if (env.REGISTER_CODE && reg[1].trim() === env.REGISTER_CODE) {
        await env.KV.put(`user:${uid}`, String(Date.now()));
        await reply(env, ev.replyToken, "登録しました。\n\n" + HELP);
      } else {
        await reply(env, ev.replyToken, "合言葉が違います。");
      }
      continue;
    }
    if (!(await env.KV.get(`user:${uid}`))) {
      await reply(env, ev.replyToken, "このアカウントは登録制です。「登録 合言葉」と送ってください。");
      continue;
    }

    const seq = `${String(ev.timestamp).padStart(15, "0")}-${msg.id}`;
    if (msg.type === "image") {
      const { mime, data } = await getContent(env, msg.id);
      if (data.byteLength > MAX_IMAGE_BYTES) {
        await reply(env, ev.replyToken, "写真が大きすぎます（10MBまで）。");
        continue;
      }
      const key = `img:${uid}:${seq}`;
      await env.KV.put(key, data, { expirationTtl: 7 * DAY, metadata: { mime } });
      await env.KV.put(`s:${uid}:${seq}`, key, { expirationTtl: 2 * DAY, metadata: { type: "image", mime } });
      pending.set(uid, { token: ev.replyToken });
      continue;
    }
    if (msg.type !== "text") {
      await reply(env, ev.replyToken, "写真とテキストのメッセージに対応しています。");
      continue;
    }

    if (/^(送信|作成|完了)$/.test(text)) {
      pending.delete(uid);
      await submit(env, url, uid, ev.replyToken);
    } else if (/^(取消|取り消し|リセット|キャンセル)$/.test(text)) {
      pending.delete(uid);
      const items = await sessionItems(env, uid);
      await Promise.all(items.map((i) => env.KV.delete(i.name)));
      await reply(env, ev.replyToken, "送った写真・メモを取り消しました。");
    } else if (/^(ヘルプ|使い方|help)$/i.test(text)) {
      await reply(env, ev.replyToken, HELP);
    } else if (/^(状態|確認)$/.test(text)) {
      pending.set(uid, { token: ev.replyToken });
    } else {
      await env.KV.put(`s:${uid}:${seq}`, text.slice(0, 4000), { expirationTtl: 2 * DAY, metadata: { type: "text" } });
      pending.set(uid, { token: ev.replyToken });
    }
  }

  for (const [uid, p] of pending) {
    const items = await sessionItems(env, uid);
    const imgs = items.filter((i) => i.metadata?.type === "image").length;
    const notes = items.length - imgs;
    await reply(env, p.token,
      `受付中: 写真 ${imgs} 枚 / メモ ${notes} 件\n続けて送るか、揃ったら「送信」と送ってください。` +
      (imgs > MAX_IMAGES ? `\n※写真は先頭の${MAX_IMAGES}枚のみ使います。` : ""));
  }
  return new Response("ok");
}

async function sessionItems(env, uid) {
  const out = [];
  let cursor;
  do {
    const r = await env.KV.list({ prefix: `s:${uid}:`, cursor });
    out.push(...r.keys);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function submit(env, url, uid, replyToken) {
  const items = await sessionItems(env, uid);
  if (!items.length) {
    await reply(env, replyToken, "写真かメモを送ってから「送信」と送ってください。\n\n" + HELP);
    return;
  }
  const images = [], notes = [];
  for (const it of items) {
    const v = await env.KV.get(it.name);
    if (v == null) continue;
    if (it.metadata?.type === "image") { if (images.length < MAX_IMAGES) images.push({ key: v, mime: it.metadata.mime || "image/jpeg" }); }
    else notes.push(v);
  }
  if (!images.length) {
    await reply(env, replyToken, "写真が1枚もありません。アイキャッチ用に最低1枚送ってから「送信」してください。");
    return;
  }
  const draft = {
    id: crypto.randomUUID(), token: randomToken(), userId: uid, createdAt: Date.now(),
    status: "ready", images, notes, result: null, error: null, revisions: 0,
  };
  await saveDraft(env, draft);
  await Promise.all(items.map((i) => env.KV.delete(i.name)));
  const link = `${url.origin}/d/${draft.id}?t=${draft.token}`;
  await reply(env, replyToken, linkButton(
    `写真 ${images.length} 枚・メモ ${notes.length} 件で記事を作成します。下のボタンから確認ページを開いてください（7日間有効）。`,
    "記事を作成・確認する", link));
}

// ================================================================ 下書きAPI
async function draftApi(request, env, url, id, action, imgNo) {
  const draft = await loadDraft(env, id);
  if (!draft || !safeEqual(draft.token, url.searchParams.get("t") || "")) return json({ error: "リンクが無効か、期限切れです。" }, 404);

  if (!action && request.method === "GET") return json(view(env, draft, url));

  if (imgNo && request.method === "GET") {
    const im = draft.images[Number(imgNo) - 1];
    const data = im && (await env.KV.get(im.key, "arrayBuffer"));
    if (!data) return new Response("Not found", { status: 404 });
    return new Response(data, { headers: { "content-type": im.mime, "cache-control": "private, max-age=3600" } });
  }
  if (request.method !== "POST") return json({ error: "method" }, 405);
  if (draft.status === "published" || draft.status === "discarded") return json(view(env, draft, url));

  if (action === "discard") {
    draft.status = "discarded";
    await Promise.all(draft.images.map((i) => env.KV.delete(i.key)));
    await saveDraft(env, draft, DAY);
    return json(view(env, draft, url));
  }

  if (action === "generate") {
    const { instruction = "" } = await request.json().catch(() => ({}));
    if (draft.status === "generating" && Date.now() - draft.genStartedAt < GEN_LOCK_SEC * 1000) {
      return json({ ...view(env, draft, url), busy: true }, 409);
    }
    const prev = draft.status === "generating" ? (draft.result ? "generated" : "ready") : draft.status;
    draft.status = "generating"; draft.genStartedAt = Date.now(); draft.error = null;
    await saveDraft(env, draft);
    try {
      const images = [];
      for (const im of draft.images) {
        const data = await env.KV.get(im.key, "arrayBuffer");
        if (!data) throw new Error("写真の保存期限が切れています。LINEからもう一度送ってください。");
        images.push({ mime: im.mime, b64: toB64(data) });
      }
      const result = await generate(env, draft, images, String(instruction).slice(0, 2000));
      result.slug = sanitizeSlug(result.slug);
      result.cover_image = Math.min(Math.max(1, result.cover_image), draft.images.length);
      result.title = String(result.title).replace(/\s*\n\s*/g, " ").trim();
      result.description = String(result.description).replace(/\s*\n\s*/g, " ").trim();
      draft.result = result;
      draft.status = "generated";
      if (instruction) draft.revisions++;
    } catch (e) {
      draft.status = prev;
      draft.error = e.message || String(e);
    }
    await saveDraft(env, draft);
    return json(view(env, draft, url), draft.error ? 502 : 200);
  }

  if (action === "publish") {
    if (draft.status !== "generated" || !draft.result) return json({ ...view(env, draft, url), error: "まだ記事が作成されていません。" }, 400);
    const r = draft.result;
    const errs = validatePost(r, categories(env), draft.images.length);
    if (errs.length) return json({ ...view(env, draft, url), error: "記事に問題があります: " + errs.join(" / ") }, 400);

    const { images: sent = {} } = await request.json().catch(() => ({}));
    const used = usedNumbers(r);
    for (const n of used) {
      const b64 = sent[n];
      if (typeof b64 !== "string" || !b64 || b64.length > MAX_PUBLISH_B64 || /[^A-Za-z0-9+/=]/.test(b64)) {
        return json({ ...view(env, draft, url), error: `写真${n}の変換に失敗しました。ページを再読み込みしてやり直してください。` }, 400);
      }
    }

    const existing = await listBlogFiles(env);
    let slug = r.slug, k = 2;
    while (existing.some((f) => f.endsWith(`-${slug}.md`))) slug = `${r.slug}-${k++}`;
    const date = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const ymd = date.replace(/-/g, "");
    const imgName = (n) => `${ymd}-${slug}-${n === r.cover_image ? "cover" : n}.jpg`;

    const one = (s) => String(s).replace(/[\r\n]+/g, " ").trim();
    const body = r.body.replace(/\]\(image:(\d+)\)/g, (_, n) => `](images/${imgName(Number(n))})`);
    const md = [
      "---",
      `title: ${one(r.title)}`,
      `date: ${date}`,
      `category: ${one(r.category)}`,
      `description: ${one(r.description)}`,
      `cover: images/${imgName(r.cover_image)}`,
      `tags: ${r.tags.map((t) => one(t).replace(/[,、]/g, " ")).filter(Boolean).join(", ")}`,
      "---",
      "",
      body.trim(),
      "",
    ].join("\n");

    const files = [{ path: `content/blog/${date}-${slug}.md`, b64: toB64(new TextEncoder().encode(md)) }];
    for (const n of used) files.push({ path: `content/blog/images/${imgName(n)}`, b64: sent[n] });
    await commitFiles(env, files, `ブログ追加: ${one(r.title)}（LINE投稿）`);

    draft.status = "published";
    draft.publishedUrl = `${String(env.SITE_URL || "").replace(/\/$/, "")}/blog/${slug}`;
    await Promise.all(draft.images.map((i) => env.KV.delete(i.key)));
    await saveDraft(env, draft, 3 * DAY);
    return json(view(env, draft, url));
  }
  return json({ error: "unknown action" }, 400);
}

function usedNumbers(r) {
  return [...new Set([r.cover_image, ...usedImageNumbers(r.body)])].sort((a, b) => a - b);
}

function view(env, d, url) {
  const t = encodeURIComponent(d.token);
  const imgUrl = (n) => `${url.origin}/api/d/${d.id}/img/${n}?t=${t}`;
  const out = { status: d.status, error: d.error, revisions: d.revisions, imageCount: d.images.length, publishedUrl: d.publishedUrl || null };
  if (d.result && d.status !== "discarded" && d.status !== "published") {
    const r = d.result;
    out.result = {
      title: r.title, category: r.category, description: r.description, tags: r.tags, slug: r.slug,
      notes: r.notes_for_reviewer,
      cover: imgUrl(r.cover_image),
      html: markdown(r.body, (src) => { const m = src.match(/^image:(\d+)$/); return m ? imgUrl(Number(m[1])) : null; }),
      used: usedNumbers(r).map((n) => ({ n, src: imgUrl(n) })),
      problems: validatePost(r, categories(env), d.images.length),
    };
  }
  return out;
}

// ================================================================ util
async function loadDraft(env, id) {
  const v = await env.KV.get(`draft:${id}`);
  return v ? JSON.parse(v) : null;
}
function saveDraft(env, d, ttl = 7 * DAY) {
  return env.KV.put(`draft:${d.id}`, JSON.stringify(d), { expirationTtl: ttl });
}
function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function html(body) {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" },
  });
}
