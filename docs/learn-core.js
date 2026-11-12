/* learn-core.js — shared by every page: TV dashboard (tv.html), TV videos (video.html),
 * iPad (ipad.html), phone (iphone.html) and the two games. Needs config.js loaded first.
 *
 * 1. Language: which language this device is learning right now (zh, vi, …). Chosen on the start
 *    page, by ?lang=xx in the address, or with the language button on each page; remembered per device.
 *    All content lives in docs/data/<lang>/.
 * 2. Sync between devices through Firebase Realtime Database (plain REST, no library):
 *    - video flags: 'watched' (sinks to the end of its row) | 'archived' (moves to Study history) | ''
 *    - saved ★ words (they also fly on the TV meteor dashboard); deleted words are hidden everywhere
 *    Data lives at /sync/<FAMILY CODE>-<lang>/{flags,words}. The security rules (video/firebase-rules.json)
 *    only allow access when you know the code (20+ characters). The code sits in a public page, so treat
 *    it as "hard to guess", not secret: it only ever holds watched flags and vocabulary.
 *    Two devices edit the same item: the newer edit wins.
 * 3. Video catalog: rows by topic, new videos first, watched ones last, archived ones in Study history.
 * 4. Small helpers: load JSON, highlight a phrase inside a caption, find the caption at a time,
 *    read a word aloud, draw a QR code.
 */
