/* Plain file and folder paths in terminal output become links (Claude: "APK burada: C:\…\apk\debug").
   Ctrl+click (Cmd on macOS): a folder opens in the file manager, a file of a project opens in the IDE
   (at its line for "src/x.js:49"), any other file is shown selected in its folder.
   Only paths that really exist are linked: candidates are checked with the main process (path:probe),
   which also settles paths with spaces and paths that the program broke over two lines — Claude's
   text wraps long paths with a newline and an indent, so a word that runs to the right edge is also
   tried joined with the start of the next line. Relative paths are taken from the terminal's folder. */
(() => {
  'use strict';
  const WIN = window.IS_WIN;
  const LEAD = /^[(\[{<'"“‘«`]+/;
  const TRAIL = /[.,;:!?)\]}>'"”’»`]+$/;
  const LINE = /:(\d+)(?::(\d+))?$/; // file.js:49 / file.js:49:5
  const ABS = WIN ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|~[\\/])/ : /^(?:\/|~\/)/;
  const DRIVE_IN = /[A-Za-z]:[\\/]/; // "konum:C:\…" -> start at the drive
  const BAD = WIN ? /[<>|*?"]/ : /[\0]/;
  const ROWS = 3; // rows looked at around the hovered one
  const TTL = 8000;
  const cache = new Map(); // absolute path -> { at, v: null | { dir } }

  async function probe(paths) {
    const now = Date.now(), ask = [];
    for (const p of paths) { const c = cache.get(p); if (!c || now - c.at > TTL) ask.push(p); }
    const uniq = [...new Set(ask)].slice(0, 60);
    if (uniq.length) {
      let r = [];
      try { r = await api.invoke('path:probe', uniq); } catch (_) {}
      uniq.forEach((p, i) => cache.set(p, { at: now, v: r[i] || null }));
      if (cache.size > 2000) for (const k of [...cache.keys()].slice(0, 1000)) cache.delete(k);
    }
    return p => (cache.get(p) || {}).v || null;
  }

  function readRow(buf, y, cell) { // y: 0-based buffer row
    const line = buf.getLine(y);
    let text = '';
    const pos = [];
    if (!line) return { text, pos, wrapped: false };
    for (let x = 0; x < line.length; x++) {
      const c = line.getCell(x, cell);
      if (!c) break;
      const w = c.getWidth();
      if (w === 0) continue;
      const ch = c.getChars() || ' ';
      for (let k = 0; k < ch.length; k++) { text += ch[k]; pos.push({ x: x + 1, y: y + 1, w }); }
    }
    return { text, pos, wrapped: line.isWrapped };
  }

  // rows joined where the terminal wrapped them itself (soft wraps)
  function groupsAround(term, y0) {
    const buf = term.buffer.active, cell = buf.getNullCell();
    let a = Math.max(0, y0 - ROWS);
    for (let n = 0; n < 10 && a > 0 && buf.getLine(a) && buf.getLine(a).isWrapped; n++) a--;
    const b = Math.min(buf.length - 1, y0 + ROWS);
    const groups = [];
    for (let y = a; y <= b; y++) {
      const r = readRow(buf, y, cell);
      const g = r.wrapped && groups.length ? groups[groups.length - 1] : null;
      if (g) { g.text += r.text; g.pos.push(...r.pos); g.lastRow = r; }
      else groups.push({ text: r.text, pos: r.pos.slice(), lastRow: r });
    }
    for (const g of groups) {
      const t = g.lastRow.text.replace(/\s+$/, '');
      g.full = t.length >= term.cols - 20; // runs (almost) to the right edge: may go on in the next row
      const end = g.text.replace(/\s+$/, '').length;
      g.text = g.text.slice(0, end); g.pos.length = end;
    }
    return groups;
  }

  // a group and the rows that may continue it (hard wraps with an indent)
  function segments(groups) {
    const out = groups.map(g => ({ text: g.text, pos: g.pos, join: -1 }));
    for (let i = 0; i < groups.length - 1; i++) {
      if (!groups[i].full) continue;
      let text = groups[i].text, pos = groups[i].pos.slice();
      for (let j = i + 1; j < groups.length && j <= i + 3; j++) {
        const nx = groups[j], lead = nx.text.length - nx.text.replace(/^\s+/, '').length;
        if (lead === nx.text.length) break;
        const at = text.length;
        text += nx.text.slice(lead); pos = pos.concat(nx.pos.slice(lead));
        out.push({ text, pos, join: at });
        if (!nx.full) break;
      }
    }
    return out;
  }

  function candidates(seg, cwd) {
    const out = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(seg.text))) {
      let w = m[0], i = m.index;
      // a joined segment only adds the words that cross the join
      if (seg.join >= 0 && !(i < seg.join && i + w.length > seg.join)) continue;
      const lead = (LEAD.exec(w) || [''])[0];
      w = w.slice(lead.length); i += lead.length;
      if (WIN && !ABS.test(w)) { const d = DRIVE_IN.exec(w); if (d && d.index > 0) { i += d.index; w = w.slice(d.index); } }
      if (!w || /:\/\//.test(w) || !/[\\/]/.test(w)) continue;
      const abs = ABS.test(w);
      if (!abs && (!/[A-Za-z0-9]/.test(w) || /^[\\/]/.test(w))) continue;
      // with spaces: an absolute path may go on over the next words ("C:\Program Files\Android")
      const ends = [i + w.length];
      if (abs) {
        const re2 = /\S+/g; re2.lastIndex = i + w.length;
        for (let k = 0, n; k < 3 && (n = re2.exec(seg.text)); k++) ends.push(n.index + n[0].length);
      }
      for (const e of ends) {
        let raw = seg.text.slice(i, e);
        if (BAD.test(raw)) continue;
        raw = raw.replace(TRAIL, '');
        let line = 0, col = 0;
        const lm = LINE.exec(raw);
        const forms = [[raw, 0, 0]];
        if (lm) forms.push([raw.slice(0, lm.index), +lm[1], +(lm[2] || 0)]);
        for (const [r, ln, cl] of forms) {
          if (!r || r.length < 2) continue;
          let p = r;
          if (WIN) p = p.replace(/\//g, '\\');
          if (!abs) {
            if (!cwd) continue;
            p = cwd.replace(/[\\/]+$/, '') + SEP + p.replace(/^\.[\\/]/, '');
          }
          line = ln; col = cl;
          const last = seg.pos[i + raw.length - 1]; // the link ends with the line suffix too
          out.push({ path: p, line, col, start: seg.pos[i], end: last });
        }
      }
    }
    return out;
  }

  function tipText(dir, inProject) {
    const keys = keysLabel(__('Ctrl+tık'));
    return dir ? __('{keys}: klasörü aç', { keys }) : inProject ? __('{keys}: IDE’de aç', { keys }) : __('{keys}: klasöründe göster', { keys });
  }

  window.attachPathLinks = (term, getCwd) => {
    term.registerLinkProvider({
      async provideLinks(y, done) {
        try {
          const cwd = (getCwd && getCwd()) || '';
          const cands = [];
          for (const s of segments(groupsAround(term, y - 1))) cands.push(...candidates(s, cwd));
          if (!cands.length) return done(undefined);
          const has = await probe(cands.map(c => c.path));
          // for each start the longest path that exists; then drop links inside another one
          const best = new Map();
          for (const c of cands) {
            const v = has(c.path);
            if (!v) continue;
            const key = c.start.x + ',' + c.start.y;
            const o = best.get(key);
            const len = c2 => (c2.end.y - c2.start.y) * 10000 + c2.end.x;
            if (!o || len(c) > len(o)) best.set(key, Object.assign(c, { dir: v.dir }));
          }
          const all = [...best.values()];
          const before = (a, b) => a.y < b.y || (a.y === b.y && a.x <= b.x);
          const inside = (c, o) => c !== o && before(o.start, c.start) && before(c.end, o.end);
          const links = all.filter(c => !all.some(o => inside(c, o)))
            .filter(c => c.start.y <= y && c.end.y >= y)
            .map(c => {
              const inProject = !c.dir && typeof termFileProject === 'function' && !!termFileProject(c.path);
              return {
                range: { start: { x: c.start.x, y: c.start.y }, end: { x: c.end.x + (c.end.w > 1 ? 1 : 0), y: c.end.y } },
                text: c.path,
                decorations: { pointerCursor: true, underline: true },
                activate: async e => {
                  if (!modKey(e)) return;
                  uiHideTip();
                  if (!c.dir && inProject && openTermFile(c.path, c.line, c.col)) return;
                  const r = await api.invoke('path:open', c.path).catch(err => ({ error: err.message }));
                  if (r && r.error) uiAlert({ title: __('Açılamadı'), message: c.path, detail: r.error });
                },
                hover: e => uiTipAt(new DOMRect(e.clientX - 1, e.clientY - 9, 2, 18), c.path + '\n' + tipText(c.dir, inProject)),
                leave: () => uiHideTip(),
              };
            });
          done(links.length ? links : undefined);
        } catch (_) { done(undefined); }
      },
    });
  };
})();
