#!/usr/bin/env python3
"""Wash Peaks サイトのビルド。

src/pages/*.html と content/blog/*.md から dist/ に公開用ファイルを生成する。
外部ライブラリ不要（Python 3.8+ 標準ライブラリのみ）。

  python3 build.py            ビルド
  python3 build.py --check    記事の検証のみ（dist は作らない）

記事に不備があればエラー一覧を出して終了コード 1 で止まる。
Cloudflare Pages ではビルド失敗 = 公開されない、なので壊れた記事は公開されない。
"""
import datetime
import html
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
CONTENT = ROOT / "content" / "blog"
TEMPLATES = ROOT / "templates"
DIST = ROOT / "dist"

SITE = json.loads((ROOT / "site.json").read_text(encoding="utf-8"))
CATEGORIES = SITE["blog"]["categories"]

LOGO = ('<svg viewBox="0 0 46 26" aria-hidden="true"><path d="M1 24 L14 8 L21 16 L29 4 L45 24" '
        'fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>'
        '<path d="M10 13 L14 8 L17 12" fill="none" stroke="#fff" stroke-width="1.6"/></svg>')

REQUIRED = ["title", "date", "category", "description", "cover"]
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MAX_IMAGE_BYTES = 2 * 1024 * 1024


def esc(s):
    return html.escape(str(s), quote=True)


def fill(tpl, values):
    return re.sub(r"\{\{(\w+)\}\}", lambda m: str(values.get(m.group(1), m.group(0))), tpl)


# ---------------------------------------------------------------- partials
def partial(name, root, section=""):
    tpl = (SRC / "partials" / f"{name}.html").read_text(encoding="utf-8")
    current = ' aria-current="page"'
    nav = "".join(
        f'<a href="{root}{n["href"]}"{current if n["href"] == section else ""}>{esc(n["label"])}</a>'
        for n in SITE["nav"]
    )
    return fill(tpl, {"root": root, "logo": LOGO, "nav": nav})


def common(root, section):
    return {
        "root": root,
        "header": partial("header", root, section),
        "cta": partial("cta", root),
        "footer": partial("footer", root),
        "blog_title": esc(SITE["blog"]["title"]),
    }


# ---------------------------------------------------------------- markdown
def safe_url(u):
    u = u.strip()
    if re.match(r"^(https?://|images/|#|mailto:)", u) or re.match(r"^[\w./-]+\.html(#[\w-]+)?$", u):
        return u
    return None


def inline(text):
    out = esc(text)
    def link(m):
        u = safe_url(html.unescape(m.group(2)))
        if not u:
            return m.group(1)
        ext = ' target="_blank" rel="noopener"' if u.startswith("http") else ""
        return f'<a href="{esc(u)}"{ext}>{m.group(1)}</a>'
    out = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", link, out)
    out = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", out)
    return out


def markdown(md, images_used):
    """記事本文用の最小 Markdown。HTML タグは書けない（すべてエスケープ）。"""
    lines = md.replace("\r\n", "\n").split("\n")
    out, para, lst, quote = [], [], None, []

    def flush():
        nonlocal para, lst, quote
        if para:
            out.append("<p>" + "".join(inline(p) for p in para) + "</p>")
            para = []
        if lst:
            tag, items = lst
            out.append(f"<{tag}>" + "".join(f"<li>{inline(i)}</li>" for i in items) + f"</{tag}>")
            lst = None
        if quote:
            out.append("<blockquote><p>" + "<br>".join(inline(q) for q in quote) + "</p></blockquote>")
            quote = []

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            flush(); continue
        m = re.match(r"^(#{1,3})\s+(.+)$", line)
        if m:
            flush()
            level = 2 if len(m.group(1)) <= 2 else 3
            out.append(f"<h{level}>{inline(m.group(2))}</h{level}>"); continue
        m = re.match(r"^!\[([^\]]*)\]\(([^)\s]+)\)$", line.strip())
        if m:
            flush()
            alt, src = m.group(1), m.group(2)
            images_used.append(src)
            cap = f"<figcaption>{esc(alt)}</figcaption>" if alt else ""
            out.append(f'<figure><img src="{esc(src)}" alt="{esc(alt)}" loading="lazy">{cap}</figure>'); continue
        m = re.match(r"^\s*(?:[-*]|(\d+)\.)\s+(.+)$", line)
        if m:
            tag = "ol" if m.group(1) else "ul"
            if para or quote or (lst and lst[0] != tag):
                flush()
            if not lst:
                lst = (tag, [])
            lst[1].append(m.group(2)); continue
        m = re.match(r"^>\s?(.*)$", line)
        if m:
            if para or lst:
                flush()
            quote.append(m.group(1)); continue
        if lst or quote:
            flush()
        para.append(line.strip())
    flush()
    return "\n".join(out)