(function () {
  const CFG = window.FAMILY_CONFIG || {};
  const LANGS = CFG.languages || { zh: { name: 'Chinese', native: '中文', tts: 'zh-CN' } };
  const LANG_KEYS = Object.keys(LANGS);
  const SYNC_DB = String(CFG.syncDb || '').replace(/\/+$/, '');
  const DEFAULT_CODE = String(CFG.syncCode || '');
  const POLL_MS = 45000;

  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    raw(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    rawSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  /* ---------- Language ---------- */
  const qs = new URLSearchParams(location.search);
  let LANG = qs.get('lang');
  if (LANG && LANGS[LANG]) ls.rawSet('learn.lang', LANG);
  else LANG = ls.raw('learn.lang');
  if (!LANGS[LANG]) LANG = LANGS[CFG.defaultLang] ? CFG.defaultLang : LANG_KEYS[0];
  const langInfo = Object.assign({ code: LANG }, LANGS[LANG]);
  document.documentElement.dataset.lang = LANG;
  const dataUrl = path => `data/${LANG}/${path}`;
  /* Switch language and reload this page (drops ?v= and ?lang= so nothing from the other language sticks). */
  function setLang(l) {
    if (!LANGS[l]) return;
    ls.rawSet('learn.lang', l);
    location.replace(location.pathname);
  }
  const nextLang = () => LANG_KEYS[(LANG_KEYS.indexOf(LANG) + 1) % LANG_KEYS.length];

  const K = { code: 'learn.sync.code', custom: 'learn.sync.custom', flags: `learn.${LANG}.flags.v1`, words: `learn.${LANG}.words.v1`,
              saved: `meteor-saved-${LANG}`, pulled: `learn.${LANG}.sync.pulled` };
  const now = () => Date.now();
  const validCode = c => typeof c === 'string' && /^[a-z0-9-]{20,60}$/.test(c);
  /* Key of a word in the store. Keeps Chinese characters and Vietnamese accents (mà ≠ má);
     only strips what Firebase does not allow in a key:  . $ # [ ] /  and control characters. */
  const wordKey = w => String(w || '').normalize('NFC').toLowerCase().trim()
    .replace(/[.$#\[\]\/\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'w';

  /* ---------- Local state ---------- */
  let flags = ls.get(K.flags, {});            // { videoId: { s, t } }
  let words = ls.get(K.words, {});            // { key: { w, pron, pos, en, ex, ex_en, col, added, src, t, del, hide } }
  let code = ls.raw(K.code);
  if (!(validCode(code) && ls.raw(K.custom) === '1')) { code = DEFAULT_CODE; ls.rawSet(K.code, code); }
  const syncOn = () => !!SYNC_DB && validCode(code);

  const listeners = new Set();
  const emit = what => listeners.forEach(fn => { try { fn(what); } catch (e) {} });

  function writeSavedArray() {               // the meteor dashboard reads this array
    const arr = Object.values(words).filter(o => !o.del).sort((a, b) => b.t - a.t)
      .map(o => ({ w: o.w, pron: o.pron || '', pos: o.pos || 'from a video', en: o.en || '', ex: o.ex || '', ex_en: o.ex_en || '',
                   col: o.col || [], saved: true, added: o.added || '', src: o.src || null }));
    ls.set(K.saved, arr);
  }
  writeSavedArray();

  /* ---------- Firebase REST ---------- */
  const base = () => `${SYNC_DB}/sync/${code}-${LANG}`;
  let online = false, lastErr = '', pushTimer = null;
  const pending = {};                         // "flags/xxx" | "words/yyy" → value waiting to be pushed

  function queue(path, value) {
    if (!syncOn()) return;
    pending[path] = value;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(flush, 300);
  }
  async function flush() {
    if (!syncOn()) return;
    const body = Object.assign({}, pending);
    if (!Object.keys(body).length) return;
    Object.keys(body).forEach(k => delete pending[k]);
    try {
      const r = await fetch(`${base()}.json`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      online = true; lastErr = '';
    } catch (e) {
      const newer = Object.assign({}, pending);
      Object.assign(pending, body, newer);    // keep them; the next push retries (newer edits are not overwritten)
      online = false; lastErr = String(e.message || e);
    }
    emit('status');
  }

  let pulling = null;
  async function pull() {
    if (!syncOn()) return false;
    if (pulling) return pulling;
    pulling = (async () => {
      let changed = false;
      try {
        const r = await fetch(`${base()}.json`, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const remote = (await r.json()) || {};
        const rf = remote.flags || {}, rw = remote.words || {};
        // Take whatever is newer on the server
        for (const [id, v] of Object.entries(rf)) {
          if (v && typeof v.t === 'number' && (!flags[id] || v.t > flags[id].t)) { flags[id] = { s: v.s || '', t: v.t }; changed = true; }
        }
        for (const [k, v] of Object.entries(rw)) {
          if (v && typeof v.t === 'number' && (!words[k] || v.t > words[k].t)) { words[k] = v; changed = true; }
        }
        // Push whatever is newer on this device (also right after joining another code)
        for (const [id, v] of Object.entries(flags)) if (!rf[id] || rf[id].t < v.t) pending['flags/' + id] = v;
        for (const [k, v] of Object.entries(words)) if (!rw[k] || rw[k].t < v.t) pending['words/' + k] = v;
        if (changed) { ls.set(K.flags, flags); ls.set(K.words, words); writeSavedArray(); }
        online = true; lastErr = '';
        ls.rawSet(K.pulled, String(now()));
        await flush();
      } catch (e) { online = false; lastErr = String(e.message || e); }
      pulling = null;
      emit(changed ? 'data' : 'status');
      return changed;
    })();
    return pulling;
  }

  let pollTimer = null;
  function startPolling() {
    if (pollTimer || !syncOn()) return;
    pull();
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible') pull(); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pull(); });
    window.addEventListener('online', pull);
    window.addEventListener('focus', pull);
  }

  const save = (k) => { ls.set(K.words, words); writeSavedArray(); queue('words/' + k, words[k]); emit('data'); };

  /* ---------- Sync API ---------- */
  const Sync = {
    db: SYNC_DB,
    get enabled() { return syncOn(); },
    get isDefault() { return code === DEFAULT_CODE; },
    useDefault() { ls.rawSet(K.custom, '0'); return this.join(DEFAULT_CODE); },
    get code() { return code; },
    get online() { return online; },
    get error() { return lastErr; },
    get lastPull() { return +ls.raw(K.pulled) || 0; },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start: startPolling,
    pull,
    /* Video flags */
    flag(id) { const f = flags[id]; return f && f.s ? f.s : ''; },
    flagTime(id) { return flags[id] ? flags[id].t : 0; },
    setFlag(id, s) {
      if (!id) return;
      flags[id] = { s: s || '', t: now() };
      ls.set(K.flags, flags);
      queue('flags/' + id, flags[id]);
      emit('data');
    },
    /* Saved words */
    words() { return Object.values(words).filter(o => !o.del).sort((a, b) => b.t - a.t); },
    isSaved(w) { const o = words[wordKey(w)]; return !!(o && !o.del); },
    saveWord(o) {
      const k = wordKey(o.w);
      words[k] = Object.assign({}, o, { t: now(), del: false, added: o.added || new Date().toISOString().slice(0, 10) });
      save(k);
    },
    removeWord(w) {
      const k = wordKey(w); if (!words[k]) return;
      words[k] = Object.assign({}, words[k], { t: now(), del: true });
      save(k);
    },
    /* Remove a word from the meteor dashboard and the games on every device (also words from the built-in list) */
    hideWord(w) {
      const k = wordKey(w);
      words[k] = Object.assign({ w }, words[k] || {}, { t: now(), del: true, hide: true });
      save(k);
    },
    unhideWord(w, restore) {
      const k = wordKey(w);
      words[k] = restore ? Object.assign({}, restore, { t: now(), del: false, hide: false })
                         : Object.assign({}, words[k] || { w }, { t: now(), del: true, hide: false });
      save(k);
    },
    isHidden(w) { const o = words[wordKey(w)]; return !!(o && o.hide); },
    /* Family code */
    async join(newC) {
      newC = String(newC || '').trim().toLowerCase();
      if (!validCode(newC)) return false;
      if (newC === code) { await pull(); return true; }
      code = newC; ls.rawSet(K.code, code); ls.rawSet(K.custom, newC === DEFAULT_CODE ? '0' : '1');
      await pull();                           // merges this device's data into the new code
      return true;
    },
    /* Reads ?sync=CODE from the address (QR code / shared link), joins, then cleans the address */
    async consumeParam() {
      const p = new URLSearchParams(location.search);
      const c = p.get('sync');
      if (!c) return false;
      p.delete('sync');
      const q = p.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
      return Sync.join(c);
    },
  };

  /* ---------- Video catalog ---------- */
  const getJSON = u => fetch(u, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
  const getData = path => getJSON(dataUrl(path));
  const daysAgo = d => { const t = Date.parse(d || ''); return isNaN(t) ? 9999 : (now() - t) / 86400000; };

  /* Returns { rows:[{id,title,items}], history:[...], total }. Every item also gets: flag, isNew, ready.
     Inside a row: unwatched videos (with phrases first, newest first) → watched videos (at the end).
     Archived videos are in no row; they are in history. newRow: a "New" row at the top. */
  function buildRows(catalog, opts = {}) {
    const newDays = opts.newDays ?? 3;
    const vids = (catalog && catalog.videos) || [];
    const titles = Object.fromEntries(((catalog && catalog.rows) || []).map(r => [r.id, r.title]));
    const order = ((catalog && catalog.rows) || []).map(r => r.id);
    const items = vids.map(v => Object.assign({}, v, {
      flag: Sync.flag(v.id), flagT: Sync.flagTime(v.id), ready: (v.n || 0) > 0, isNew: daysAgo(v.added) < newDays,
    }));
    const byRow = {};
    items.forEach(v => { if (v.flag !== 'archived') (byRow[v.row] = byRow[v.row] || []).push(v); });
    const active = (a, b) => (b.ready - a.ready) || String(b.added).localeCompare(String(a.added)) || String(b.published).localeCompare(String(a.published));
    const sortRow = list => list.filter(v => v.flag !== 'watched').sort(active)
      .concat(list.filter(v => v.flag === 'watched').sort((a, b) => b.flagT - a.flagT));
    const ids = order.concat(Object.keys(byRow).filter(id => !order.includes(id)));
    const rows = ids.filter(id => byRow[id] && byRow[id].length)
      .map(id => ({ id, title: titles[id] || id, items: sortRow(byRow[id]) }));
    if (opts.newRow !== false) {
      const fresh = items.filter(v => v.isNew && v.ready && !v.flag).sort(active).slice(0, 20);
      if (fresh.length && fresh.length < items.length) rows.unshift({ id: 'new', title: opts.newTitle || 'New this week', items: fresh, isNewRow: true });
    }
    const history = items.filter(v => v.flag === 'archived').sort((a, b) => b.flagT - a.flagT);
    return { rows, history, total: vids.length };
  }

  /* ---------- Helpers ---------- */
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = s => { s = Math.max(0, Math.floor(s || 0)); const m = Math.floor(s / 60), x = String(s % 60).padStart(2, '0'); return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${x}` : `${m}:${x}`; };
  const CJK = /[㐀-鿿豈-﫿]/;
  /* Highlight a phrase inside a caption line. Exact match first; otherwise Chinese marks the
     characters of the phrase, and spaced languages mark the phrase's whole words. */
  function markQuote(q, phrase) {
    const text = esc(q || ''), p = esc(String(phrase || '').trim());
    if (!p) return text;
    const i = text.toLowerCase().indexOf(p.toLowerCase());
    if (i >= 0) return `${text.slice(0, i)}<mark>${text.slice(i, i + p.length)}</mark>${text.slice(i + p.length)}`;
    if (CJK.test(p)) {
      const set = new Set([...p].filter(c => CJK.test(c)));
      return text.replace(/[㐀-鿿豈-﫿]+/g, run => {
        let out = '', buf = '';
        const end = () => { if (buf) { out += buf.length > 1 ? `<mark>${buf}</mark>` : buf; buf = ''; } };
        for (const c of run) { if (set.has(c)) buf += c; else { end(); out += c; } }
        end(); return out;
      });
    }
    const wanted = p.toLowerCase().split(/\s+/).filter(Boolean);
    return text.replace(/[\p{L}\p{M}'’-]+/gu, w => wanted.includes(w.toLowerCase()) ? `<mark>${w}</mark>` : w);
  }
  function capAt(segs, t) {                  // segs: [[start, dur, text], ...]
    if (!segs || !segs.length) return -1;
    let lo = 0, hi = segs.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (segs[m][0] <= t) { k = m; lo = m + 1; } else hi = m - 1; }
    if (k < 0) return -1;
    return (t <= segs[k][0] + Math.max(segs[k][1], 1.2) + 0.4 || (segs[k + 1] && t < segs[k + 1][0])) ? k : -1;
  }
  /* Read a word aloud in the language being learned (works on phones, tablets and computers; most TVs stay silent). */
  function speak(text, rate) {
    if (!('speechSynthesis' in window) || !text) return false;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      const want = (langInfo.tts || LANG).toLowerCase(), short = want.slice(0, 2);
      u.lang = langInfo.tts || LANG; u.rate = rate || 0.85;
      const vs = speechSynthesis.getVoices();
      const norm = x => String(x.lang || '').toLowerCase().replace('_', '-');
      const v = vs.find(x => norm(x) === want) || vs.find(x => norm(x).startsWith(short));
      if (v) u.voice = v;
      speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }
  if ('speechSynthesis' in window) { try { speechSynthesis.getVoices(); } catch (e) {} }   // voices load lazily on some browsers
  let qrLib = null;
  function qr(el, text, size = 220) {
    qrLib = qrLib || new Promise((res, rej) => {
      if (window.QRCode) return res();
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
    return qrLib.then(() => {
      el.innerHTML = '';
      new window.QRCode(el, { text, width: size, height: size, colorDark: '#111111', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
    }).catch(() => { el.textContent = 'Could not draw the QR code. Use the link instead.'; });
  }
  /* Address of another page of this site, carrying the current language (for QR codes and share links). */
  function pageLink(page) {
    const dir = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
    return `${dir}${page}${page.includes('?') ? '&' : '?'}lang=${LANG}`;
  }
  /* An iPad that opens the phone link (or the other way round) moves to the page that fits its screen; ?v= and ?sync= are kept */
  function routeDevice(page) {
    const short = Math.min(screen.width, screen.height);
    const want = short >= 700 ? 'ipad' : 'iphone';
    if (page !== want && !/[?&]stay=1/.test(location.search)) {
      location.replace(location.pathname.replace(/[^/]*$/, `${want}.html`) + location.search + location.hash);
      return true;
    }
    return false;
  }

  window.LearnCore = { CFG, LANG, LANGS, LANG_KEYS, langInfo, setLang, nextLang, dataUrl, pageLink,
    Sync, SYNC_DB, getJSON, getData, buildRows, esc, fmt, markQuote, capAt, speak, qr, routeDevice, wordKey };
})();
