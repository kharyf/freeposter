// Console view helpers: pure functions, no DOM. mergeLines never mutates its input state.
(function () {
  var CAP = 5000;

  // state: { lines, seq, dropped }; resp: the /api/console body. Returns { state, added, reset }.
  function mergeLines(state, resp) {
    var reset = resp.latest < state.seq; // the server restarted and numbers from 1 again
    var lines = reset ? [] : state.lines.slice();
    var seq = reset ? 0 : state.seq;
    var dropped = reset ? false : !!state.dropped;
    var added = [];
    for (var i = 0; i < resp.lines.length; i++) {
      if (resp.lines[i].seq > seq) added.push(resp.lines[i]);
    }
    lines = lines.concat(added);
    if (lines.length > CAP) { lines = lines.slice(lines.length - CAP); dropped = true; }
    if (resp.dropped) dropped = true;
    return { state: { lines: lines, seq: resp.latest, dropped: dropped }, added: added, reset: reset };
  }

  // Splits text into hit / non-hit pieces for a literal, case-insensitive query; null when nothing matches.
  function matchSegments(text, query) {
    if (!query) return [{ text: text, hit: false }];
    var hay = text.toLowerCase();
    var needle = query.toLowerCase();
    var out = [];
    var pos = 0;
    var at;
    while ((at = hay.indexOf(needle, pos)) !== -1) {
      if (at > pos) out.push({ text: text.slice(pos, at), hit: false });
      out.push({ text: text.slice(at, at + needle.length), hit: true });
      pos = at + needle.length;
    }
    if (!out.length) return null;
    if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
    return out;
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function clock(at) {
    var d = new Date(at);
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  globalThis.FreePosterConsole = { CAP: CAP, mergeLines: mergeLines, matchSegments: matchSegments, clock: clock };
})();