# ---------------------------------------------------------------- posts
def parse_post(path, errors):
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text.replace("\r\n", "\n"), re.S)
    if not m:
        errors.append(f"{path.name}: 先頭に --- で囲んだ記事情報（フロントマター）がありません")
        return None
    meta = {}
    for line in m.group(1).split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            errors.append(f"{path.name}: 記事情報の行の形式が不正です → {line!r}"); continue
        k, v = line.split(":", 1)
        meta[k.strip()] = v.strip().strip('"').strip("'")
    body_md = m.group(2)

    for k in REQUIRED:
        if not meta.get(k):
            errors.append(f"{path.name}: 必須項目「{k}」がありません")
    if str(meta.get("draft", "")).lower() in ("true", "yes", "1"):
        return None

    fname = re.match(r"^(\d{4}-\d{2}-\d{2})-(.+)\.md$", path.name)
    slug = meta.get("slug") or (fname.group(2) if fname else path.stem)
    if not SLUG_RE.match(slug):
        errors.append(f"{path.name}: slug「{slug}」は半角英小文字・数字・ハイフンのみ使えます")
    try:
        date = datetime.date.fromisoformat(meta.get("date", ""))
    except ValueError:
        errors.append(f"{path.name}: date は YYYY-MM-DD 形式で書いてください（現在: {meta.get('date')!r}）")
        date = datetime.date.today()
    if meta.get("category") and meta["category"] not in CATEGORIES:
        errors.append(f"{path.name}: category「{meta['category']}」は未登録です。使えるのは {'/'.join(CATEGORIES)}")
    if len(meta.get("description", "")) > 160:
        errors.append(f"{path.name}: description は160文字以内にしてください（現在 {len(meta['description'])} 文字）")

    images = []
    body = markdown(body_md, images)
    if meta.get("cover"):
        images.append(meta["cover"])
    for img in images:
        p = CONTENT / img
        if not img.startswith("images/"):
            errors.append(f"{path.name}: 画像は images/ フォルダ内のものを指定してください → {img}")
        elif not p.is_file():
            errors.append(f"{path.name}: 画像ファイルがありません → content/blog/{img}")
        elif p.suffix.lower() not in IMG_EXT:
            errors.append(f"{path.name}: 対応していない画像形式です → {img}（jpg/png/webp/gif）")
        elif p.stat().st_size > MAX_IMAGE_BYTES:
            errors.append(f"{path.name}: 画像が大きすぎます（2MB以下）→ {img}")

    tags = [t.strip() for t in re.split(r"[,、]", meta.get("tags", "").strip("[]")) if t.strip()]
    return {
        "file": path.name, "slug": slug, "date": date,
        "title": meta.get("title", ""), "category": meta.get("category", ""),
        "description": meta.get("description", ""), "cover": meta.get("cover", ""),
        "tags": tags, "body": body,
    }


def load_posts():
    errors, posts = [], []
    for p in sorted(CONTENT.glob("*.md")):
        post = parse_post(p, errors)
        if post:
            posts.append(post)
    seen = {}
    for p in posts:
        if p["slug"] in seen:
            errors.append(f"{p['file']}: slug「{p['slug']}」が {seen[p['slug']]} と重複しています")
        seen[p["slug"]] = p["file"]
    posts.sort(key=lambda p: (p["date"], p["slug"]), reverse=True)
    return posts, errors


