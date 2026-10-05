/* =========================================================
   Deer Fabrics — interactions
   One cloth renderer drives the hero loom, the swatch book
   and the weave lab.
   ========================================================= */
(() => {
  'use strict';

  // ---- Contact details: replace before going live ---------------------
  const DF = {
    whatsapp: '919443204792',          // country code + number, digits only
    email: 'info@deerfabrics.in',
  };

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const mod = (n, m) => ((n % m) + m) % m;
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

  /* ------------------------------------------------------------------
     Cloth renderer
     A "loom spec" L = { up(x,y) → bool, warp(x) → hex, weft(y) → hex }
     up = warp thread lies on top at that crossing.
     ------------------------------------------------------------------ */
  const palCache = new Map();
  const hexRgb = h => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  const shade = (c, f) => f >= 0 ? c.map(v => Math.round(v + (255 - v) * f)) : c.map(v => Math.round(v * (1 + f)));
  const rgbStr = c => `rgb(${c[0]},${c[1]},${c[2]})`;
  const SLUB = [-0.07, 0, 0.05];

  function pal(hex, v) {
    const k = hex + v;
    let p = palCache.get(k);
    if (!p) {
      const c = shade(hexRgb(hex), SLUB[v]);
      p = { base: rgbStr(c), light: rgbStr(shade(c, 0.22)), dark: rgbStr(shade(c, -0.3)), deep: rgbStr(shade(c, -0.5)) };
      palCache.set(k, p);
    }
    return p;
  }
  // deterministic per-thread unevenness, like real slub yarn
  const slub = n => (Math.imul(n | 0, 2654435761) >>> 0) % 3;

  function paintCell(ctx, x, y, s, L) {
    const px = x * s, py = y * s;
    const g = Math.max(1, Math.round(s * 0.12));
    const hl = Math.max(1, Math.round(s * 0.16));
    const cap = Math.max(1, Math.round(s * 0.16));
    if (L.up(x, y)) {
      const p = pal(L.warp(x), slub(x + 7));
      ctx.fillStyle = p.deep;  ctx.fillRect(px, py, s, s);
      ctx.fillStyle = p.base;  ctx.fillRect(px + g, py, s - 2 * g, s);
      ctx.fillStyle = p.light; ctx.fillRect(px + Math.round(s * 0.36), py, hl, s);
      ctx.fillStyle = p.dark;
      if (!L.up(x, y - 1)) ctx.fillRect(px + g, py, s - 2 * g, cap);
      if (!L.up(x, y + 1)) ctx.fillRect(px + g, py + s - cap, s - 2 * g, cap);
    } else {
      const p = pal(L.weft(y), slub(y * 3 + 101));
      ctx.fillStyle = p.deep;  ctx.fillRect(px, py, s, s);
      ctx.fillStyle = p.base;  ctx.fillRect(px, py + g, s, s - 2 * g);
      ctx.fillStyle = p.light; ctx.fillRect(px, py + Math.round(s * 0.36), s, hl);
      ctx.fillStyle = p.dark;
      if (L.up(x - 1, y)) ctx.fillRect(px, py + g, cap, s - 2 * g);
      if (L.up(x + 1, y)) ctx.fillRect(px + s - cap, py + g, cap, s - 2 * g);
    }
  }

  function paintCloth(canvas, L, s) {
    const ctx = canvas.getContext('2d');
    const cols = Math.ceil(canvas.width / s), rows = Math.ceil(canvas.height / s);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) paintCell(ctx, x, y, s, L);
  }

  function fitCanvas(canvas) {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr())), h = Math.max(1, Math.round(r.height * dpr()));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; return true; }
    return false;
  }

  /* ------------------------------------------------------------------
     Weave drafts (all repeat within 8 ends × 8 picks except damask)
     ------------------------------------------------------------------ */
  const DRAFTS = {
    plain:        (x, y) => mod(x + y, 2) === 0,
    twill22:      (x, y) => mod(x + y, 4) < 2,
    twill31:      (x, y) => mod(x + y, 4) < 3,
    herringbone:  (x, y) => mod(Math.floor(x / 4), 2) === 0 ? mod(x + y, 4) < 2 : mod(y - x + 1, 4) < 2,
    basket:       (x, y) => mod(Math.floor(x / 2) + Math.floor(y / 2), 2) === 0,
    honeycomb:    (x, y) => {
      const d = Math.abs(mod(x, 8) - 3.5) + Math.abs(mod(y, 8) - 3.5);
      return mod(Math.floor((d - 1) / 2), 2) === 0;
    },
    satin:        (x, y) => mod(x, 8) !== mod(3 * y, 8),
    damaskStripe: (x, y) => mod(x, 16) < 8 ? DRAFTS.satin(x, y) : !DRAFTS.satin(x, y),
  };

  // "#a*6,#b*2" → ['#a','#a',…,'#b','#b']
  const parseYarns = str => str.split(',').flatMap(part => {
    const [c, n] = part.trim().split('*');
    return Array(n ? +n : 1).fill(c);
  });
  /* ------------------------------------------------------------------
     Hero loom
     ------------------------------------------------------------------ */
  const Loom = (() => {
    const COLS = 96, ROWS = 100, PICK_MS = 52;
    const INDIGO = '#22306A', MADDER = '#9E3A2C', KORA = '#E6DCC4', TURM = '#C8961E';
    const cloth = $('#loom-cloth'), over = $('#loom-over');
    const counter = $('#loom-count'), again = $('#loom-again');
    let mask = null, s = 4, row = 0, drawn = 0, t0 = 0, raf = 0, started = false, done = false;

    function buildMask() {
      const c = document.createElement('canvas');
      c.width = COLS; c.height = ROWS;
      const g = c.getContext('2d');
      g.fillStyle = '#000'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      const fit = (txt, weight, maxW, base) => {
        g.font = `${weight} 100px Fraunces, Georgia, serif`;
        const size = 100 * maxW / g.measureText(txt).width;
        g.font = `${weight} ${size}px Fraunces, Georgia, serif`;
        g.fillText(txt, COLS / 2, base);
      };
      fit('DEER', 800, 80, 40);
      fit('FABRICS', 700, 80, 79);
      const d = g.getImageData(0, 0, COLS, ROWS).data;
      const m = new Uint8Array(COLS * ROWS);
      for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 70 ? 1 : 0;
      // inset frame + diamond band, woven warp-faced
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
        const inF = x >= 3 && x <= COLS - 4 && y >= 3 && y <= ROWS - 4;
        if (inF && (x === 3 || x === COLS - 4 || y === 3 || y === ROWS - 4)) m[y * COLS + x] = 1;
        if (y >= 47 && y <= 57 && x >= 6 && x <= COLS - 7) {
          const dd = Math.abs(mod(x - 6, 12) - 6) + Math.abs(y - 52);
          if (dd === 5 || dd <= 1) m[y * COLS + x] = 1;
        }
        if (y >= 86 && y <= 90 && x >= 6 && x <= COLS - 7) {
          const dd = Math.abs(mod(x - 6, 6) - 3) + Math.abs(y - 88);
          if (dd === 2) m[y * COLS + x] = 1;
        }
      }
      return m;
    }

    const L = {
      up(x, y) {
        if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return false;
        // damask: warp-faced 8-end satin figure on a weft-faced satin ground
        const tie = mod(x, 8) === mod(3 * y, 8);
        return mask[y * COLS + x] ? !tie : tie;
      },
      warp: x => (x < 2 || x >= COLS - 2) ? MADDER : INDIGO,
      weft: y => (y === 7 || y === 8 || y === ROWS - 9 || y === ROWS - 8) ? MADDER
               : (y === 10 || y === ROWS - 11) ? TURM : KORA,
    };

    function size() {
      const w = cloth.getBoundingClientRect().width * dpr();
      s = Math.max(2, Math.floor(w / COLS));
      cloth.width = over.width = COLS * s;
      cloth.height = over.height = ROWS * s;
    }

    function paintWarpBed() {
      const ctx = cloth.getContext('2d');
      ctx.fillStyle = '#D9D0BA';
      ctx.fillRect(0, 0, cloth.width, cloth.height);
      const lw = Math.max(1, Math.round(s * 0.34));
      for (let x = 0; x < COLS; x++) {
        ctx.fillStyle = L.warp(x) === MADDER ? 'rgba(158,58,44,.75)' : 'rgba(34,48,106,.62)';
        ctx.fillRect(x * s + Math.round((s - lw) / 2), 0, lw, cloth.height);
      }
    }

    function paintRows(upTo) {
      const ctx = cloth.getContext('2d');
      for (let y = 0; y < upTo; y++) for (let x = 0; x < COLS; x++) paintCell(ctx, x, y, s, L);
    }

    function drawOverlay(r, frac) {
      const o = over.getContext('2d');
      o.clearRect(0, 0, over.width, over.height);
      if (r >= ROWS) return;
      const W = over.width;
      // reed: beats up after each pick
      const beat = Math.pow(1 - frac, 5) * s * 2.2;
      const ry = (r + 1) * s + s * 0.8 + beat;
      o.fillStyle = 'rgba(70,52,34,.85)';
      o.fillRect(0, ry, W, Math.max(2, s * 0.45));
      o.fillStyle = 'rgba(70,52,34,.35)';
      for (let x = 0; x < COLS; x++) o.fillRect(x * s, ry, 1, s * 2.2);
      o.fillRect(0, ry + s * 2.2, W, Math.max(1, s * 0.25));
      // shuttle
      const dir = r % 2 === 0 ? 1 : -1;
      const cx = dir > 0 ? frac * W : (1 - frac) * W;
      const cy = r * s + s / 2;
      const len = Math.max(44 * dpr(), s * 11), h = Math.max(9 * dpr(), s * 2.4);
      o.save();
      o.translate(cx, cy);
      o.beginPath();
      o.moveTo(-len / 2, 0);
      o.quadraticCurveTo(-len * 0.3, -h / 2, -len * 0.15, -h / 2);
      o.lineTo(len * 0.15, -h / 2);
      o.quadraticCurveTo(len * 0.3, -h / 2, len / 2, 0);
      o.quadraticCurveTo(len * 0.3, h / 2, len * 0.15, h / 2);
      o.lineTo(-len * 0.15, h / 2);
      o.quadraticCurveTo(-len * 0.3, h / 2, -len / 2, 0);
      o.closePath();
      o.fillStyle = '#8A5D35'; o.fill();
      o.lineWidth = Math.max(1, dpr()); o.strokeStyle = '#4E331C'; o.stroke();
      o.fillStyle = '#3A2614';
      o.fillRect(-len * 0.16, -h * 0.22, len * 0.32, h * 0.44);
      o.fillStyle = KORA;                                   // pirn of weft yarn
      o.fillRect(-len * 0.13, -h * 0.13, len * 0.26, h * 0.26);
      o.restore();
    }

    function setCount(r) { counter.textContent = `Pick ${String(r).padStart(3, '0')} / ${ROWS}`; }

    function frame(now) {
      if (!t0) t0 = now;
      const target = Math.min(ROWS, (now - t0) / PICK_MS);
      const ctx = cloth.getContext('2d');
      while (row < Math.floor(target)) {
        const dir = row % 2 === 0;
        for (let i = drawn; i < COLS; i++) paintCell(ctx, dir ? i : COLS - 1 - i, row, s, L);
        row++; drawn = 0;
      }
      if (row < ROWS) {
        const frac = target - row;
        const n = Math.floor(frac * COLS);
        const dir = row % 2 === 0;
        for (let i = drawn; i < n; i++) paintCell(ctx, dir ? i : COLS - 1 - i, row, s, L);
        drawn = n;
        drawOverlay(row, frac);
        setCount(row);
        raf = requestAnimationFrame(frame);
      } else finish();
    }

    function finish() {
      done = true;
      drawOverlay(ROWS, 0);
      counter.textContent = 'Bolt complete';
      again.hidden = false;
    }

    function start() {
      cancelAnimationFrame(raf);
      row = 0; drawn = 0; t0 = 0; done = false; again.hidden = true;
      size(); paintWarpBed();
      if (reduceMotion) { paintRows(ROWS); finish(); return; }
      raf = requestAnimationFrame(frame);
    }

    async function init() {
      try {
        await Promise.race([
          Promise.all([document.fonts.load('800 40px Fraunces'), document.fonts.load('700 40px Fraunces')]),
          new Promise(r => setTimeout(r, 2500)),
        ]);
      } catch (_) { /* fall back to Georgia */ }
      mask = buildMask();
      size(); paintWarpBed();
      const io = new IntersectionObserver(es => {
        if (es.some(e => e.isIntersecting) && !started) { started = true; start(); io.disconnect(); }
      }, { threshold: 0.25 });
      io.observe(cloth);
      again.addEventListener('click', start);
    }

    function resize() {
      if (!mask) return;
      const prev = s;
      const w = cloth.getBoundingClientRect().width * dpr();
      if (Math.max(2, Math.floor(w / COLS)) === prev) return;
      size(); paintWarpBed();
      paintRows(done ? ROWS : row);
      if (done) finish();
    }

    return { init, resize };
  })();

  /* ------------------------------------------------------------------
     Swatch book
     ------------------------------------------------------------------ */
  const swatches = $$('.swatch').map(el => {
    const warp = parseYarns(el.dataset.warp), weft = parseYarns(el.dataset.weft);
    const up = DRAFTS[el.dataset.draft] || DRAFTS.plain;
    const canvas = document.createElement('canvas');
    $('.swatch__cloth', el).appendChild(canvas);
    return {
      el, canvas, warp, weft, draft: el.dataset.draft, code: el.dataset.code,
      name: $('h3', el).textContent,
      L: { up, warp: x => warp[mod(x, warp.length)], weft: y => weft[mod(y, weft.length)] },
    };
  });

  function paintSwatches(force) {
    const s = Math.max(2, Math.round(4.5 * dpr()));
    swatches.forEach(sw => { if (fitCanvas(sw.canvas) || force) paintCloth(sw.canvas, sw.L, s); });
  }

  /* ------------------------------------------------------------------
     Weave lab
     ------------------------------------------------------------------ */
  const Lab = (() => {
    const N = 8;
    const DYES = [
      ['Indigo', '#24336B'], ['Madder', '#9E3A2C'], ['Turmeric', '#C8961E'],
      ['Kora', '#E3D8BE'], ['Bleached', '#F3EFE6'],
    ];
    const ZOOMS = [3, 6, 12];
    const state = { m: [], warp: '#24336B', weft: '#E3D8BE', zoom: 1, preset: 'twill22' };
    const draftEl = $('#draft'), canvas = $('#lab-canvas');
    const cells = [];

    const L = {
      up: (x, y) => state.m[mod(y, N)][mod(x, N)],
      warp: () => state.warp,
      weft: () => state.weft,
    };

    function fromFn(fn) {
      state.m = Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => !!fn(x, y)));
    }

    function code() {
      return state.m.map(r => parseInt(r.map(b => (b ? 1 : 0)).join(''), 2).toString(16).padStart(2, '0')).join('').toUpperCase();
    }

    function longestRun(arr, val) {
      if (arr.every(v => v === val)) return arr.length;
      let best = 0, cur = 0;
      for (let i = 0; i < arr.length * 2; i++) {
        if (arr[i % arr.length] === val) { cur++; best = Math.max(best, cur); } else cur = 0;
      }
      return Math.min(best, arr.length);
    }

    function readout() {
      const cols = Array.from({ length: N }, (_, x) => state.m.map(r => r[x]));
      const warpFloat = Math.max(...cols.map(c => longestRun(c, true)));
      const weftFloat = Math.max(...state.m.map(r => longestRun(r, false)));
      const ups = state.m.flat().filter(Boolean).length;
      $('#r-code').textContent = code().replace(/(.{4})/g, '$1 ').trim();
      $('#r-float').textContent = `${Math.max(warpFloat, weftFloat)} ${warpFloat >= weftFloat ? 'warp' : 'weft'}`;
      $('#r-face').textContent = Math.round(ups / (N * N) * 100) + '%';

      const deadEnds = cols.map((c, i) => (c.every(Boolean) || c.every(v => !v)) ? i + 1 : 0).filter(Boolean);
      const deadPicks = state.m.map((r, i) => (r.every(Boolean) || r.every(v => !v)) ? i + 1 : 0).filter(Boolean);
      const warn = $('#r-warn');
      if (deadEnds.length || deadPicks.length) {
        const parts = [];
        if (deadEnds.length) parts.push(`end${deadEnds.length > 1 ? 's' : ''} ${deadEnds.join(', ')}`);
        if (deadPicks.length) parts.push(`pick${deadPicks.length > 1 ? 's' : ''} ${deadPicks.join(', ')}`);
        warn.textContent = `⚠ ${parts.join(' and ')} never interlace, so this cloth won't hold together.`;
      } else if (Math.max(warpFloat, weftFloat) > 5) {
        warn.textContent = '⚠ Long floats will snag. Fine for a figure, risky for a ground.';
      } else warn.textContent = '';
    }

    function render() {
      cells.forEach(c => c.setAttribute('aria-pressed', String(state.m[c._y][c._x])));
      fitCanvas(canvas);
      paintCloth(canvas, L, Math.round(ZOOMS[state.zoom] * dpr()));
      readout();
      $$('#presets button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset)));
      $$('.dyes').forEach(row => $$('.dye', row).forEach(d =>
        d.setAttribute('aria-pressed', String(d.dataset.c.toLowerCase() === state[row.dataset.for].toLowerCase()))));
    }

    function buildGrid() {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const b = document.createElement('button');
        b.type = 'button'; b._x = x; b._y = y;
        b.setAttribute('aria-label', `End ${x + 1}, pick ${y + 1}`);
        cells.push(b); draftEl.appendChild(b);
      }
      let painting = null;
      const set = (b) => {
        if (!b || b._x === undefined || state.m[b._y][b._x] === painting) return;
        state.m[b._y][b._x] = painting; state.preset = null; render();
      };
      draftEl.addEventListener('pointerdown', e => {
        const b = e.target.closest('button'); if (!b) return;
        e.preventDefault();
        painting = !state.m[b._y][b._x];
        set(b);
      });
      draftEl.addEventListener('pointermove', e => {
        if (painting === null) return;
        set(document.elementFromPoint(e.clientX, e.clientY)?.closest('#draft button'));
      });
      addEventListener('pointerup', () => { painting = null; });
      draftEl.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target._x !== undefined) {
          e.preventDefault();
          const b = e.target; state.m[b._y][b._x] = !state.m[b._y][b._x]; state.preset = null; render();
        }
      });
    }

    function buildDyes() {
      $$('.dyes').forEach(row => {
        DYES.forEach(([name, c]) => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'dye'; b.dataset.c = c; b.dataset.name = name;
          b.style.setProperty('--c', c);
          b.setAttribute('aria-label', `${row.dataset.for} ${name}`);
          b.addEventListener('click', () => { state[row.dataset.for] = c; render(); });
          row.appendChild(b);
        });
      });
    }

    function load(preset, warp, weft) {
      const fn = preset === 'clear' ? () => false : (DRAFTS[preset] || DRAFTS.plain);
      fromFn(preset === 'damaskStripe' ? DRAFTS.satin : fn);
      state.preset = preset === 'damaskStripe' ? 'satin' : preset;
      if (warp) state.warp = warp;
      if (weft) state.weft = weft;
      render();
    }

    function init() {
      buildGrid(); buildDyes();
      $('#presets').addEventListener('click', e => { const b = e.target.closest('button'); if (b) load(b.dataset.preset); });
      $('#zoom').addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        state.zoom = +b.dataset.z;
        $$('#zoom button').forEach(z => z.setAttribute('aria-pressed', String(z === b)));
        render();
      });
      $('#lab-send').addEventListener('click', () => {
        const dyeName = c => (DYES.find(d => d[1].toLowerCase() === c.toLowerCase()) || [c])[0];
        Indent.prefill('custom', `Weave Lab draft ${code()} (8×8), warp ${dyeName(state.warp)}, weft ${dyeName(state.weft)}. `);
      });
      load('twill22');
    }

    return { init, load, render };
  })();

  /* ------------------------------------------------------------------
     Journey: thread + needle drawn by scroll
     ------------------------------------------------------------------ */
  const Journey = (() => {
    const track = $('#journey-track'), svg = $('#journey-svg');
    const line = $('#journey-line'), ghost = $('#journey-ghost'), needle = $('#needle');
    const stages = $$('.stage');
    let len = 0, knotsY = [], ready = false;

    function build() {
      const w = track.clientWidth, h = track.clientHeight;
      const narrow = innerWidth <= 900;
      const cx = narrow ? 22 : w / 2;
      const amp = narrow ? 12 : 46;
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      knotsY = stages.map(st => st.offsetTop + 21);
      const pts = [0, ...knotsY, h];
      let d = `M${cx} 0`;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], dy = b - a, sg = i % 2 ? 1 : -1;
        d += ` C${cx + amp * sg} ${a + dy / 3} ${cx + amp * sg} ${a + dy * 2 / 3} ${cx} ${b}`;
      }
      line.setAttribute('d', d); ghost.setAttribute('d', d);
      len = line.getTotalLength();
      ready = true;
    }

    function update() {
      if (!ready) return;
      const r = track.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (innerHeight * 0.62 - r.top) / r.height));
      line.style.strokeDashoffset = String(1 - p);
      const at = Math.max(0.5, p * len);
      const pt = line.getPointAtLength(at);
      const ahead = line.getPointAtLength(Math.min(len, at + 4));
      const back = line.getPointAtLength(Math.max(0, at - 4));
      const ang = Math.atan2(ahead.y - back.y, ahead.x - back.x) * 180 / Math.PI;
      needle.style.transform = `translate(${pt.x}px, ${pt.y}px) rotate(${ang}deg)`;
      needle.style.opacity = p > 0 && p < 1 ? '1' : '0.0';
      const reachY = pt.y;
      stages.forEach((st, i) => st.classList.toggle('is-passed', reachY >= knotsY[i] - 2));
    }

    return { build, update };
  })();

  /* ------------------------------------------------------------------
     Indent slip
     ------------------------------------------------------------------ */
  const Indent = (() => {
    const form = $('#slip'), sel = $('#slip-fabric'), notes = $('#slip-notes');
    const err = $('#slip-err'), stamp = $('#stamp');

    function init() {
      swatches.forEach(sw => sel.add(new Option(`${sw.code}: ${sw.name}`, sw.code)));
      sel.add(new Option('Custom construction / other', 'custom'));
      const d = new Date();
      $('#slip-date').textContent = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      $('#slip-no').textContent = `DF/${String(d.getFullYear()).slice(2)}/${String(1000 + Math.floor(Math.random() * 9000))}`;
      $('#year').textContent = d.getFullYear();

      form.addEventListener('submit', e => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(form));
        const bad = ['name', 'phone', 'fabric'].filter(k => !String(f[k] || '').trim());
        $$('.is-bad', form).forEach(el => el.classList.remove('is-bad'));
        bad.forEach(k => form.elements[k].classList.add('is-bad'));
        if (bad.length) { err.textContent = 'Please fill in your name, phone and the fabric.'; form.elements[bad[0]].focus(); return; }
        err.textContent = '';

        const fabric = sel.options[sel.selectedIndex].text;
        const lines = [
          `INDENT ${$('#slip-no').textContent} · ${$('#slip-date').textContent}`,
          `Name: ${f.name}`,
          f.firm && `Firm: ${f.firm}`,
          `Phone: ${f.phone}`,
          f.city && `City: ${f.city}`,
          `Fabric: ${fabric}`,
          f.qty && `Quantity: ${f.qty} ${f.unit}`,
          f.notes && `Notes: ${f.notes}`,
        ].filter(Boolean).join('\n');

        stamp.classList.remove('is-on'); void stamp.offsetWidth; stamp.classList.add('is-on');
        const url = `https://wa.me/${DF.whatsapp}?text=${encodeURIComponent(lines)}`;
        setTimeout(() => window.open(url, '_blank', 'noopener'), 450);
      });
    }

    function prefill(code, note) {
      sel.value = code;
      if (note) notes.value = note + notes.value.replace(/^Weave Lab draft [^.]*\.\s*/, '');
      $('#indent').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
      setTimeout(() => form.elements.name.focus({ preventScroll: true }), 700);
    }

    return { init, prefill };
  })();

  /* ------------------------------------------------------------------
     Wiring
     ------------------------------------------------------------------ */
  // swatch actions
  $('.book').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const sw = swatches.find(s => s.el.contains(b));
    if (b.dataset.act === 'ask') Indent.prefill(sw.code);
    else {
      Lab.load(sw.draft, sw.warp[0], sw.weft[0]);
      $('#weave-lab').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  });

  /* ------------------------------------------------------------------
     Swing tags: damped springs, kicked by scrolling and passing pointers
     ------------------------------------------------------------------ */
  const Tags = (() => {
    const els = $$('.hang');
    const st = els.map((el, i) => ({ el, th: 0, w: 0, k: 0.016 + i * 0.0045, c: 0.055 }));
    const stampEl = $('.hstamp');
    const spy = [['swatches', 0], ['weave-lab', 1], ['journey', 2], ['karur', 3], ['indent', -1]]
      .map(([id, i]) => [document.getElementById(id), i]);
    let raf = 0, lastY = scrollY, pvx = 0;

    function step() {
      raf = 0;
      let energy = 0;
      st.forEach(s => {
        s.w += -s.k * s.th - s.c * s.w;
        s.th += s.w;
        energy += Math.abs(s.th) + Math.abs(s.w);
        s.el.style.setProperty('--sw', s.th.toFixed(2) + 'deg');
      });
      if (energy > 0.03) raf = requestAnimationFrame(step);
      else st.forEach(s => { s.th = s.w = 0; s.el.style.setProperty('--sw', '0deg'); });
    }
    function kick(i, f) {
      if (reduceMotion) return;
      st[i].w = Math.max(-5, Math.min(5, st[i].w + f));
      if (!raf) raf = requestAnimationFrame(step);
    }

    $('#rail').addEventListener('pointermove', e => { pvx = e.movementX || pvx; });
    els.forEach((el, i) => {
      el.addEventListener('pointerenter', () => kick(i, Math.max(-3.5, Math.min(3.5, (pvx || (i % 2 ? 1 : -1)) * 0.35))));
      el.addEventListener('click', () => kick(i, 4));
    });

    function onScroll() {
      const dv = scrollY - lastY; lastY = scrollY;
      if (Math.abs(dv) > 1) st.forEach((s, i) => kick(i, dv * 0.012 * (1 + i * 0.18)));
      // scroll-spy: which section crosses the 40% line
      const line = innerHeight * 0.4;
      let cur = null;
      spy.forEach(([sec, i]) => { const r = sec.getBoundingClientRect(); if (r.top <= line && r.bottom > line) cur = i; });
      els.forEach((el, i) => el.setAttribute('aria-current', String(i === cur)));
      stampEl.classList.toggle('is-current', cur === -1);
    }
    return { onScroll };
  })();

  /* ------------------------------------------------------------------
     Mobile: spool button unrolls a length of woven indigo cloth
     ------------------------------------------------------------------ */
  const menuBtn = $('#menu-btn'), drawer = $('#drawer'), drawerCloth = $('#drawer-cloth');
  const drawerL = { up: DRAFTS.twill31, warp: () => '#1B2550', weft: y => (mod(y, 24) < 2 ? '#7E2F24' : '#2B3A70') };
  function setDrawer(open) {
    drawer.classList.toggle('is-open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    menuBtn.setAttribute('aria-expanded', String(open));
    $('.spool__txt', menuBtn).textContent = open ? 'Close' : 'Menu';
    if (open && (fitCanvas(drawerCloth) || !drawerCloth.dataset.painted)) {
      paintCloth(drawerCloth, drawerL, Math.max(2, Math.round(3.5 * dpr())));
      drawerCloth.dataset.painted = '1';
    }
  }
  menuBtn.addEventListener('click', () => setDrawer(!drawer.classList.contains('is-open')));
  drawer.addEventListener('click', e => { if (e.target.closest('a')) setDrawer(false); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && drawer.classList.contains('is-open')) { setDrawer(false); menuBtn.focus(); } });

  /* ------------------------------------------------------------------
     Footer bale: coarse jute woven on canvas, frayed at the top edge
     ------------------------------------------------------------------ */
  const Jute = (() => {
    const c = $('#bale-jute');
    const SHADES = ['#C9AB7A', '#C1A271', '#CFB283', '#BB9B69', '#C6A776'];
    const h5 = n => (Math.imul(n | 0, 2654435761) >>> 0) % 5;
    const L = {
      up: (x, y) => mod(x + y, 2) === 0,
      warp: x => SHADES[h5(x * 7 + 3)],
      weft: y => SHADES[h5(y * 13 + 11)],
    };
    function paint() {
      if (!fitCanvas(c) && c.dataset.painted) return;
      c.dataset.painted = '1';
      const d = dpr(), s = Math.max(3, Math.round(6 * d)), fray = Math.round(22 * d);
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
      const cols = Math.ceil(c.width / s), rows = Math.ceil((c.height - fray) / s);
      // loose warp ends hanging above the cut
      for (let x = 0; x < cols; x++) {
        const len = 4 * d + ((Math.imul(x + 17, 2246822519) >>> 0) % 1000) / 1000 * (fray - 4 * d);
        ctx.fillStyle = pal(L.warp(x), 0).base;
        ctx.fillRect(x * s + s * 0.25, fray - len, Math.max(1, s * 0.5), len + 1);
      }
      ctx.save();
      ctx.translate(0, fray);
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) paintCell(ctx, x, y, s, L);
      ctx.restore();
      // soften the weave so stencilled text stays readable
      ctx.fillStyle = 'rgba(206,180,132,.38)';
      ctx.fillRect(0, fray, c.width, c.height);
      // the bale's curvature: darker toward the edges and bottom
      const gx = ctx.createLinearGradient(0, 0, c.width, 0);
      gx.addColorStop(0, 'rgba(40,25,5,.32)'); gx.addColorStop(.12, 'rgba(40,25,5,0)');
      gx.addColorStop(.88, 'rgba(40,25,5,0)'); gx.addColorStop(1, 'rgba(40,25,5,.32)');
      ctx.fillStyle = gx; ctx.fillRect(0, fray, c.width, c.height);
      const gy = ctx.createLinearGradient(0, fray, 0, c.height);
      gy.addColorStop(0, 'rgba(255,240,200,.12)'); gy.addColorStop(.5, 'rgba(0,0,0,0)'); gy.addColorStop(1, 'rgba(40,25,5,.3)');
      ctx.fillStyle = gy; ctx.fillRect(0, fray, c.width, c.height);
    }
    return { paint };
  })();

  // rise-in
  const riseTargets = $$('.sec-head, .swatch, .lab__grid, .stage, .karur__copy, .ledger, .slip, .hero__copy');
  riseTargets.forEach(el => el.setAttribute('data-rise', ''));
  const rio = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('is-in'); rio.unobserve(e.target); }
  }), { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  riseTargets.forEach(el => rio.observe(el));

  // scroll-linked bits
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      Journey.update();
      Tags.onScroll();
    });
  }

  let rz = 0;
  function onResize() {
    clearTimeout(rz);
    rz = setTimeout(() => {
      Loom.resize();
      paintSwatches(false);
      Lab.render();
      Journey.build(); Journey.update();
      Jute.paint();
      if (innerWidth > 1000 && drawer.classList.contains('is-open')) setDrawer(false);
     
      onScroll();
    }, 150);
  }

  Loom.init();
  Lab.init();
  Indent.init();
  paintSwatches(true);
  Journey.build();
  Jute.paint();
  document.fonts?.ready.then(() => { Jute.paint(); Journey.build(); onScroll(); });
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onResize);
  addEventListener('load', () => { Journey.build(); onScroll(); });
  onScroll();
})();
