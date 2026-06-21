// Keep canonical / social URLs correct on whatever origin this is served from.
// Kept as an external file (not inline) so a strict `script-src 'self'` CSP can
// be enforced without 'unsafe-inline'.
(function () {
  try {
    var origin = location.origin;
    if (!/^https?:/.test(origin)) return;
    var base = origin + "/";
    document.querySelectorAll('link[rel="canonical"]').forEach(function (el) {
      el.setAttribute("href", base);
    });
    document.querySelectorAll('meta[property="og:url"]').forEach(function (el) {
      el.setAttribute("content", base);
    });
    ["og:image", "twitter:image"].forEach(function (key) {
      var sel =
        key.indexOf("og:") === 0 ? 'meta[property="' + key + '"]' : 'meta[name="' + key + '"]';
      document.querySelectorAll(sel).forEach(function (el) {
        el.setAttribute("content", base + "og.svg");
      });
    });
  } catch (e) {}
})();
