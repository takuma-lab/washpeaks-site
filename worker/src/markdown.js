// 記事本文の Markdown → HTML 変換と記事データの検証。
// build.py と同じ規則（HTMLタグは書けない・危険なリンクは無効化）。

export function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function unesc(s) {
  return s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function safeUrl(u) {
  u = u.trim();
  if (/^(https?:\/\/|images\/|#|mailto:)/.test(u) || /^[\w./-]+\.html(#[\w-]+)?$/.test(u)) return u;
  return null;
}

function inline(text) {
  let out = esc(text);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const u = safeUrl(unesc(href));
    if (!u) return label;
    const ext = u.startsWith("http") ? ' target="_blank" rel="noopener"' : "";
    return `<a href="${esc(u)}"${ext}>${label}</a>`;
  });
  return out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/**
 * @param {string} md 本文
 * @param {(src:string)=>string|null} imageSrc 画像参照（例 "image:2"）を表示用URLに変換。null なら画像を出さない
 */
export function markdown(md, imageSrc = (s) => s) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let para = [], lst = null, quote = [];

  const flush = () => {
    if (para.length) { out.push("<p>" + para.map(inline).join("") + "</p>"); para = []; }
    if (lst) { out.push(`<${lst.tag}>` + lst.items.map((i) => `<li>${inline(i)}</li>`).join("") + `</${lst.tag}>`); lst = null; }
    if (quote.length) { out.push("<blockquote><p>" + quote.map(inline).join("<br>") + "</p></blockquote>"); quote = []; }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flush(); continue; }
    let m = line.match(/^(#{1,3})\s+(.+)$/);
    if (m) {
      flush();
      const lv = m[1].length <= 2 ? 2 : 3;
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
      continue;
    }
    m = line.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (m) {
      flush();
      const src = imageSrc(m[2]);
      if (src) {
        const cap = m[1] ? `<figcaption>${esc(m[1])}</figcaption>` : "";
        out.push(`<figure><img src="${esc(src)}" alt="${esc(m[1])}" loading="lazy">${cap}</figure>`);
      }
      continue;
    }
    m = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.+)$/);
    if (m) {
      const tag = m[1] ? "ol" : "ul";
      if (para.length || quote.length || (lst && lst.tag !== tag)) flush();
      if (!lst) lst = { tag, items: [] };
      lst.items.push(m[2]);
      continue;
    }
    m = line.match(/^>\s?(.*)$/);
    if (m) {
      if (para.length || lst) flush();
      quote.push(m[1]);
      continue;
    }
    if (lst || quote.length) flush();
    para.push(line.trim());
  }
  flush();
  return out.join("\n");
}

/** 本文中の画像参照 image:N の番号一覧 */
export function usedImageNumbers(body) {
  const nums = new Set();
  for (const m of body.matchAll(/!\[[^\]]*\]\(image:(\d+)\)/g)) nums.add(Number(m[1]));
  return [...nums];
}

export function sanitizeSlug(s) {
  const slug = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "post";
}

/** build.py と同じ基準で記事データを検証。エラー文の配列を返す */
export function validatePost(p, categories, imageCount) {
  const errors = [];
  for (const k of ["title", "category", "description", "body"]) {
    if (!p[k] || !String(p[k]).trim()) errors.push(`「${k}」が空です`);
  }
  if (p.category && !categories.includes(p.category)) errors.push(`カテゴリ「${p.category}」は未登録です（${categories.join("/")}）`);
  if ((p.description || "").length > 160) errors.push(`要約文が160文字を超えています（${p.description.length}文字）`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug || "")) errors.push(`URL用の名前「${p.slug}」が不正です`);
  if (!(p.cover_image >= 1 && p.cover_image <= imageCount)) errors.push("アイキャッチ画像の指定が不正です");
  for (const n of usedImageNumbers(p.body || "")) {
    if (n < 1 || n > imageCount) errors.push(`本文が存在しない画像 ${n} を参照しています`);
  }
  if (/<\s*[a-z!/]/i.test(p.body || "")) errors.push("本文にHTMLタグが含まれています");
  return errors;
}
