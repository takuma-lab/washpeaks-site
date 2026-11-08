// GitHub へ記事と画像を1コミットで追加する（Git Data API）。
// コミットされると Cloudflare Pages が自動でビルド・公開する。

async function gh(env, path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "washpeaks-line-bot",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json: j };
}

async function must(p, what) {
  const r = await p;
  if (!r.ok) throw new Error(`GitHub ${what} に失敗しました (${r.status}: ${r.json.message || "不明"})`);
  return r.json;
}

/** content/blog 内の既存ファイル名一覧 */
export async function listBlogFiles(env) {
  const r = await gh(env, `/contents/content/blog?ref=${encodeURIComponent(env.GITHUB_BRANCH || "main")}`);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`GitHub 記事一覧の取得に失敗しました (${r.status}: ${r.json.message || "不明"})`);
  return r.json.map((f) => f.name);
}

/** @param files {path:string, b64:string}[] */
export async function commitFiles(env, files, message) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) throw new Error("GITHUB_TOKEN / GITHUB_REPO が設定されていません");
  const branch = env.GITHUB_BRANCH || "main";
  const ref = await must(gh(env, `/git/ref/heads/${branch}`), "ブランチ取得");
  const head = await must(gh(env, `/git/commits/${ref.object.sha}`), "コミット取得");
  const tree = [];
  for (const f of files) {
    const blob = await must(gh(env, "/git/blobs", { method: "POST", body: JSON.stringify({ content: f.b64, encoding: "base64" }) }), "ファイル送信");
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await must(gh(env, "/git/trees", { method: "POST", body: JSON.stringify({ base_tree: head.tree.sha, tree }) }), "ツリー作成");
  const commit = await must(gh(env, "/git/commits", {
    method: "POST", body: JSON.stringify({ message, tree: newTree.sha, parents: [ref.object.sha] }),
  }), "コミット作成");
  await must(gh(env, `/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) }), "ブランチ更新");
  return commit.sha;
}
