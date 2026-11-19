/* VoxStorm Docker UI: one component used in two places —
   the title-bar Docker panel (this computer) and the Docker view of an SSH session (that server).
   DockerUI.mount(el, { target, onTerminal, compact }) -> { refresh, setTarget, destroy, visible }.
   target is 'local' or an SSH session id; every docker call runs in the main process (src/main/docker.js).
   Uses globals from app.js: esc, toast. */
/* global api */
(() => {
  'use strict';
  const errText = e => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const inv = async (...a) => { try { return await api.invoke(...a); } catch (e) { return { error: errText(e) }; } };
  const call = (target, op, a) => inv('docker:call', target, op, a || {});
  const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r(?!\n)/g;
  const MAX_LOG_LINES = 5000;
  const STATE = {
    running: ['ok', 'Çalışıyor'], exited: ['off', 'Durdu'], created: ['off', 'Oluşturuldu'], paused: ['warn', 'Duraklatıldı'],
    restarting: ['warn', 'Yeniden başlıyor'], removing: ['warn', 'Siliniyor'], dead: ['bad', 'Ölü'],
  };
  // "0.0.0.0:8080->80/tcp, :::8080->80/tcp" -> [{ host, port, to }]
  function parsePorts(s) {
    const out = [], seen = new Set();
    for (const p of String(s || '').split(',').map(x => x.trim()).filter(Boolean)) {
      const m = p.match(/^(?:\[?([^\]]*?)\]?:)?(\d+)(?:-\d+)?->(\d+(?:-\d+)?\/\w+)$/);
      if (m) { const key = m[2] + '>' + m[3]; if (seen.has(key)) continue; seen.add(key); out.push({ host: m[1] && m[1] !== '0.0.0.0' && m[1] !== '::' ? m[1] : '', port: +m[2], to: m[3] }); }
      else if (!seen.has(p)) { seen.add(p); out.push({ raw: p }); }
    }
    return out;
  }

  function mount(root, opts) {
    const X = {
      target: opts.target || 'local', tab: 'containers', filter: '', showAll: true,
      items: null, images: null, stats: {}, error: null, loading: false, busy: new Set(),
      open: {}, detail: null, // { kind: 'logs' | 'inspect', c, ... }
      log: null, alive: true,
    };
    root.classList.add('dk');
    root.innerHTML = `
      <div class="dk-h">
        <div class="dk-seg" role="tablist"><button data-dtab="containers" role="tab"><i class="fa-solid fa-cube"></i>Konteynerler</button><button data-dtab="images" role="tab"><i class="fa-solid fa-layer-group"></i>İmajlar</button></div>
        <div class="dk-search"><i class="fa-solid fa-magnifying-glass"></i><input data-dk="filter" placeholder="Ara…" spellcheck="false" autocomplete="off" aria-label="Ara"></div>
        <button class="dk-ib" data-dact="toggleAll" title="Durmuş konteynerleri göster / gizle" aria-label="Durmuşları göster"><i class="fa-solid fa-eye"></i></button>
        <button class="dk-ib" data-dact="stats" title="CPU ve bellek kullanımını getir" aria-label="Kaynak kullanımı"><i class="fa-solid fa-gauge-high"></i></button>
        <button class="dk-ib" data-dact="more" title="Temizlik ve diğer işlemler" aria-label="Diğer"><i class="fa-solid fa-ellipsis"></i></button>
        <button class="dk-ib" data-dact="refresh" title="Yenile" aria-label="Yenile"><i class="fa-solid fa-arrows-rotate"></i></button>
      </div>
      <div class="dk-body" data-dk="body"></div>
      <div class="dk-detail" data-dk="detail" hidden></div>
      <div class="dk-ask" data-dk="ask" hidden></div>`;
    const $q = s => root.querySelector(s);
    const body = $q('[data-dk=body]'), detail = $q('[data-dk=detail]');

    /* ---------- loading ---------- */
    async function refresh(quiet) {
      if (!X.alive) return;
      if (!quiet) { X.loading = true; render(); }
      const [c, i] = await Promise.all([call(X.target, 'containers'), X.tab === 'images' || X.images ? call(X.target, 'images') : Promise.resolve(null)]);
      X.loading = false;
      if (c.error) { X.error = c; X.items = null; }
      else { X.error = null; X.items = c.items; }
      if (i && !i.error) X.images = i.items;
      render();
      if (opts.onCount && X.items) opts.onCount(X.items.filter(x => x.state === 'running').length);
    }
    async function loadStats() {
      const b = $q('[data-dact=stats]'); b.classList.add('spin');
      const r = await call(X.target, 'stats');
      b.classList.remove('spin');
      if (r.error) { toast('Kaynak kullanımı alınamadı', r.error); return; }
      X.stats = r.stats; render();
    }

    /* ---------- render ---------- */
    function render() {
      root.querySelectorAll('[data-dtab]').forEach(b => { b.classList.toggle('on', b.dataset.dtab === X.tab); b.setAttribute('aria-selected', b.dataset.dtab === X.tab); });
      $q('[data-dact=toggleAll]').classList.toggle('on', !X.showAll);
      $q('[data-dact=toggleAll]').innerHTML = `<i class="fa-solid fa-eye${X.showAll ? '' : '-slash'}"></i>`;
      $q('[data-dact=stats]').hidden = X.tab !== 'containers';
      $q('[data-dact=toggleAll]').hidden = X.tab !== 'containers';
      if (X.error) {
        const e = X.error;
        body.innerHTML = `<div class="dk-empty ${e.down || e.missing || e.denied ? '' : 'bad'}"><i class="fa-brands fa-docker"></i><b>${e.missing ? 'Docker bulunamadı' : e.down ? 'Docker çalışmıyor' : e.denied ? 'Erişim izni yok' : 'Docker’a ulaşılamadı'}</b><span>${esc(e.error)}</span>
          <div class="dk-eb">${e.down && X.target === 'local' ? '<button class="btn primary" data-dact="startDesktop"><i class="fa-solid fa-play"></i> Docker Desktop’u başlat</button>' : ''}<button class="btn" data-dact="refresh">Tekrar dene</button></div></div>`;
        return;
      }
      if (X.loading && !X.items) { body.innerHTML = '<div class="dk-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><span>Yükleniyor…</span></div>'; return; }
      if (X.tab === 'images') { renderImages(); return; }
      const q = X.filter.toLowerCase();
      const list = (X.items || []).filter(c => (X.showAll || c.state === 'running' || c.state === 'restarting') && (!q || [c.name, c.image, c.project, c.service, c.ports].some(v => String(v || '').toLowerCase().includes(q))));
      if (!list.length) {
        body.innerHTML = `<div class="dk-empty"><i class="fa-solid fa-cube"></i><span>${(X.items || []).length ? (q ? 'Eşleşen konteyner yok.' : 'Çalışan konteyner yok.') : 'Hiç konteyner yok.'}</span>${!X.showAll && (X.items || []).length ? '<button class="btn" data-dact="toggleAll">Durmuşları da göster</button>' : ''}</div>`;
        return;
      }
      const groups = new Map();
      for (const c of list) { const g = c.project || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
      const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
      let h = '';
      for (const g of keys) {
        const cs = groups.get(g).sort((a, b) => (a.service || a.name).localeCompare(b.service || b.name));
        if (g) {
          const run = cs.filter(c => c.state === 'running').length, shut = X.open[g] === false;
          h += `<div class="dk-grp" data-dgrp="${esc(g)}"><i class="fa-solid fa-chevron-${shut ? 'right' : 'down'} dk-car"></i><i class="fa-solid fa-cubes dk-gi"></i><b>${esc(g)}</b><span class="dk-gn">${run}/${cs.length}</span>
            <span class="dk-acts">${run < cs.length ? `<button class="dk-ib sm" data-gpact="start" title="Projeyi başlat (compose start)"><i class="fa-solid fa-play"></i></button>` : ''}${run ? `<button class="dk-ib sm" data-gpact="stop" title="Projeyi durdur (compose stop)"><i class="fa-solid fa-stop"></i></button>` : ''}<button class="dk-ib sm" data-gpact="restart" title="Projeyi yeniden başlat"><i class="fa-solid fa-rotate-right"></i></button><button class="dk-ib sm" data-gpact="down" title="Projeyi kaldır (compose down)"><i class="fa-solid fa-trash-can"></i></button></span></div>`;
          if (shut) continue;
        }
        for (const c of cs) h += rowHtml(c, !!g);
      }
      body.innerHTML = h;
    }
    function rowHtml(c, inGroup) {
      const [cls, label] = STATE[c.state] || ['off', c.state];
      const busy = X.busy.has(c.id);
      const st = X.stats[c.id];
      const ports = parsePorts(c.ports);
      const running = c.state === 'running';
      return `<div class="dk-row${inGroup ? ' in-grp' : ''}${busy ? ' busy' : ''}" data-cid="${esc(c.id)}">
        <span class="dk-dot ${busy ? 'busy' : cls}" title="${esc(label)}${c.health ? ' · ' + esc(c.health) : ''}"></span>
        <span class="dk-main"><b title="${esc(c.name)}">${esc(inGroup && c.service ? c.service : c.name)}</b>${inGroup && c.service && c.service !== c.name ? `<small class="dk-cn">${esc(c.name)}</small>` : ''}
          <small><span class="dk-img" title="${esc(c.image)}">${esc(c.image)}</span> · ${esc(c.status)}${c.health && !c.status.includes(c.health) ? ` · <span class="dk-h-${esc(c.health.replace(/\W+/g, ''))}">${esc(c.health)}</span>` : ''}</small>
          ${ports.length || st ? `<span class="dk-meta">${ports.map(p => p.raw ? `<span class="dk-port raw">${esc(p.raw)}</span>` : `<button class="dk-port" data-port="${p.port}" data-host="${esc(p.host)}" title="${X.target === 'local' ? 'Tarayıcıda aç: ' : ''}${esc((p.host || 'localhost') + ':' + p.port)} → ${esc(p.to)}">${p.port}<i class="fa-solid fa-arrow-right"></i>${esc(p.to)}</button>`).join('')}${st ? `<span class="dk-st" title="CPU · bellek ${esc(st.mem)}">${esc(st.cpu)} · ${esc(st.memp)}</span>` : ''}</span>` : ''}
        </span>
        <span class="dk-acts">
          ${running ? `<button class="dk-ib sm" data-cact="stop" title="Durdur"><i class="fa-solid fa-stop"></i></button>` : c.state === 'paused' ? `<button class="dk-ib sm" data-cact="unpause" title="Sürdür"><i class="fa-solid fa-play"></i></button>` : `<button class="dk-ib sm" data-cact="start" title="Başlat"><i class="fa-solid fa-play"></i></button>`}
          <button class="dk-ib sm" data-cact="restart" title="Yeniden başlat"><i class="fa-solid fa-rotate-right"></i></button>
          <button class="dk-ib sm" data-cact="terminal" title="Konteynerde terminal aç (docker exec)"${running ? '' : ' disabled'}><i class="fa-solid fa-terminal"></i></button>
          <button class="dk-ib sm" data-cact="logs" title="Loglar"><i class="fa-solid fa-file-lines"></i></button>
          <button class="dk-ib sm" data-cact="menu" title="Diğer işlemler"><i class="fa-solid fa-ellipsis-vertical"></i></button>
        </span>
      </div>`;
    }
    function renderImages() {
      const q = X.filter.toLowerCase();
      if (!X.images) { body.innerHTML = '<div class="dk-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><span>Yükleniyor…</span></div>'; return; }
      const list = X.images.filter(i => !q || [i.repo, i.tag, i.id].some(v => String(v || '').toLowerCase().includes(q)));
      body.innerHTML = `<form class="dk-pull" data-dk="pull"><input name="img" placeholder="İmaj çek: nginx:latest" spellcheck="false" autocomplete="off" aria-label="Çekilecek imaj"><button class="btn" type="submit"><i class="fa-solid fa-download"></i> Çek</button></form>` +
        (list.length ? list.map(i => {
          const ref = i.repo && i.repo !== '<none>' ? `${i.repo}:${i.tag}` : i.id;
          return `<div class="dk-row img" data-iid="${esc(i.id)}" data-ref="${esc(ref)}">
            <i class="fa-solid fa-layer-group dk-ii"></i>
            <span class="dk-main"><b title="${esc(ref)}">${esc(i.repo === '<none>' ? '<adsız>' : i.repo)}<span class="dk-tag">${esc(i.tag)}</span></b><small>${esc(i.id)} · ${esc(i.size)} · ${esc(i.created)}${i.containers && i.containers !== 'N/A' && i.containers !== '0' ? ` · ${esc(i.containers)} konteyner` : ''}</small></span>
            <span class="dk-acts"><button class="dk-ib sm" data-iact="copy" title="Adı kopyala"><i class="fa-regular fa-copy"></i></button><button class="dk-ib sm" data-iact="rmi" title="İmajı sil"><i class="fa-solid fa-trash-can"></i></button></span></div>`;
        }).join('') : `<div class="dk-empty"><i class="fa-solid fa-layer-group"></i><span>${q ? 'Eşleşen imaj yok.' : 'Hiç imaj yok.'}</span></div>`);
    }

    /* ---------- confirm (inside the component, so it works in the popover and in SSH) ---------- */
    function ask(title, text, okLabel, danger) {
      const el = $q('[data-dk=ask]');
      return new Promise(res => {
        el.innerHTML = `<div class="dk-askbox" role="alertdialog" aria-label="${esc(title)}"><b>${esc(title)}</b><p>${esc(text)}</p><div><button class="btn" data-ans="0">Vazgeç</button><button class="btn ${danger ? 'dk-danger' : 'primary'}" data-ans="1">${esc(okLabel)}</button></div></div>`;
        el.hidden = false;
        el.querySelector('[data-ans="0"]').focus();
        const done = v => { el.hidden = true; el.innerHTML = ''; el.onclick = null; el.onkeydown = null; res(v); };
        el.onclick = e => { const b = e.target.closest('[data-ans]'); if (b) done(b.dataset.ans === '1'); else if (e.target === el) done(false); };
        el.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
      });
    }

    /* ---------- actions ---------- */
    const byId = id => (X.items || []).find(c => c.id === id);
    async function containerAction(c, action) {
      if (action === 'rm' || action === 'rmForce') {
        if (!(await ask('Konteyneri sil', `“${c.name}” silinecek${c.state === 'running' ? ' (çalışıyor, önce durdurulur)' : ''}. Volume’ler silinmez.`, 'Sil', true))) return;
        action = c.state === 'running' ? 'rmForce' : 'rm';
      }
      if (action === 'kill' && !(await ask('Zorla durdur', `“${c.name}” anında öldürülecek (SIGKILL).`, 'Öldür', true))) return;
      X.busy.add(c.id); render();
      const r = await call(X.target, 'container', { action, id: c.id });
      X.busy.delete(c.id);
      if (r.error) toast('İşlem başarısız: ' + c.name, r.error);
      await refresh(true);
    }
    async function composeAction(project, action) {
      if (action === 'down' && !(await ask('Projeyi kaldır', `“${project}” projesinin konteynerleri ve ağları silinecek (docker compose down). Volume’ler kalır.`, 'Kaldır', true))) return;
      const ids = (X.items || []).filter(c => c.project === project).map(c => c.id);
      ids.forEach(id => X.busy.add(id)); render();
      const r = await call(X.target, 'compose', { action, project });
      ids.forEach(id => X.busy.delete(id));
      if (r.error) toast('Compose işlemi başarısız: ' + project, r.error);
      await refresh(true);
    }
    async function menu(c, x, y) {
      const running = c.state === 'running';
      const v = await ctx(x, y, [
        ['logs', 'Loglar', 'fa-file-lines'], ['inspect', 'Ayrıntılar (inspect)', 'fa-circle-info'],
        ['terminal', 'Terminal (docker exec)', 'fa-terminal', !running], '-',
        running ? ['pause', 'Duraklat', 'fa-pause'] : c.state === 'paused' ? ['unpause', 'Sürdür', 'fa-play'] : ['start', 'Başlat', 'fa-play'],
        ['restart', 'Yeniden başlat', 'fa-rotate-right'], ['kill', 'Zorla durdur (kill)', 'fa-skull', !running], '-',
        ['copyName', 'Adı kopyala', 'fa-copy'], ['copyId', 'ID’yi kopyala', 'fa-hashtag'], '-',
        ['rm', 'Sil', 'fa-trash-can'],
      ]);
      if (!v) return;
      if (v === 'logs') openLogs(c);
      else if (v === 'inspect') openInspect(c);
      else if (v === 'terminal') terminal(c);
      else if (v === 'copyName' || v === 'copyId') { const s = v === 'copyName' ? c.name : c.id; navigator.clipboard.writeText(s).catch(() => {}); toast('Kopyalandı', s); }
      else containerAction(c, v);
    }
    function terminal(c) {
      if (opts.onTerminal) opts.onTerminal({ target: X.target, id: c.id, name: c.name });
    }
    async function moreMenu(x, y) {
      const v = await ctx(x, y, [
        ['pruneContainers', 'Durmuş konteynerleri temizle', 'fa-broom'],
        ['pruneImages', 'Kullanılmayan (dangling) imajları temizle', 'fa-broom'],
        ['pruneAll', 'Sistem temizliği (system prune)', 'fa-dumpster'],
        ...(X.target === 'local' ? ['-', ['startDesktop', 'Docker Desktop’u aç', 'fa-brands fa-docker']] : []),
        '-', ['version', 'Docker sürümü', 'fa-circle-info'],
      ]);
      if (!v) return;
      if (v === 'startDesktop') { const r = await call(X.target, 'startDesktop'); if (r.error) toast('Açılamadı', r.error); return; }
      if (v === 'version') { const r = await call(X.target, 'version'); toast('Docker', r.error ? r.error : `İstemci ${r.client || '?'} · Sunucu ${r.server || '?'}${r.os ? ' (' + r.os + ')' : ''}`); return; }
      const what = { pruneContainers: 'containers', pruneImages: 'images', pruneAll: 'all' }[v];
      const txt = { containers: 'Durmuş tüm konteynerler silinecek.', images: 'Etiketsiz (dangling) imajlar silinecek.', all: 'Durmuş konteynerler, kullanılmayan ağlar, dangling imajlar ve yapı önbelleği silinecek.' }[what];
      if (!(await ask('Temizlik', txt, 'Temizle', true))) return;
      const r = await call(X.target, 'prune', { what });
      if (r.error) toast('Temizlenemedi', r.error); else toast('Temizlendi', r.out || '');
      X.images = null; refresh(true);
    }

    /* ---------- logs ---------- */
    async function openLogs(c) {
      closeDetail();
      X.detail = { kind: 'logs', c, wrap: true, follow: true, filter: '', lines: [], partial: '' };
      detail.hidden = false; root.classList.add('has-detail');
      detail.innerHTML = `<div class="dk-dh"><button class="dk-ib" data-dact="back" title="Geri (Esc)" aria-label="Geri"><i class="fa-solid fa-arrow-left"></i></button><b>${esc(c.name)}</b><span class="dk-muted">loglar</span><span class="dk-grow"></span>
        <div class="dk-search sm"><i class="fa-solid fa-filter"></i><input data-dk="logfilter" placeholder="Süz…" spellcheck="false" aria-label="Logları süz"></div>
        <button class="dk-ib on" data-dact="follow" title="Sona kilitle"><i class="fa-solid fa-angles-down"></i></button>
        <button class="dk-ib on" data-dact="wrap" title="Satır sarma"><i class="fa-solid fa-paragraph"></i></button>
        <button class="dk-ib" data-dact="copyLogs" title="Görünen logları kopyala"><i class="fa-regular fa-copy"></i></button>
        <button class="dk-ib" data-dact="clearLogs" title="Ekranı temizle"><i class="fa-solid fa-eraser"></i></button></div>
        <pre class="dk-log wrap" data-dk="log"></pre><div class="dk-lf" data-dk="logstate">Bağlanıyor…</div>`;
      const r = await inv('docker:logs', X.target, c.id, 1000);
      if (!X.detail || X.detail.c !== c) { if (r.id) inv('docker:logsStop', r.id); return; }
      if (r.error) { $q('[data-dk=logstate]').textContent = r.error; return; }
      X.detail.stream = r.id;
      $q('[data-dk=logstate]').textContent = 'Canlı izleniyor';
    }
    function onLog(id, text) {
      const d = X.detail; if (!d || d.stream !== id) return;
      const parts = (d.partial + text.replace(ANSI, '')).split('\n');
      d.partial = parts.pop();
      d.lines.push(...parts);
      if (d.lines.length > MAX_LOG_LINES) d.lines.splice(0, d.lines.length - MAX_LOG_LINES);
      paintLog(parts);
    }
    function paintLog(newLines) {
      const d = X.detail, pre = $q('[data-dk=log]'); if (!pre) return;
      const f = d.filter.toLowerCase();
      if (newLines && !f) {
        pre.insertAdjacentText('beforeend', newLines.map(l => l + '\n').join(''));
        if (pre.textContent.length > 2e6) pre.textContent = d.lines.join('\n') + '\n';
      } else {
        const ls = f ? d.lines.filter(l => l.toLowerCase().includes(f)) : d.lines;
        pre.textContent = ls.join('\n') + (ls.length ? '\n' : '');
      }
      if (d.follow) pre.scrollTop = pre.scrollHeight;
    }
    function onLogEnd(id, err) {
      const d = X.detail; if (!d || d.stream !== id) return;
      d.stream = null;
      const s = $q('[data-dk=logstate]'); if (s) s.textContent = err ? 'Durdu: ' + err : 'Akış bitti (konteyner durmuş olabilir).';
    }
    async function openInspect(c) {
      closeDetail();
      X.detail = { kind: 'inspect', c };
      detail.hidden = false; root.classList.add('has-detail');
      detail.innerHTML = `<div class="dk-dh"><button class="dk-ib" data-dact="back" title="Geri (Esc)" aria-label="Geri"><i class="fa-solid fa-arrow-left"></i></button><b>${esc(c.name)}</b><span class="dk-muted">ayrıntılar</span></div><div class="dk-insp"><div class="dk-empty"><i class="fa-solid fa-circle-notch fa-spin"></i></div></div>`;
      const r = await call(X.target, 'inspect', { id: c.id });
      if (!X.detail || X.detail.c !== c) return;
      const el = detail.querySelector('.dk-insp');
      if (r.error) { el.innerHTML = `<div class="dk-empty bad"><span>${esc(r.error)}</span></div>`; return; }
      const kv = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
      el.innerHTML = `<dl class="dk-kv">${kv('İmaj', esc(c.image))}${kv('Durum', esc(c.status))}${kv('Komut', `<code>${esc(c.command)}</code>`)}${kv('Yeniden başlatma', esc(r.restart || 'no'))}${c.workdir ? kv('Compose klasörü', `<code>${esc(c.workdir)}</code>`) : ''}${kv('Ağlar', r.networks.map(n => `${esc(n.name)}${n.ip ? ' <code>' + esc(n.ip) + '</code>' : ''}`).join('<br>') || '—')}${kv('Portlar', esc(c.ports || '—'))}</dl>
        ${r.mounts.length ? `<h4>Bağlamalar</h4><div class="dk-tbl">${r.mounts.map(m => `<div><span class="dk-tagx">${esc(m.type)}</span><code>${esc(m.src)}</code> → <code>${esc(m.dst)}</code>${m.rw ? '' : ' <span class="dk-tagx">salt okunur</span>'}</div>`).join('')}</div>` : ''}
        <h4>Ortam değişkenleri <small>(${r.env.length})</small></h4><div class="dk-env">${r.env.map(e => { const i = e.indexOf('='); const k = e.slice(0, i), v = e.slice(i + 1); const secret = /pass|secret|token|key|pwd/i.test(k); return `<div><b>${esc(k)}</b>=<span class="${secret ? 'dk-secret' : ''}" ${secret ? 'title="Görmek için tıkla"' : ''}>${esc(v)}</span></div>`; }).join('')}</div>
        <details><summary>Ham JSON</summary><pre class="dk-json">${esc(r.json)}</pre></details>`;
    }
    function closeDetail() {
      if (X.detail && X.detail.stream) inv('docker:logsStop', X.detail.stream);
      X.detail = null; detail.hidden = true; detail.innerHTML = ''; root.classList.remove('has-detail');
    }

    /* ---------- context menu (shared .db-ctx look) ---------- */
    let ctxEl = null;
    function ctx(x, y, items) {
      if (!ctxEl) { ctxEl = document.createElement('div'); ctxEl.className = 'db-ctx dk-ctx'; ctxEl.setAttribute('role', 'menu'); document.getElementById('win').appendChild(ctxEl); }
      ctxEl.innerHTML = items.map(it => it === '-' ? '<div class="db-sep"></div>' : `<button data-ctx="${it[0]}"${it[3] ? ' disabled' : ''}><i class="${/fa-brands/.test(it[2]) ? it[2] : 'fa-solid ' + it[2]}"></i><span>${esc(it[1])}</span></button>`).join('');
      ctxEl.hidden = false;
      ctxEl.style.left = Math.min(x, innerWidth - ctxEl.offsetWidth - 6) + 'px';
      ctxEl.style.top = Math.min(y, innerHeight - ctxEl.offsetHeight - 6) + 'px';
      return new Promise(res => {
        const close = v => { ctxEl.hidden = true; document.removeEventListener('mousedown', out, true); document.removeEventListener('keydown', key, true); res(v); };
        const out = e => { if (!ctxEl.contains(e.target)) close(null); };
        const key = e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
        ctxEl.onclick = e => { const b = e.target.closest('[data-ctx]'); if (b && !b.disabled) close(b.dataset.ctx); };
        setTimeout(() => { document.addEventListener('mousedown', out, true); document.addEventListener('keydown', key, true); }, 0);
      });
    }

    /* ---------- events ---------- */
    root.addEventListener('click', async e => {
      const tb = e.target.closest('[data-dtab]');
      if (tb) { X.tab = tb.dataset.dtab; render(); if (X.tab === 'images' && !X.images) { const r = await call(X.target, 'images'); X.images = r.items || []; if (r.error) toast('İmajlar alınamadı', r.error); render(); } return; }
      const a = e.target.closest('[data-dact]');
      if (a) {
        const k = a.dataset.dact, d = X.detail;
        if (k === 'refresh') { X.images = X.tab === 'images' ? null : X.images; refresh(); }
        else if (k === 'toggleAll') { X.showAll = !X.showAll; render(); }
        else if (k === 'stats') loadStats();
        else if (k === 'more') { const r = a.getBoundingClientRect(); moreMenu(r.left, r.bottom + 2); }
        else if (k === 'startDesktop') { const r = await call(X.target, 'startDesktop'); if (r.error) toast('Açılamadı', r.error); else { toast('Docker Desktop açılıyor', 'Hazır olunca liste kendiliğinden yenilenir.'); waitUp(); } }
        else if (k === 'back') closeDetail();
        else if (k === 'follow' && d) { d.follow = !d.follow; a.classList.toggle('on', d.follow); if (d.follow) paintLog(); }
        else if (k === 'wrap' && d) { d.wrap = !d.wrap; a.classList.toggle('on', d.wrap); $q('[data-dk=log]').classList.toggle('wrap', d.wrap); }
        else if (k === 'clearLogs' && d) { d.lines = []; paintLog(); }
        else if (k === 'copyLogs' && d) { navigator.clipboard.writeText($q('[data-dk=log]').textContent).catch(() => {}); toast('Loglar kopyalandı'); }
        return;
      }
      const port = e.target.closest('[data-port]');
      if (port) {
        if (X.target === 'local') { const r = await call('local', 'openUrl', { port: port.dataset.port, host: port.dataset.host || 'localhost' }); if (r.error) toast('Açılamadı', r.error); }
        else { navigator.clipboard.writeText(port.dataset.port).catch(() => {}); toast('Sunucudaki port: ' + port.dataset.port, 'Bu bilgisayardan açmak için Tüneller’den bir yönlendirme ekle.'); }
        return;
      }
      const ca = e.target.closest('[data-cact]');
      if (ca) {
        const c = byId(ca.closest('[data-cid]').dataset.cid); if (!c) return;
        const k = ca.dataset.cact;
        if (k === 'logs') openLogs(c);
        else if (k === 'terminal') terminal(c);
        else if (k === 'menu') { const r = ca.getBoundingClientRect(); menu(c, r.left - 160, r.bottom + 2); }
        else containerAction(c, k);
        return;
      }
      const pa = e.target.closest('[data-gpact]');
      if (pa) { composeAction(pa.closest('[data-dgrp]').dataset.dgrp, pa.dataset.gpact); return; }
      const g = e.target.closest('[data-dgrp]');
      if (g) { const k = g.dataset.dgrp; X.open[k] = X.open[k] === false; render(); return; }
      const ia = e.target.closest('[data-iact]');
      if (ia) {
        const row = ia.closest('[data-iid]'), ref = row.dataset.ref;
        if (ia.dataset.iact === 'copy') { navigator.clipboard.writeText(ref).catch(() => {}); toast('Kopyalandı', ref); return; }
        if (!(await ask('İmajı sil', `“${ref}” silinecek.`, 'Sil', true))) return;
        const r = await call(X.target, 'rmi', { id: ref.includes('<none>') ? row.dataset.iid : ref });
        if (r.error) toast('Silinemedi', r.error);
        X.images = null; const i = await call(X.target, 'images'); X.images = i.items || []; render();
        return;
      }
      const sec = e.target.closest('.dk-secret'); if (sec) sec.classList.add('show');
    });
    root.addEventListener('dblclick', e => {
      const row = e.target.closest('[data-cid]');
      if (row && !e.target.closest('button')) { const c = byId(row.dataset.cid); if (c) openLogs(c); }
    });
    root.addEventListener('contextmenu', e => {
      const row = e.target.closest('[data-cid]'); if (!row) return;
      e.preventDefault(); e.stopPropagation();
      const c = byId(row.dataset.cid); if (c) menu(c, e.clientX, e.clientY);
    });
    root.addEventListener('input', e => {
      if (e.target.dataset.dk === 'filter') { X.filter = e.target.value; render(); }
      if (e.target.dataset.dk === 'logfilter' && X.detail) { X.detail.filter = e.target.value; paintLog(); }
    });
    root.addEventListener('submit', async e => {
      if (e.target.dataset.dk !== 'pull') return;
      e.preventDefault();
      const inp = e.target.querySelector('input'), img = inp.value.trim(); if (!img) return;
      const b = e.target.querySelector('button'); b.disabled = true; b.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Çekiliyor…';
      const r = await call(X.target, 'pull', { image: img });
      if (r.error) toast('Çekilemedi: ' + img, r.error); else { toast('İmaj çekildi', img); inp.value = ''; }
      const i = await call(X.target, 'images'); X.images = i.items || []; render();
    });
    root.addEventListener('keydown', e => {
      if (e.key === 'Escape' && X.detail && $q('[data-dk=ask]').hidden) { e.stopPropagation(); closeDetail(); }
    });
    root.addEventListener('scroll', e => {
      if (e.target.dataset && e.target.dataset.dk === 'log' && X.detail) {
        const p = e.target, atEnd = p.scrollHeight - p.scrollTop - p.clientHeight < 24;
        if (X.detail.follow !== atEnd) { X.detail.follow = atEnd; const b = $q('[data-dact=follow]'); if (b) b.classList.toggle('on', atEnd); }
      }
    }, true);
    const offLog = api.on('docker:log', onLog);
    const offEnd = api.on('docker:logEnd', onLogEnd);
    let upTimer = null;
    function waitUp() { // after starting Docker Desktop: poll until the daemon answers
      clearInterval(upTimer); let n = 0;
      upTimer = setInterval(async () => {
        if (++n > 40 || !X.alive) { clearInterval(upTimer); return; }
        const r = await call(X.target, 'count');
        if (!r.error) { clearInterval(upTimer); refresh(); }
      }, 3000);
    }

    render();
    refresh();
    return {
      refresh: () => refresh(true),
      setTarget(t) { if (t === X.target) return; closeDetail(); X.target = t; X.items = null; X.images = null; X.stats = {}; refresh(); },
      get detailOpen() { return !!X.detail; },
      closeDetail,
      destroy() { X.alive = false; closeDetail(); offLog(); offEnd(); clearInterval(upTimer); if (ctxEl) ctxEl.remove(); root.innerHTML = ''; },
    };
  }

  window.DockerUI = { mount, parsePorts };

  /* ---------------- title-bar button + panel (this computer) ---------------- */
  const btn = document.getElementById('dockerBtn'), panel = document.getElementById('dockerPanel');
  if (!btn || !panel) return;
  let ui = null;
  const setCount = n => { const b = document.getElementById('dockerBtnN'); b.hidden = !n; b.textContent = n; };
  async function poll() {
    if (document.hidden) return;
    const r = await call('local', 'count');
    if (r.missing) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.classList.toggle('down', !!r.error);
    btn.title = r.error ? 'Docker: ' + r.error : `Docker: ${r.running} konteyner çalışıyor`;
    setCount(r.error ? 0 : r.running);
  }
  function open() {
    panel.hidden = false; btn.setAttribute('aria-expanded', 'true');
    // under the button, kept inside the window
    const w = document.getElementById('win').getBoundingClientRect(), r = btn.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(r.left - w.left, w.width - panel.offsetWidth - 8)) + 'px';
    if (!ui) ui = mount(panel.querySelector('.dkp-body'), { target: 'local', onCount: setCount, onTerminal: c => { close(); if (window.sshMode && window.sshMode.openDockerTerm) window.sshMode.openDockerTerm(c); } });
    else ui.refresh();
    setTimeout(() => { const i = panel.querySelector('[data-dk=filter]'); if (i) i.focus(); }, 0);
  }
  function close() { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (ui) ui.closeDetail(); }
  btn.addEventListener('click', () => (panel.hidden ? open() : close()));
  document.addEventListener('mousedown', e => {
    if (panel.hidden || e.target.closest('#dockerPanel,#dockerBtn,.dk-ctx,.toast')) return;
    close();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden && !(ui && ui.detailOpen) && !e.defaultPrevented) close(); });
  try { SHORTCUTS.push({ group: 'Genel', keys: 'Ctrl+Shift+Y', label: 'Docker paneli (bu bilgisayardaki konteynerler)', run: () => { if (!btn.hidden) (panel.hidden ? open() : close()); } }); } catch (_) {}
  poll();
  setInterval(poll, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
})();
