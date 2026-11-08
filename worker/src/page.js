// 確認ページ（スマホで LINE から開く想定）。本番サイトの CSS を読み込み、公開後と同じ見た目でプレビューする。
import { esc } from "./markdown.js";

export function previewPage(env, id, token) {
  const site = String(env.SITE_URL || "").replace(/\/$/, "");
  const cfg = JSON.stringify({ id, token }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>記事の確認｜Wash Peaks</title>
<link rel="stylesheet" href="${esc(site)}/css/style.css">
<style>
  body { padding-bottom: 120px; }
  .bar { position: sticky; top: 0; z-index: 60; background: #b39a73; color: #fff; text-align: center; font-size: 13px; padding: 8px 12px; padding-top: calc(8px + env(safe-area-inset-top, 0px)); font-weight: 700; }
  .box { max-width: 780px; margin: 24px auto; padding: 18px 20px; border: 1px solid var(--line-strong); background: var(--navy-700); font-size: 14px; }
  .box h2 { font-family: var(--sans); font-size: 15px; font-weight: 700; margin-bottom: 8px; letter-spacing: .04em; }
  .box ul { margin: 0; padding-left: 1.2em; color: var(--text-sub); }
  .box.warn { border-color: #e0a35a; } .box.warn h2 { color: #f0b46a; }
  .box.err { border-color: #ff9b8a; } .box.err h2 { color: #ff9b8a; }
  .box.ok { border-color: var(--gold); text-align: center; }
  .meta { max-width: 780px; margin: 0 auto; font-size: 13px; color: var(--text-sub); }
  .meta b { color: var(--text); font-weight: 500; }
  .actions-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 60; background: rgba(7,18,38,.96); border-top: 1px solid var(--line); padding: 12px 16px; padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px)); display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  .actions-bar .btn { flex: 1 1 140px; max-width: 260px; padding: 14px 12px; }
  .revise textarea { width: 100%; min-height: 110px; padding: 12px; background: var(--navy-800); color: var(--text); border: 1px solid var(--line-strong); font: inherit; font-size: 15px; margin: 8px 0 12px; }
  .center { text-align: center; padding: 80px 20px; }
  .spinner { width: 42px; height: 42px; margin: 0 auto 20px; border: 3px solid var(--line-strong); border-top-color: var(--gold); border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  [disabled] { opacity: .5; pointer-events: none; }
</style>
</head>
<body>
<div class="bar" id="bar">下書きプレビュー（まだ公開されていません）</div>
<main id="app"><div class="center"><div class="spinner"></div>読み込み中…</div></main>
<div class="actions-bar" id="actions" hidden>
  <button class="btn btn-gold" id="btn-publish">公開する</button>
  <button class="btn btn-outline" id="btn-revise">修正を依頼</button>
  <button class="btn btn-outline" id="btn-discard">やめる</button>
</div>
<script>
const CFG = ${cfg};
const API = "/api/d/" + CFG.id;
const Q = "?t=" + encodeURIComponent(CFG.token);
const app = document.getElementById("app");
const actions = document.getElementById("actions");
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === "html" ? (el.innerHTML = v) : k === "class" ? (el.className = v) : el.setAttribute(k, v);
  for (const c of kids) if (c != null) el.append(c);
  return el;
};

async function call(path, body) {
  const res = await fetch(API + path + Q, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: "通信エラーが発生しました。" }));
  return { status: res.status, data };
}

function loading(text) {
  actions.hidden = true;
  app.replaceChildren(h("div", { class: "center" }, h("div", { class: "spinner" }), text));
}

function message(cls, title, text, link) {
  actions.hidden = true;
  const box = h("div", { class: "box " + cls }, h("h2", {}, title), h("p", {}, text));
  if (link) box.append(h("p", { style: "margin-top:16px" }, h("a", { class: "btn btn-gold", href: link, target: "_blank", rel: "noopener" }, "公開ページを見る")));
  app.replaceChildren(h("div", { class: "wrap" }, box));
}

async function start() {
  const { status, data } = await call("");
  if (status !== 200) return message("err", "開けませんでした", data.error || "リンクが無効か、期限切れです。");
  route(data);
}

async function route(d) {
  if (d.status === "published") return message("ok", "公開しました", "サイトへの反映には1〜3分ほどかかります。", d.publishedUrl);
  if (d.status === "discarded") return message("ok", "取りやめました", "この下書きは破棄されました。LINEからいつでも新しく投稿できます。");
  if (d.status === "ready") return generateNow();
  if (d.status === "generating") { loading("記事を作成中です…（30秒〜1分）"); setTimeout(start, 4000); return; }
  render(d);
}

async function generateNow(instruction) {
  loading(instruction ? "修正した記事を作成中です…（30秒〜1分）" : "写真とメモから記事を作成中です…（30秒〜1分）");
  const { status, data } = await call("/generate", { instruction: instruction || "" });
  if (status === 409) { setTimeout(start, 4000); return; }
  if (data.error && !data.result) {
    actions.hidden = true;
    const retry = h("button", { class: "btn btn-gold" }, "もう一度作成する");
    retry.onclick = () => generateNow(instruction);
    app.replaceChildren(h("div", { class: "wrap" }, h("div", { class: "box err" }, h("h2", {}, "記事を作成できませんでした"), h("p", {}, data.error), h("p", { style: "margin-top:16px" }, retry))));
    return;
  }
  render(data);
}

function render(d) {
  const r = d.result;
  const kids = [];
  if (d.error) kids.push(h("div", { class: "wrap" }, h("div", { class: "box err" }, h("h2", {}, "エラー"), h("p", {}, d.error))));
  if (r.problems && r.problems.length) kids.push(h("div", { class: "wrap" }, h("div", { class: "box err" }, h("h2", {}, "このままでは公開できません（修正を依頼してください）"), h("ul", {}, ...r.problems.map((p) => h("li", {}, p))))));
  if (r.notes && r.notes.length) kids.push(h("div", { class: "wrap" }, h("div", { class: "box warn" }, h("h2", {}, "確認してほしい点"), h("ul", {}, ...r.notes.map((n) => h("li", {}, n))))));

  const hero = h("section", { class: "page-hero" },
    h("div", { class: "page-hero-bg", style: "background-image:url('" + r.cover.replace(/'/g, "%27") + "')" }),
    h("div", { class: "wrap" }, h("p", { class: "en" }, r.category), h("h1", {}, r.title)));
  const meta = h("div", { class: "meta" },
    h("p", {}, h("b", {}, "要約（検索結果に表示）："), r.description),
    h("p", {}, h("b", {}, "タグ："), r.tags.map((t) => "#" + t).join(" ")),
    h("p", {}, h("b", {}, "URL："), "/blog/" + r.slug));
  const article = h("section", { class: "section" }, h("article", { class: "wrap article", html: r.html }));
  kids.push(hero, h("div", { class: "wrap", style: "padding-top:20px" }, meta), article);
  app.replaceChildren(...kids);
  actions.hidden = false;
  document.getElementById("btn-publish").disabled = !!(r.problems && r.problems.length);
  window.__draft = d;
}

function loadImage(src) {
  return new Promise((ok, ng) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ng(new Error("写真の読み込みに失敗しました")); im.src = src; });
}
async function shrink(src) {
  const im = await loadImage(src);
  const scale = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(im.naturalWidth * scale); c.height = Math.round(im.naturalHeight * scale);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(im, 0, 0, c.width, c.height);
  for (const q of [0.82, 0.7, 0.55]) {
    const b64 = c.toDataURL("image/jpeg", q).split(",")[1];
    if (b64.length < 2.5 * 1024 * 1024) return b64;
  }
  throw new Error("写真のサイズを小さくできませんでした");
}

document.getElementById("btn-publish").onclick = async () => {
  const d = window.__draft;
  const btns = actions.querySelectorAll("button");
  btns.forEach((b) => (b.disabled = true));
  const publish = document.getElementById("btn-publish");
  publish.textContent = "公開しています…";
  try {
    const images = {};
    for (const u of d.result.used) images[u.n] = await shrink(u.src);
    const { status, data } = await call("/publish", { images });
    if (status !== 200 || data.error) throw new Error(data.error || "公開に失敗しました");
    route(data);
  } catch (e) {
    alertBox(e.message);
  } finally {
    btns.forEach((b) => (b.disabled = false));
    publish.textContent = "公開する";
  }
};

document.getElementById("btn-revise").onclick = () => {
  if (document.getElementById("revise")) { document.getElementById("revise").scrollIntoView({ behavior: "smooth" }); return; }
  const ta = h("textarea", { placeholder: "例）タイトルをもっと短く。2つ目の見出しの内容に、繁忙期の話を足してください。" });
  const go = h("button", { class: "btn btn-gold" }, "この内容で作り直す");
  go.onclick = () => { if (ta.value.trim()) generateNow(ta.value.trim()); else ta.focus(); };
  const box = h("div", { class: "wrap", id: "revise" }, h("div", { class: "box revise" }, h("h2", {}, "修正したい内容を書いてください"), ta, go));
  app.append(box);
  box.scrollIntoView({ behavior: "smooth" });
  ta.focus();
};

let discardArmed = false;
document.getElementById("btn-discard").onclick = async (e) => {
  if (!discardArmed) { discardArmed = true; e.target.textContent = "もう一度押すと破棄"; setTimeout(() => { discardArmed = false; e.target.textContent = "やめる"; }, 4000); return; }
  loading("取りやめています…");
  const { data } = await call("/discard", {});
  route(data);
};

function alertBox(text) {
  const box = h("div", { class: "wrap" }, h("div", { class: "box err" }, h("h2", {}, "公開できませんでした"), h("p", {}, text)));
  app.prepend(box);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

start();
</script>
</body>
</html>`;
}
