// The campaign table's rules: which styles and models a row offers, what a change does to the rest of the row, and why
// a row isn't in the schedule yet. Pure functions, no DOM; the Campaigns tab delegates to this. Every function that
// changes a row returns a new one. Mirrors rowIssues in src/campaigns/rows.ts (same texts, same order).
(function (root) {
  var CLAUDE_GROUP = "claude";

  function isLemo(style) { return style !== null && style !== undefined && style.indexOf("lemo:") === 0; }
  function isClaudeModel(model) { return model !== null && model !== undefined && model.indexOf("claude:") === 0; }

  function showModelColumn(rows) {
    return rows.some(function (r) { return r.origin === "create" || r.origin === "agent"; });
  }

  function lemoGroups(ctx, enabled) {
    if (!ctx.lemo.length) {
      return [{ label: "Lemo-Opuscar films", options: [{ value: "", label: ctx.lemoInstalled ? "No Lemo styles found" : "Lemo-Opuscar isn't installed on this computer", disabled: true }] }];
    }
    var cats = {};
    var loose = []; // a style without a category: its own group, after the categorised ones
    ctx.lemo.forEach(function (l) {
      if (l.category === null || l.category === undefined || l.category === "") loose.push(l);
      else (cats[l.category] = cats[l.category] || []).push(l);
    });
    var prefix = enabled ? "Lemo-Opuscar films (Claude)" : "Lemo-Opuscar films: need a Claude model on Claude Code";
    var group = function (label, list) {
      var items = list.slice().sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
      return {
        label: label,
        options: items.map(function (l) {
          var o = { value: l.key, label: l.name, title: l.description };
          if (!enabled) o.disabled = true;
          return o;
        }),
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
    else if (row.origin === "agent") groups = lemoGroups(ctx, true);
    else {
      // Use AI settings (null) can become Claude by picking a Lemo style, so only an explicit non-Claude model disables them.
      groups = [freePoster].concat(lemoGroups(ctx, row.model === null || isClaudeModel(row.model)));
    }
    var s = row.style;
    if (s !== null && s !== undefined) {
      var listed = groups.some(function (g) { return g.options.some(function (o) { return o.value === s; }); });
      if (!listed) {
        var option;
        var known = isLemo(s) ? ctx.lemo.filter(function (l) { return l.key === s; })[0] : ctx.styles.filter(function (x) { return x.id === s; })[0];
        // A style the table can't offer on this row (a Lemo style on Drive, say) keeps its name and is shown, never dropped.
        if (known) option = { value: s, label: known.name, disabled: true, selected: true };
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

  /** The row after the user changed one field. `flash: "model"` asks the table to highlight the model it just switched. */
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

  root.FreePosterRows = {
    isLemo: isLemo, isClaudeModel: isClaudeModel, showModelColumn: showModelColumn,
    styleGroups: styleGroups, modelOptions: modelOptions, applyChange: applyChange, rowIssues: rowIssues, sameRows: sameRows,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
