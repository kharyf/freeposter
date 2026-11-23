// The campaign table's rules: which styles and models a row offers, what a change does to the rest of the row, and why
// a row isn't in the schedule yet. Pure functions, no DOM; the Campaigns tab delegates to this. Every function that
// changes a row returns a new one. Mirrors rowIssues in src/campaigns/rows.ts (same texts, same order).
(function (root) {
  var CLAUDE_GROUP = "claude";

  function isLemo(style) { return style !== null && style !== undefined && style.indexOf("lemo:") === 0; }
  function isClaudeModel(model) { return model !== null && model !== undefined && model.indexOf("claude:") === 0; }

  /** Whether Claude is connected under AI Providers: the server lists only connected providers' models. */
  function claudeConnected(ctx) {
    return ctx.models.some(function (p) { return p.provider === CLAUDE_GROUP; });
  }

  /** The Origin choices: Agent (a film Claude makes) only while Claude is connected, or when the row already is one. */
  function originOptions(row, ctx) {
    var out = [{ value: "create", label: "Create" }, { value: "drive", label: "Drive" }];
    if (row.origin === "agent" || claudeConnected(ctx)) out.push({ value: "agent", label: "Agent" });
    return out;
  }

  function showModelColumn(rows) {
    return rows.some(function (r) { return r.origin === "create" || r.origin === "agent"; });
  }

  /** The Lemo styles, grouped by category. None at all when the library has none (the row's issues say why). */
  function lemoGroups(ctx) {
    if (!ctx.lemo.length) return [];
    var cats = {};
    var loose = []; // a style without a category: its own group, after the categorised ones
    ctx.lemo.forEach(function (l) {
      if (l.category === null || l.category === undefined || l.category === "") loose.push(l);
      else (cats[l.category] = cats[l.category] || []).push(l);
    });
    var prefix = "Lemo-Opuscar films (Claude)";
    var group = function (label, list) {
      var items = list.slice().sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
      return {
        label: label,
        options: items.map(function (l) { return { value: l.key, label: l.name, title: l.description }; }),
      };
    };
    var groups = Object.keys(cats).sort().map(function (cat) { return group(prefix + ": " + cat, cats[cat]); });
    if (loose.length) groups.push(group(prefix, loose));
    return groups;
  }

  function styleGroups(row, ctx) {
    var groups = [];
    var freePoster = { label: "FreePoster edits", options: ctx.styles.map(function (s) { return { value: s.id, label: s.name }; }) };
    if (row.origin === "drive") groups.push(freePoster);
    else if (row.origin === "agent") groups = lemoGroups(ctx);
    // A Create row offers the Lemo styles only once its model is a Claude model: never shown greyed out, just not there.
    else groups = [freePoster].concat(isClaudeModel(row.model) ? lemoGroups(ctx) : []);
    var s = row.style;
    if (s !== null && s !== undefined) {
      var listed = groups.some(function (g) { return g.options.some(function (o) { return o.value === s; }); });
      if (!listed) {
        var option;
        var known = isLemo(s) ? ctx.lemo.filter(function (l) { return l.key === s; })[0] : ctx.styles.filter(function (x) { return x.id === s; })[0];
        // A style the table can't offer on this row (a saved one from before) keeps its name and is shown, never dropped.
        if (known) option = { value: s, label: known.name, selected: true };
        else option = { value: s, label: s + (isLemo(s) ? " (no longer in Lemo-Opuscar)" : " (gone)"), selected: true };
        if (!groups.length) groups.push({ label: "", options: [] });
        groups[groups.length - 1].options.push(option);
      }
    }
    return groups;
  }

  function modelOptions(row, ctx) {
    if (row.origin === "drive") return [];
    var agent = row.origin === "agent";
    var groups = [{ label: "", options: [{ value: "", label: agent ? "Default (Claude Code's setting)" : "Use AI settings" }] }];
    ctx.models.forEach(function (p) {
      if (agent && p.provider !== CLAUDE_GROUP) return;
      groups.push({ label: p.label, options: p.models.map(function (m) { return { value: m.id, label: m.name }; }) });
    });
    var m = row.model;
    if (m !== null && m !== undefined && !groups.some(function (g) { return g.options.some(function (o) { return o.value === m; }); })) {
      groups[groups.length - 1].options.push({ value: m, label: m + " (not available)", selected: true });
    }
    return groups;
  }

  /** The row after the user changed one field. `flash` ("model" or "style") asks the table to highlight the cell it just switched. */
  function applyChange(row, field, value, ctx) {
    var next = structuredClone(row);
    var flash;
    if (field === "model") next.model = value === "" ? null : value;
    else next[field] = value;
    if (field === "style" && row.origin === "create" && isLemo(value) && next.model === null) {
      next.model = ctx.defaultClaude;
      flash = "model";
    }
    if (field === "origin" && value === "agent" && next.model !== null && !isClaudeModel(next.model)) {
      next.model = ctx.defaultClaude;
      flash = "model";
    }
    // A Create row's null model means the AI settings, which can't write a Lemo film: it gets the default Claude model.
    if (field === "origin" && value === "create" && isLemo(next.style) && next.model === null) {
      next.model = ctx.defaultClaude;
      flash = "model";
    }
    // A Create row offers a Lemo style only with a Claude model: switching the model off Claude takes the default edit.
    if (field === "model" && next.origin === "create" && !isClaudeModel(next.model) && isLemo(next.style) && ctx.defaultStyle) {
      next.style = ctx.defaultStyle;
      flash = "style";
    }
    return flash ? { row: next, flash: flash } : { row: next };
  }

  function rowIssues(r, ctx) {
    var out = [];
    if (!r.days.length) out.push("no days ticked");
    if (r.origin === "drive") {
      if (!r.text.trim()) out.push("no file name");
      if (r.time === null) out.push("a Drive video needs a time");
    } else if (r.sec === null) out.push("no length");
    var lemo = isLemo(r.style);
    if (r.origin === "agent") {
      if (r.style === null) out.push("no editing style");
      else if (!lemo) out.push("an Agent row needs a Lemo style");
      if (r.model !== null && !isClaudeModel(r.model)) out.push("an Agent row needs a Claude model");
    }
    if (r.origin === "create" && lemo && !isClaudeModel(r.model)) out.push("Lemo styles need a Claude model");
    if (r.origin === "drive" && lemo) out.push("Drive videos can't use a Lemo style");
    if (lemo) {
      // The catalogue alone decides, as on the server; whether the library is installed only picks the wording (the
      // dropdown's). The server, which can't tell, always says "isn't installed".
      if (!ctx.lemo.length) out.push(ctx.lemoInstalled ? "No Lemo styles found" : "Lemo-Opuscar isn't installed on this computer");
      else if (!ctx.lemo.some(function (l) { return l.key === r.style; })) out.push(r.style + " is no longer in Lemo-Opuscar");
    }
    if (r.origin !== "drive" && r.model !== null && ctx.models) {
      var known = ctx.models.some(function (p) { return p.models.some(function (m) { return m.id === r.model; }); });
      if (!known) out.push(r.model + " isn't available; pick another model");
    }
    return out;
  }

  /** A value as JSON with every object's keys sorted, so two equal values read the same whatever their key order. */
  function canonical(v) {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (v !== null && typeof v === "object") {
      return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + canonical(v[k]); }).join(",") + "}";
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  /** Whether two tables hold the same rows in the same order (the window's unsaved changes are none when they do). */
  function sameRows(a, b) { return canonical(a) === canonical(b); }

  /** A row's id as shown: 7 hex digits, or "new" for a row that isn't saved yet (id <= 0). Same as rowIdHex on the server. */
  function hexId(id) { return id > 0 ? id.toString(16).padStart(7, "0") : "new"; }

  /** What stops the table being saved: a row needs a time and a day. The server's texts and order (row by row, time first). */
  function saveProblems(rows) {
    var out = [];
    rows.forEach(function (r, i) {
      var name = "row " + (r.id > 0 ? hexId(r.id) : i + 1);
      if (r.time === null || r.time === undefined) out.push(name + ": needs a post time");
      if (!r.days.length) out.push(name + ": needs at least one day");
    });
    return out;
  }

  /** A row for the + button: a Create row with no time or day yet, and a stand-in id below every id in the table and below `lowest`, the lowest stand-in the campaign ever handed out, so a deleted row's id is never reused while a save is in flight (the server gives the real one on save). */
  function newRow(rows, last, defaultStyle, lowest) {
    return {
      id: Math.min.apply(null, [0, lowest || 0].concat(rows.map(function (r) { return r.id; }))) - 1,
      quantity: 1, hook: { pick: "random" }, angle: { pick: "random" }, cta: { pick: "random" },
      style: last && last.style != null ? last.style : defaultStyle, type: null, time: null, days: [], sec: 30, origin: "create",
      model: last && last.model !== undefined ? last.model : null, text: "",
    };
  }

  /**
   * Before a save: a positive id the campaign no longer has (Autorun deleted that row meanwhile) becomes a fresh stand-in, so the
   * row is made again instead of refused. Returns the rows and the lowest stand-in handed out so far.
   */
  function reviveGone(rows, saved, lowest) {
    var have = {};
    saved.forEach(function (r) { have[r.id] = true; });
    var low = lowest || 0;
    rows.forEach(function (r) { if (r.id < low) low = r.id; });
    var out = rows.map(function (r) {
      if (r.id > 0 && !have[r.id]) { low -= 1; var n = structuredClone(r); n.id = low; return n; }
      return r;
    });
    return { rows: out, lowest: low };
  }

  root.FreePosterRows = {
    reviveGone: reviveGone,
    newRow: newRow,    hexId: hexId, saveProblems: saveProblems,
    isLemo: isLemo, isClaudeModel: isClaudeModel, claudeConnected: claudeConnected, originOptions: originOptions, showModelColumn: showModelColumn,
    styleGroups: styleGroups, modelOptions: modelOptions, applyChange: applyChange, rowIssues: rowIssues, sameRows: sameRows,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
