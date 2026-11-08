/* 全ページ共通の動き：メニュー、スライダー、絞り込み、フォーム
   ヘッダー・フッターは build.py がビルド時に埋め込む */
(function () {
  // モバイルメニュー
  var h = document.getElementById("site-header");
  var t = h && h.querySelector(".menu-toggle");
  if (t) t.addEventListener("click", function () { h.classList.toggle("open"); });

  // 導入事例スライダー
  document.querySelectorAll(".cases-slider").forEach(function (s) {
    var track = s.querySelector(".cases");
    var dots = s.querySelectorAll(".dots span");
    function step() { var c = track.querySelector(".case"); return c ? c.offsetWidth + 20 : 300; }
    s.querySelector(".prev").addEventListener("click", function () { track.scrollBy({ left: -step(), behavior: "smooth" }); });
    s.querySelector(".next").addEventListener("click", function () { track.scrollBy({ left: step(), behavior: "smooth" }); });
    track.addEventListener("scroll", function () {
      var max = track.scrollWidth - track.clientWidth;
      var i = max > 0 ? Math.round((track.scrollLeft / max) * (dots.length - 1)) : 0;
      dots.forEach(function (d, k) { d.classList.toggle("on", k === i); });
    });
  });

  // カテゴリ絞り込み（導入事例・ブログ）
  document.querySelectorAll(".filter").forEach(function (f) {
    var items = document.querySelectorAll(f.getAttribute("data-target") + " > *");
    f.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      f.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
      var k = b.getAttribute("data-filter");
      items.forEach(function (it) { it.hidden = k !== "all" && it.getAttribute("data-cat") !== k; });
    });
  });

  // フォーム（送信先未設定のため、入力チェック後に完了画面を表示）
  document.querySelectorAll("form[data-demo]").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var ok = true;
      form.querySelectorAll(".error").forEach(function (x) { x.remove(); });
      form.querySelectorAll("[required]").forEach(function (inp) {
        if (!inp.value.trim() || (inp.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inp.value))) {
          ok = false;
          var m = document.createElement("p");
          m.className = "error";
          m.textContent = inp.type === "email" && inp.value ? "メールアドレスの形式をご確認ください" : "入力してください";
          inp.parentNode.appendChild(m);
        }
      });
      var need = form.querySelector("[data-need-check]");
      if (need && !need.querySelector("input:checked")) {
        ok = false;
        var m2 = document.createElement("p");
        m2.className = "error";
        m2.textContent = "1つ以上選択してください";
        need.appendChild(m2);
      }
      if (!ok) { var first = form.querySelector(".error"); first && first.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
      var done = document.getElementById(form.getAttribute("data-done"));
      form.hidden = true;
      if (done) { done.hidden = false; done.scrollIntoView({ block: "center", behavior: "smooth" }); }
    });
  });
})();
