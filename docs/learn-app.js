/* learn-app.js — the logic shared by the iPad page (ipad.html) and the phone page (iphone.html).
 * The two pages only differ in layout (CSS + HTML frame). The phone sets <html data-layout="phone">:
 * the phrase detail card opens inside the list instead of sitting under the video.
 * Needs config.js and learn-core.js loaded first (language, sync, catalog, helpers).
 */
(function () {
  const LC = window.LearnCore, SYNC = LC.Sync, LI = LC.langInfo;
  const PHONE = document.documentElement.dataset.layout === 'phone';
  if (LC.routeDevice(PHONE ? 'iphone' : 'ipad')) return;      // wrong page for this screen: move to the right one

  const { esc, fmt, markQuote, getData } = LC;
  const $ = s => document.querySelector(s);
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  let toastT;
  function toast(m, ms = 2400) { const el = $('#toast'); el.textContent = m; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), ms); }

  const S = { catalog: null, index: {}, rows: [], history: [], histOpen: false, view: 'videos', v: null, phr: null, cap: null, sel: 0, now: -1, capIdx: -1, pickHold: 0, scrollHold: 0, sheet: null };
  const allVideos = () => (S.catalog && S.catalog.videos) || [];
  const thumb = id => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
  const HOME_TITLE = `${LI.native} · videos`;

  /* ===== Language button: tap to switch between the languages in config.js ===== */
  const langBtn = $('#langBtn');
  if (langBtn) {
    langBtn.textContent = PHONE ? LI.native : `🌏 ${LI.native}`;
    if (LC.LANG_KEYS.length < 2) langBtn.classList.add('hide');
    langBtn.onclick = () => {
      const next = LC.nextLang(), info = LC.LANGS[next];
      openSheet({
        title: `Switch to ${info.name}?`, sub: `You are learning ${LI.name} (${LI.native}) on this device right now. Each language has its own videos, saved words and games.`,
        actions: [{ label: `${info.hello || ''} Learn ${info.name} (${info.native})`, cls: 'primary', fn: () => LC.setLang(next) }, { label: `Stay with ${LI.name}`, fn: () => {} }],
      });
    };
  }

  /* ===== Light / dark ===== */
  const THEMES = ['auto', 'day', 'night'], THEME_BTN = { auto: '◐', day: '☀', night: '☾' }, THEME_NAME = { auto: 'Auto', day: 'Light', night: 'Dark' };
  function paintTheme() { document.querySelectorAll('[data-tool="theme"],#themeBtn').forEach(b => { b.textContent = THEME_BTN[themePref()] + (PHONE ? '' : ' ' + THEME_NAME[themePref()]); }); }
  function cycleTheme() {
    if (location.search.includes('theme=')) history.replaceState(null, '', location.pathname + location.search.replace(/[?&]theme=\w+/, '').replace(/^&/, '?'));
    const n = THEMES[(THEMES.indexOf(themePref()) + 1) % 3]; setThemePref(n); paintTheme(); toast(THEME_BTN[n] + ' ' + THEME_NAME[n]);
  }
  $('#themeBtn').onclick = cycleTheme;
  paintTheme();

  /* ===== Saved words (synced to every device; they also fly on the TV meteor dashboard) ===== */
  function paintSavedCount() { const n = SYNC.words().length; document.querySelectorAll('.savedCount').forEach(e => e.textContent = n ? String(n) : ''); }
  function toggleSave(p) {
    if (SYNC.isSaved(p.phrase)) { SYNC.removeWord(p.phrase); toast(`Removed “${p.phrase}”`); return; }
    SYNC.saveWord({ w: p.phrase, pron: p.pron || '', pos: 'from a video', en: p.meaning || '', ex: p.example || p.quote || '', ex_en: p.example ? (p.example_en || '') : '',
      col: p.quote ? [p.quote.length > 60 ? p.quote.slice(0, 57) + '…' : p.quote] : [], src: { id: S.v && S.v.id, t: p.t, title: S.v && S.v.title } });
    toast(`★ Saved “${p.phrase}”`);
  }

  /* ===== Home ===== */
  function cardHTML(v) {
    const f = SYNC.flag(v.id), n = v.n || (S.index[v.id] && S.index[v.id].n);
    return `<button class="card${f === 'watched' ? ' watched' : ''}" data-id="${esc(v.id)}">
      <div class="thumb"><img loading="lazy" src="${thumb(v.id)}" alt="">
        ${v.dur ? `<span class="dur">${esc(v.dur)}</span>` : ''}${n ? `<span class="badge">Aa ${n}</span>` : ''}
        ${v.isNew && !f ? '<span class="newb">NEW</span>' : ''}${f === 'watched' ? '<span class="wl">✓ Watched</span>' : ''}</div>
      <div class="t">${esc(v.title)}</div><div class="c">${esc(v.channel)}${v.level ? ` · ${esc(v.level)}` : ''}</div></button>`;
  }
  function renderHome() {
    const keep = {};
    document.querySelectorAll('#home .track[data-row]').forEach(t => keep[t.dataset.row] = t.scrollLeft);
    const b = LC.buildRows(S.catalog || { videos: [] });
    S.rows = b.rows; S.history = b.history;
    const n = c => `${c} video${c === 1 ? '' : 's'}`;
    const hist = S.history.length ? `<section class="hist">
        <button class="hist-head" id="histToggle"><span>🗂 Study history</span><small>${n(S.history.length)}</small><em>${S.histOpen ? 'Hide ▴' : 'Show ▾'}</em></button>
        ${S.histOpen ? `<div class="track" data-row="history">${S.history.map(cardHTML).join('')}</div>` : ''}</section>` : '';
    $('#home').innerHTML = (S.rows.length ? '' : `<div class="empty">No ${esc(LI.name)} videos yet. They appear here after the daily update has run once (see the setup guide).</div>`)
      + S.rows.map(r => `<section class="row"><h2>${esc(r.title)}<small>${n(r.items.length)}</small></h2>
        <div class="track" data-row="${esc(r.id)}">${r.items.map(cardHTML).join('')}</div></section>`).join('')
      + hist
      + `<p class="note">The <b>Aa</b> badge means the video has phrases and subtitles ready. <b>Watched</b> videos sink to the end of their row; videos you put in <b>Study history</b> wait at the bottom of the page. New videos arrive every day.</p>`;
    document.querySelectorAll('#home .track[data-row]').forEach(t => { if (keep[t.dataset.row]) t.scrollLeft = keep[t.dataset.row]; });
  }
  $('#home').addEventListener('click', e => {
    if (e.target.closest('#histToggle')) { S.histOpen = !S.histOpen; renderHome(); return; }
    const c = e.target.closest('.card'); if (c) openVideo(c.dataset.id);
  });

  async function load() {
    const [cat, idx] = await Promise.all([getData('video/catalog.json'), getData('video/phrases/index.json')]);
    S.catalog = cat || { videos: [] }; S.index = idx || {};
    renderHome(); paintSavedCount();
    const q = new URLSearchParams(location.search);
    if (q.get('v')) openVideo(q.get('v'), parseFloat(q.get('t')) || 0);
  }

  /* ===== Switching screens ===== */
  function setView(view) {
    S.view = view;
    $('#home').classList.toggle('hide', view !== 'videos');
    $('#watch').classList.toggle('hide', view !== 'watch');
    $('#savedView').classList.toggle('hide', view !== 'saved');
    document.body.classList.toggle('watching', view === 'watch');
    document.body.dataset.view = view;
    document.querySelectorAll('#tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === view));
    if (view !== 'watch') { $('#title').textContent = PHONE && view === 'saved' ? 'Saved words' : HOME_TITLE; try { player && player.pauseVideo && player.pauseVideo(); } catch (e) {} }
    if (view === 'saved') renderSaved();
    if (view === 'videos') renderHome();
    window.scrollTo(0, 0);
  }
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setView(b.dataset.tab); });
  $('#backBtn').onclick = requestBack;
  function goHome() { history.replaceState(null, '', location.pathname); closeSheet(); setView('videos'); }

  /* ===== Player ===== */
  let player = null, ytReady = false, pending = null;
  window.onYouTubeIframeAPIReady = () => { ytReady = true; if (pending) { const p = pending; pending = null; makePlayer(p.id, p.t); } };
  (() => { const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s); })();

  function makePlayer(id, t) {
    if (player && player.loadVideoById) { player.loadVideoById({ videoId: id, startSeconds: t || 0 }); return; }
    player = new YT.Player('yt', {
      videoId: id,
      playerVars: { playsinline: 1, rel: 0, iv_load_policy: 3, cc_load_policy: 0, controls: 0, disablekb: 1, fs: 0, autoplay: 1, start: Math.floor(t || 0), hl: 'en' },
      events: {
        onReady: e => { try { e.target.setPlaybackRate(S.speed); e.target.playVideo(); } catch (x) {} },
        onStateChange: e => {
          if (e.data === 1) { $('#vbox').classList.add('started'); ytCaptionsOff(); }
          if (e.data === 0) onEnded();
          paintPlay();
        },
        onApiChange: () => { try { player.unloadModule('captions'); player.unloadModule('cc'); } catch (x) {} },   // only the page's own subtitles are shown
      },
    });
  }
  const playing = () => { try { return player.getPlayerState() === YT.PlayerState.PLAYING; } catch (e) { return false; } };
  const now = () => { try { return player.getCurrentTime() || 0; } catch (e) { return 0; } };
  const duration = () => { try { return player.getDuration() || 0; } catch (e) { return 0; } };
  function ytCaptionsOff() { try { player.setOption('captions', 'track', {}); player.unloadModule('captions'); player.unloadModule('cc'); } catch (e) {} }
  function togglePlay() { if (!player || !player.getPlayerState) return; playing() ? player.pauseVideo() : player.playVideo(); setTimeout(paintPlay, 150); }
  $('#tapLayer').onclick = togglePlay;
  function paintPlay() { const b = $('#bPlay'); const t = playing() ? '❚❚' + (PHONE ? '' : ' Pause') : '▶' + (PHONE ? '' : ' Play'); if (b.textContent !== t) b.textContent = t; }

  async function openVideo(id, t = 0) {
    const v = allVideos().find(x => x.id === id) || { id, title: '', channel: '' };
    $('#vbox').classList.remove('started');
    S.v = v; S.phr = null; S.cap = null; S.sel = 0; S.now = -1; S.capIdx = -1;
    $('#title').textContent = v.title || 'Video';
    $('#vTitle').textContent = v.title; $('#vSub').textContent = v.channel;
    $('#cap').textContent = '';
    history.replaceState(null, '', `?v=${encodeURIComponent(id)}`);
    setView('watch');
    paintMarks(); renderSide();
    if (ytReady) makePlayer(id, t); else pending = { id, t };
    const [phr, cap] = await Promise.all([getData(`video/phrases/${id}.json`), getData(`video/captions/${id}.json`)]);
    if (S.v !== v) return;
    S.phr = phr && phr.phrases && phr.phrases.length ? phr : null;
    S.cap = cap && cap.s ? cap.s : null;
    if (S.phr && t) { const i = S.phr.phrases.findIndex(p => Math.abs(p.t - t) < 1); if (i >= 0) S.sel = i; }
    renderSide();
  }

  /* ===== Marks: watched / Study history ===== */
  const inCatalog = v => !!(v && v.row);
  function setFlag(s, note = true) {
    const v = S.v; if (!v) return;
    SYNC.setFlag(v.id, s);
    paintMarks();
    if (note) toast(s === 'watched' ? '✓ Watched: moved to the end of its row' : s === 'archived' ? '🗂 Put away in Study history' : 'Mark removed');
  }
  function paintMarks() {
    const f = S.v ? SYNC.flag(S.v.id) : '', show = inCatalog(S.v);
    const d = $('#bDone'), a = $('#bArch');
    d.classList.toggle('hide', !show); a.classList.toggle('hide', !show);
    d.classList.toggle('on', f === 'watched'); a.classList.toggle('on', f === 'archived');
    d.textContent = PHONE ? '✓' : f === 'watched' ? '✓ Watched' : '✓ Done';
    a.textContent = PHONE ? '🗂' : f === 'archived' ? '🗂 Archived' : '🗂 Archive';
  }
  $('#bDone').onclick = () => setFlag(SYNC.flag(S.v.id) === 'watched' ? '' : 'watched');
  $('#bArch').onclick = () => setFlag(SYNC.flag(S.v.id) === 'archived' ? '' : 'archived');

  function nextVideo() {
    const row = S.rows.find(r => r.id === (S.v && S.v.row)); if (!row) return null;
    const i = row.items.findIndex(x => x.id === S.v.id);
    return row.items.slice(i + 1).find(x => !SYNC.flag(x.id)) || null;
  }
  /* Going back after watching a good part without marking: ask */
  function requestBack() {
    const v = S.v, t = now(), d = duration();
    if (S.view === 'watch' && inCatalog(v) && !SYNC.flag(v.id) && (t >= 180 || (d && t / d >= 0.5))) {
      try { player.pauseVideo(); } catch (e) {}
      openSheet({
        title: 'Finished with this video?', sub: v.title,
        actions: [
          { label: '✓ Yes, watched', cls: 'primary', fn: () => { setFlag('watched'); goHome(); } },
          { label: '🗂 Keep in Study history', fn: () => { setFlag('archived'); goHome(); } },
          { label: 'Not yet, later', fn: goHome },
        ],
        onDismiss: () => {},
      });
      return;
    }
    goHome();
  }
  function onEnded() {
    const v = S.v; if (!inCatalog(v) || SYNC.flag(v.id)) return;
    const next = nextVideo();
    openSheet({
      title: 'All done! Mark this video?', sub: v.title,
      actions: [
        ...(next ? [{ label: `✓ Watched, play next: ${next.title}`, cls: 'primary', fn: () => { setFlag('watched', false); openVideo(next.id); } }] : []),
        { label: '✓ Watched', cls: next ? '' : 'primary', fn: () => setFlag('watched') },
        { label: '🗂 Keep in Study history', fn: () => setFlag('archived') },
        { label: 'Later', fn: () => {} },
      ],
    });
  }

  /* ===== Bottom sheet (mark prompts, sync, language) ===== */
  function openSheet({ title, sub, body = '', actions = [], onDismiss }) {
    S.sheet = { actions, onDismiss };
    $('#sheet').innerHTML = `<div class="sheet-bg" data-close></div><div class="sheet-card" role="dialog">
      <div class="grab"></div><h3>${esc(title)}</h3>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}${body}
      <div class="sheet-acts">${actions.map((a, i) => `<button class="${a.cls || ''}" data-a="${i}">${esc(a.label)}</button>`).join('')}</div></div>`;
    $('#sheet').classList.add('show');
  }
  function closeSheet() { S.sheet = null; $('#sheet').classList.remove('show'); }
  $('#sheet').addEventListener('click', e => {
    if (!S.sheet) return;
    const a = e.target.closest('[data-a]');
    if (a) { const f = S.sheet.actions[+a.dataset.a].fn; closeSheet(); f && f(); return; }
    if (e.target.closest('[data-close]')) { const f = S.sheet.onDismiss; closeSheet(); f && f(); }
  });

  /* ===== Sync TV · iPad · phone ===== */
  function openSync() {
    const link = LC.pageLink('iphone.html');
    const age = SYNC.lastPull ? Math.round((Date.now() - SYNC.lastPull) / 60000) : null;
    openSheet({
      title: 'Sync TV · iPad · phone',
      sub: SYNC.enabled ? 'Every device that opens this site shares one family store: watched videos, Study history and saved words. Nothing to scan or log in to.'
                        : 'Sync is switched off, so this device keeps its own list. Add a Firebase database in docs/config.js to share words between devices (setup guide, step 5).',
      body: `<div class="sync">
        <div class="qr" id="qr"></div>
        <div class="sync-txt">
          <p><b>Open this page on another device:</b> scan the QR code with the Camera, or send the link.</p>
          ${SYNC.enabled ? `<p class="small">Family code: <code>${esc(SYNC.code)}</code>${SYNC.isDefault ? '' : ' · <a href="#" id="useDefault">use the family code again</a>'} · ${SYNC.words().length} saved words (${esc(LI.name)})</p>
          <p class="small">${SYNC.online ? '● Connected' : '○ Not connected'}${age !== null ? ` · updated ${age < 1 ? 'just now' : age + ' min ago'}` : ''}</p>` : ''}
        </div></div>`,
      actions: [{ label: navigator.share ? 'Send the link' : 'Copy the link', fn: () => shareLink(link) }, { label: 'Close', fn: () => {} }],
    });
    LC.qr($('#qr'), link, 180);
    const ud = $('#useDefault');
    if (ud) ud.onclick = async e => { e.preventDefault(); await SYNC.useDefault(); closeSheet(); toast('Back on the family code'); };
  }
  async function shareLink(link) {
    try { if (navigator.share) { await navigator.share({ title: `Learn ${LI.name} with videos`, url: link }); return; } } catch (e) { return; }
    try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch (e) { toast(link, 6000); }
  }
  $('#syncBtn').onclick = openSync;
  function paintSync() { $('#syncBtn').classList.toggle('off', SYNC.enabled && !SYNC.online); }

  /* ===== Phrases ===== */
  function detailHTML(p, d) {
    const saved = SYNC.isSaved(p.phrase);
    return `<div class="detail">
      <div class="d-top"><span>Phrase ${S.sel + 1}/${d.phrases.length} · ${fmt(p.t)}</span><span class="live">${S.sel === S.now && playing() ? '● Being said now' : ''}</span></div>
      <div class="d-row"><div class="d-p">${esc(p.phrase)}</div>${p.pron ? `<div class="d-ipa">${esc(p.pron)}</div>` : ''}</div>
      <div class="d-m">${esc(p.meaning)}</div>
      <div class="quote">“${markQuote(p.quote, p.phrase)}”</div>
      ${p.usage ? `<div class="d-u">${esc(p.usage)}</div>` : ''}
      ${p.example ? `<div class="d-ex">${esc(p.example)}${p.example_pron ? `<small class="pr">${esc(p.example_pron)}</small>` : ''}<small>${esc(p.example_en || '')}</small></div>` : ''}
      <div class="d-act">
        <button class="primary" data-act="play">▶ ${PHONE ? 'In video' : 'Hear it in the video'}</button>
        <button data-act="say">🔊 ${PHONE ? 'Say' : 'Say it'}</button>
        <button data-act="save" class="${saved ? 'saved' : ''}">${saved ? '★ Saved' : '☆ Save'}</button>
      </div></div>`;
  }
  function renderSide() { renderDetail(); renderList(); }
  function renderDetail() {
    const el = $('#detail'), d = S.phr;
    el.innerHTML = !d || PHONE ? '' : detailHTML(d.phrases[S.sel], d);
  }
  function sideTools() {
    return PHONE ? '' : `<div class="side-tools"><button class="icon-btn back" data-tool="back" aria-label="Back">←</button>
      <span class="st-title">${esc(S.v ? S.v.title : '')}</span>
      <button class="icon-btn" data-tool="sync" aria-label="Sync">⇅</button>
      <button class="icon-btn" data-tool="theme"></button></div>`;
  }
  function renderList() {
    const el = $('#side'), d = S.phr;
    if (!d) {
      el.innerHTML = sideTools() + `<div class="empty">${S.v && (S.v.n || S.index[S.v.id]) ? 'Loading phrases…' : 'No phrases for this video yet. You can still watch it; phrases arrive with the next daily update.'}</div>`;
      paintTheme(); return;
    }
    const keep = el.scrollTop;
    el.innerHTML = `${sideTools()}
      <div class="lhead"><h3>Useful phrases</h3>${d.level ? `<span class="lvl">${esc(d.level)}</span>` : ''}<span>${d.phrases.length} · ${PHONE ? 'tap: hear · ☆/hold: save' : 'tap to hear · ☆, swipe right or hold to save'}</span></div>
      ${d.summary ? `<p class="sum">${esc(d.summary)}</p>` : ''}
      <div id="plist">${d.phrases.map((x, i) => `
        <div class="ph-wrap${i === S.sel ? ' open' : ''}"><button class="ph${i === S.sel ? ' sel' : ''}${i === S.now ? ' now' : ''}" data-i="${i}">
          <span class="st${SYNC.isSaved(x.phrase) ? ' on' : ''}" data-star="${i}" role="button" aria-label="Save this phrase">${SYNC.isSaved(x.phrase) ? '★' : '☆'}</span>
          <span class="tx"><div class="p">${esc(x.phrase)}${x.pron ? `<i class="pr">${esc(x.pron)}</i>` : ''}</div><div class="m">${esc(x.meaning)}</div></span>
          <span class="tm">${fmt(x.t)}</span>
        </button>${PHONE && i === S.sel ? detailHTML(x, d) : ''}</div>`).join('')}</div>`;
    el.scrollTop = keep;
    paintTheme();
  }
  /* Bring the selected phrase to the top edge of the list (right under the video on a phone / upright iPad);
     older phrases slide up behind the video. No scrolling when the viewer has just scrolled by hand. */
  function followSel(force) {
    if (!force && Date.now() < S.scrollHold) return;
    const el = $('#side'), row = el.querySelector('.ph-wrap.open') || el.querySelector('.ph.sel'); if (!row) return;
    const r = row.getBoundingClientRect();
    if (el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'visible') {
      const tools = el.querySelector('.side-tools');
      const top = el.getBoundingClientRect().top + (tools ? tools.offsetHeight + 4 : 6);
      el.scrollTo({ top: Math.max(0, el.scrollTop + r.top - top), behavior: 'smooth' });
    } else {
      const top = $('.stage').getBoundingClientRect().bottom + 6;
      if (Math.abs(r.top - top) > 4) window.scrollBy({ top: r.top - top, behavior: 'smooth' });
    }
  }
  document.addEventListener('click', e => {
    const a = e.target.closest('#detail [data-act], #side [data-act]');
    if (!a || !S.phr) return;
    const p = S.phr.phrases[S.sel];
    if (a.dataset.act === 'play') playPhrase(S.sel);
    else if (a.dataset.act === 'say') { try { player.pauseVideo(); } catch (x) {} if (!LC.speak(p.phrase)) toast('This device cannot read aloud'); }
    else if (a.dataset.act === 'save') { toggleSave(p); renderSide(); }
  });
  $('#side').addEventListener('click', e => {
    const tool = e.target.closest('[data-tool]');
    if (tool) { const k = tool.dataset.tool; if (k === 'back') requestBack(); else if (k === 'sync') openSync(); else cycleTheme(); return; }
    if (e.target.closest('[data-act]')) return;
    if (S.noClick && Date.now() < S.noClick) return;            // just swiped / held to save: do not jump in the video
    const star = e.target.closest('[data-star]');
    if (star && S.phr) { saveFromList(+star.dataset.star); return; }
    const row = e.target.closest('.ph'); if (!row || !S.phr) return;
    S.sel = +row.dataset.i; S.pickHold = Date.now() + 3000; playPhrase(S.sel); renderSide();
    followSel(true);
  });

  /* Save a phrase right in the list while the video keeps playing: tap ☆, swipe the row right, or press and hold */
  function saveFromList(i) {
    const p = S.phr && S.phr.phrases[i]; if (!p) return;
    toggleSave(p);
    try { navigator.vibrate && navigator.vibrate(12); } catch (e) {}
    renderSide();
  }
  let g = null;
  $('#side').addEventListener('pointerdown', e => {
    const row = e.target.closest('.ph'); if (!row || e.target.closest('[data-star]')) return;
    const i = +row.dataset.i;
    g = { row, i, x: e.clientX, y: e.clientY, done: false,
          timer: setTimeout(() => { if (g && !g.done) { g.done = true; S.noClick = Date.now() + 600; saveFromList(i); } }, 550) };
  });
  window.addEventListener('pointermove', e => {
    if (!g || g.done) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { clearTimeout(g.timer); g = null; return; }   // scrolling
    if (Math.abs(dx) > 10) clearTimeout(g.timer);
    if (dx > 0) g.row.style.transform = `translateX(${Math.min(dx, 90)}px)`;
    if (dx > 70) { g.done = true; S.noClick = Date.now() + 600; g.row.style.transform = ''; saveFromList(g.i); }
  });
  ['pointerup', 'pointercancel'].forEach(t => window.addEventListener(t, () => {
    if (!g) return; clearTimeout(g.timer); g.row.style.transform = ''; g = null;
  }));
  // The viewer scrolls the list by hand: pause auto-scroll for 4 seconds (the spoken phrase is still selected)
  window.addEventListener('touchmove', () => { if (S.view === 'watch') S.scrollHold = Date.now() + 4000; }, { passive: true });
  $('#side').addEventListener('wheel', () => { S.scrollHold = Date.now() + 4000; }, { passive: true });
  function playPhrase(i) {
    if (!player || !player.seekTo || !S.phr) return;
    player.seekTo(Math.max(0, S.phr.phrases[i].t - 0.3), true); player.playVideo();
    S.now = i;
  }

  /* ===== Control buttons ===== */
  S.speed = parseFloat(store.get('ipad.speed')) || 1;
  const SPEEDS = [0.5, 0.75, 1, 1.25];
  const paintSpeed = () => { $('#bSpeed').textContent = `${S.speed}×`; };
  paintSpeed();
  $('#bPlay').onclick = togglePlay;
  $('#bBack').onclick = () => { if (player && player.seekTo) player.seekTo(Math.max(0, now() - 5), true); };
  $('#bFwd').onclick = () => { if (player && player.seekTo) player.seekTo(now() + 10, true); };
  $('#bSpeed').onclick = () => {
    S.speed = SPEEDS[(SPEEDS.indexOf(S.speed) + 1) % SPEEDS.length]; store.set('ipad.speed', S.speed); paintSpeed();
    try { player.setPlaybackRate(S.speed); } catch (e) {}
  };
  /* Open the same moment in the YouTube app: a Premium account there plays without ads */
  $('#bYT').onclick = () => { if (!S.v) return; try { player.pauseVideo(); } catch (e) {} location.href = `https://www.youtube.com/watch?v=${encodeURIComponent(S.v.id)}&t=${Math.floor(now())}s`; };
  let ccOn = store.get('ipad.cc') !== '0';
  function paintCC() { $('#bCC').classList.toggle('on', ccOn); $('#cap').classList.toggle('off', !ccOn); }
  $('#bCC').onclick = () => { ccOn = !ccOn; store.set('ipad.cc', ccOn ? '1' : '0'); paintCC(); };
  paintCC();

  /* ===== Our own subtitle line + following the phrase being said ===== */
  setInterval(() => {
    if (S.view !== 'watch' || !player || !player.getCurrentTime) return;
    paintPlay();
    const t = now();
    if (S.cap && ccOn) {
      const k = LC.capAt(S.cap, t);
      if (k !== S.capIdx) {
        S.capIdx = k;
        const seg = k >= 0 ? S.cap[k] : null;
        const ph = seg && S.phr && S.phr.phrases.find(p => Math.abs(p.t - seg[0]) < 0.05);
        const c = $('#cap');
        c.innerHTML = !seg ? '' : ph ? markQuote(seg[2], ph.phrase) : esc(seg[2]);
        c.style.fontSize = '';
        for (let f = parseFloat(getComputedStyle(c).fontSize); c.scrollWidth > c.clientWidth + 1 && f > 11; f -= 1) c.style.fontSize = f - 1 + 'px';
      }
    }
    if (S.phr && playing()) {
      let idx = -1; S.phr.phrases.forEach((p, i) => { if (p.t <= t + 0.5) idx = i; });
      if (idx !== S.now) {
        S.now = idx;
        if (idx >= 0 && Date.now() > S.pickHold) S.sel = idx;   // the video reaches a new phrase → select it (unless one was just tapped)
        renderSide(); followSel();
      }
    }
  }, 250);

  /* ===== Saved words screen ===== */
  function renderSaved() {
    const l = SYNC.words();
    $('#savedView').innerHTML = !l.length
      ? `<div class="empty">No saved words yet. While watching a video, tap <b>☆ Save</b> on a phrase to add it here.<br><br>Saved words ${SYNC.enabled ? 'sync between the TV, iPad and phones and ' : ''}fly across the TV meteor dashboard and turn into gold targets in the games.</div>`
      : `<div class="lhead"><h3>Saved words</h3><span>${l.length} · newest first</span></div>` + l.map((o, i) => `
        <div class="sw">
          <div class="h"><span class="w">${esc(o.w)}</span>${o.pron ? `<span class="i">${esc(o.pron)}</span>` : ''}</div>
          <div class="v">${esc(o.en)}</div>
          ${o.ex ? `<div class="e">${esc(o.ex)}${o.ex_en ? `<small>${esc(o.ex_en)}</small>` : ''}</div>` : ''}
          ${o.src && o.src.title ? `<div class="src">From: ${esc(o.src.title)} · ${fmt(o.src.t)}${o.added ? ` · saved ${esc(o.added)}` : ''}</div>` : ''}
          <div class="a">
            <button data-say="${i}">🔊 Say it</button>
            ${o.src && o.src.id ? `<button data-go="${i}">▶ Watch that moment</button>` : ''}
            <button data-del="${i}">Remove</button>
          </div>
        </div>`).join('');
  }
  $('#savedView').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const l = SYNC.words();
    if (b.dataset.say) { if (!LC.speak(l[+b.dataset.say].w)) toast('This device cannot read aloud'); }
    else if (b.dataset.go) { const o = l[+b.dataset.go]; openVideo(o.src.id, o.src.t); }
    else if (b.dataset.del) { const o = l[+b.dataset.del]; SYNC.removeWord(o.w); toast(`Removed “${o.w}”`); }
  });

  /* ===== Sync: repaint when another device changes something ===== */
  SYNC.on(what => {
    paintSync();
    if (what !== 'data') return;
    paintSavedCount();
    if (S.view === 'videos') renderHome();
    else if (S.view === 'saved') renderSaved();
    else if (S.view === 'watch') { paintMarks(); renderList(); }
  });
  SYNC.consumeParam().then(ok => { if (ok) toast('Connected to the family store'); });
  SYNC.start();
  paintSync();
  $('#title').textContent = HOME_TITLE;
  load();
})();