def date_ja(d):
    return f"{d.year}年{d.month}月{d.day}日"


def card(p, prefix):
    return (f'<a class="case" href="{prefix}{p["slug"]}.html" data-cat="{esc(p["category"])}">'
            f'<div class="thumb"><img src="{prefix}{esc(p["cover"])}" alt="" loading="lazy">'
            f'<span class="tag">{esc(p["category"])}</span></div>'
            f'<div class="body"><time datetime="{p["date"]}">{date_ja(p["date"])}</time>'
            f'<h3>{esc(p["title"])}</h3><p>{esc(p["description"])}</p></div></a>')


# ---------------------------------------------------------------- build
def build(posts):
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(SRC / "assets", DIST)

    base = SITE["url"].rstrip("/")
    latest = "".join(card(p, "blog/") for p in posts[: SITE["blog"]["home_latest"]]) \
        or '<p class="empty-note" style="grid-column:1/-1">記事はまだありません</p>'

    pages = []
    for page in sorted((SRC / "pages").glob("*.html")):
        tpl = page.read_text(encoding="utf-8")
        sec = re.search(r'data-section="([^"]+)"', tpl)
        values = common("", sec.group(1) if sec else page.name)
        values["latest_posts"] = latest
        (DIST / page.name).write_text(fill(tpl, values), encoding="utf-8")
        pages.append(page.name)

    blog = DIST / "blog"
    blog.mkdir()
    if (CONTENT / "images").is_dir():
        shutil.copytree(CONTENT / "images", blog / "images")

    filters = '<button class="on" data-filter="all">すべて</button>' + "".join(
        f'<button data-filter="{esc(c)}">{esc(c)}</button>' for c in CATEGORIES)
    values = common("../", "blog/index.html")
    values.update(filters=filters, cards="".join(card(p, "") for p in posts),
                  empty="" if posts else '<p class="empty-note">記事はまだありません</p>')
    (blog / "index.html").write_text(fill((TEMPLATES / "blog-list.html").read_text(encoding="utf-8"), values), encoding="utf-8")

    post_tpl = (TEMPLATES / "blog-post.html").read_text(encoding="utf-8")
    for p in posts:
        recent = "".join(card(q, "") for q in [q for q in posts if q is not p][:3])
        values = common("../", "blog/index.html")
        values.update(
            title=esc(p["title"]), description=esc(p["description"]), category=esc(p["category"]),
            date=p["date"].isoformat(), date_ja=date_ja(p["date"]), cover=esc(p["cover"]),
            og_image=esc(f"{base}/blog/{p['cover']}"), canonical=esc(f"{base}/blog/{p['slug']}"),
            body=p["body"], tags="".join(f"<span>#{esc(t)}</span>" for t in p["tags"]),
            recent=recent or '<p class="empty-note" style="grid-column:1/-1">ほかの記事はまだありません</p>',
        )
        (blog / f"{p['slug']}.html").write_text(fill(post_tpl, values), encoding="utf-8")

    urls = [f"{base}/" if n == "index.html" else f"{base}/{n[:-5]}" for n in pages]
    urls += [f"{base}/blog/"] + [f"{base}/blog/{p['slug']}" for p in posts]
    (DIST / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"  <url><loc>{esc(u)}</loc></url>\n" for u in urls) + "</urlset>\n", encoding="utf-8")
    (DIST / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {base}/sitemap.xml\n", encoding="utf-8")

    leftover = [str(f.relative_to(DIST)) for f in DIST.rglob("*.html") if "{{" in f.read_text(encoding="utf-8")]
    if leftover:
        print("警告: 置換されていない {{...}} が残っています: " + ", ".join(leftover))
    print(f"OK: ページ {len(pages)} / 記事 {len(posts)} → {DIST}")


def main():
    posts, errors = load_posts()
    if errors:
        print("記事にエラーがあります。公開を中止しました:\n" + "\n".join(f"  - {e}" for e in errors))
        sys.exit(1)
    if "--check" in sys.argv:
        print(f"OK: 記事 {len(posts)} 件に問題ありません")
        return
    build(posts)


if __name__ == "__main__":
    main()
