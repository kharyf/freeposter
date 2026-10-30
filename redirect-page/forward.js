// Platforms send the browser here after sign-in (they need an https address); this forwards the
// sign-in result, unchanged, to the FreePoster app running on this same computer.
//
// FreePoster starts every sign-in with state = "<port>.<random>", so the port says where the app listens.
// The only place this page ever sends anyone is http://localhost:<port>/callback. The sign-in code it
// passes along is useless without the app's secret and PKCE verifier, which never leave that computer.
(function () {
  var params = new URLSearchParams(location.search || location.hash.slice(1));
  var match = /^(\d{1,5})\./.exec(params.get("state") || "");
  var port = match ? Number(match[1]) : 0;

  if (port >= 1 && port <= 65535) {
    location.replace("http://localhost:" + port + "/callback?" + params.toString());
    return;
  }

  document.getElementById("title").textContent = "Nothing to do here";
  document.getElementById("text").textContent = params.toString()
    ? "This link didn't come from a FreePoster sign-in. Start again from the Connect button in FreePoster."
    : "This page is used by the FreePoster app to finish signing in to TikTok, Instagram, Facebook, X and YouTube. You don't need to open it yourself.";
})();
