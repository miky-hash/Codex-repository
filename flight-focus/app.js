(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const AIRPORTS = window.AIRPORTS || [];
  const AP = Object.fromEntries(AIRPORTS.map((a) => [a.code, a]));
  const HAS_GEO = !!(window.d3 && d3.geoOrthographic && window.WORLD_LAND);
  const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const BASE_TITLE = document.title;
  const VIEWS = ['book', 'pass', 'flight', 'arrive', 'log'];

  // ---------- 저장소 (막혀 있어도 앱은 동작) ----------
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('focusair.' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem('focusair.' + key, JSON.stringify(value)); } catch (e) { /* 무시 */ } },
    del(key) { try { localStorage.removeItem('focusair.' + key); } catch (e) { /* 무시 */ } },
  };

  // ---------- 계산 도우미 ----------
  const toRad = (d) => d * Math.PI / 180;
  const toDeg = (r) => r * 180 / Math.PI;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function distanceKm(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // 순항 780km/h + 이착륙 20분, 5분 단위로 반올림
  function flightMinutes(km) {
    return Math.max(30, Math.round((km / 780 * 60 + 20) / 5) * 5);
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    let s = seed || 1;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }

  const pad = (n) => String(n).padStart(2, '0');
  const fmtKm = (km) => Math.round(km).toLocaleString('ko-KR') + 'km';
  function fmtDur(min) {
    min = Math.round(min);
    const h = Math.floor(min / 60), m = min % 60;
    if (!h) return m + '분';
    return m ? `${h}시간 ${m}분` : `${h}시간`;
  }
  function fmtClock(sec) {
    sec = Math.max(0, Math.ceil(sec));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }
  const fmtHM = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtDate = (t) => { const d = new Date(t); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 받침에 따라 '로' / '으로'
  function euro(word) {
    const code = word.charCodeAt(word.length - 1) - 0xAC00;
    if (code < 0 || code > 11171) return '(으)로';
    const jong = code % 28;
    return jong === 0 || jong === 8 ? '로' : '으로';
  }

  // 선회 비행: 공항 중심 반지름 1.2도 원을 25분에 한 바퀴
  const CIRCUIT_DEG = 1.2;
  const circuitLaps = (min) => Math.max(1, Math.round(min / 25));
  const circuitKm = (min) => Math.round(2 * Math.PI * 6371 * Math.sin(toRad(CIRCUIT_DEG)) * circuitLaps(min));

  function offsetPoint(lon, lat, bearingDeg, distDeg) {
    const p1 = toRad(lat), l1 = toRad(lon), th = toRad(bearingDeg), dl = toRad(distDeg);
    const p2 = Math.asin(Math.sin(p1) * Math.cos(dl) + Math.cos(p1) * Math.sin(dl) * Math.cos(th));
    const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(dl) * Math.cos(p1), Math.cos(dl) - Math.sin(p1) * Math.sin(p2));
    return [toDeg(l2), toDeg(p2)];
  }
  function circleLine(a, frac) {
    const n = Math.max(2, Math.round(96 * frac));
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(offsetPoint(a.lon, a.lat, 360 * frac * i / n, CIRCUIT_DEG));
    return { type: 'LineString', coordinates: pts };
  }
  const lonlat = (a) => [a.lon, a.lat];

  function planeAt(f, p) {
    const a = AP[f.from];
    if (f.type === 'circuit') return offsetPoint(a.lon, a.lat, p * circuitLaps(f.minutes) * 360, CIRCUIT_DEG);
    return d3.geoInterpolate(lonlat(a), lonlat(AP[f.to]))(p);
  }

  // ---------- 지구본 (d3-geo 정사영 + canvas) ----------
  const PLANE = [[11, 0], [8, 1.3], [2, 1.5], [-3.5, 9], [-6, 9], [-2.5, 1.5], [-8, 1.3], [-10.5, 4.5], [-12.5, 4.5], [-11.2, 0],
    [-12.5, -4.5], [-10.5, -4.5], [-8, -1.3], [-2.5, -1.5], [-6, -9], [-3.5, -9], [2, -1.5], [8, -1.3]];

  function makeGlobe(canvas) {
    const ctx = canvas.getContext('2d');
    const proj = d3.geoOrthographic().clipAngle(90).precision(0.4);
    const path = d3.geoPath(proj, ctx);
    const grat = d3.geoGraticule10();
    const sphere = { type: 'Sphere' };
    const view = { center: [127, 37], zoom: 3 };
    let w = 1, h = 1, dpr = 1, anim = 0, scene = null;

    function resize() {
      const r = canvas.getBoundingClientRect();
      w = Math.max(1, r.width); h = Math.max(1, r.height);
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const baseR = () => Math.min(w, h) * 0.46;
    // 중심에서 extent(라디안)만큼 떨어진 지점이 화면 안쪽에 들어오도록 확대
    function zoomFor(extent) {
      const e = clamp(extent, 0.004, Math.PI / 2);
      return clamp((Math.min(w, h) * 0.36) / (baseR() * Math.sin(e)), 1, 12);
    }
    function colors() {
      const cs = getComputedStyle(document.documentElement);
      const g = (n) => cs.getPropertyValue(n).trim();
      return { ocean: g('--ocean'), land: g('--land'), grat: g('--grat'), ink: g('--ink'), route: g('--route'),
        plane: g('--plane'), halo: g('--halo'), edge: g('--line'), font: g('--font-display') };
    }
    function front(ll) {
      if (d3.geoDistance(ll, view.center) > Math.PI / 2 - 0.02) return null;
      return proj(ll);
    }
    function draw() {
      if (!scene || w < 2) return;
      const c = colors();
      proj.translate([w / 2, h / 2]).scale(baseR() * view.zoom).rotate([-view.center[0], -view.center[1]]);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      ctx.beginPath(); path(sphere); ctx.fillStyle = c.ocean; ctx.fill();
      ctx.beginPath(); path(grat); ctx.strokeStyle = c.grat; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath(); path(window.WORLD_LAND); ctx.fillStyle = c.land; ctx.fill();
      ctx.beginPath(); path(sphere); ctx.strokeStyle = c.edge; ctx.lineWidth = 1; ctx.stroke();

      ctx.lineCap = 'round';
      if (scene.todo) {
        ctx.beginPath(); path(scene.todo);
        ctx.setLineDash([6, 6]); ctx.strokeStyle = c.route; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
      }
      if (scene.done) {
        ctx.beginPath(); path(scene.done);
        ctx.strokeStyle = c.route; ctx.lineWidth = 3.5; ctx.stroke();
      }

      ctx.font = `600 13px ${c.font}`;
      for (const m of scene.marks || []) {
        const pt = front(m.at);
        if (!pt) continue;
        ctx.beginPath(); ctx.arc(pt[0], pt[1], 4.5, 0, Math.PI * 2);
        ctx.fillStyle = c.halo; ctx.fill(); ctx.strokeStyle = c.ink; ctx.lineWidth = 2; ctx.stroke();
        ctx.lineWidth = 4; ctx.strokeStyle = c.halo; ctx.fillStyle = c.ink;
        ctx.strokeText(m.label, pt[0] + 8, pt[1] - 8); ctx.fillText(m.label, pt[0] + 8, pt[1] - 8);
      }

      if (scene.plane) {
        const pt = front(scene.plane);
        if (pt) {
          const q = scene.ahead ? proj(scene.ahead) : null;
          const ang = q ? Math.atan2(q[1] - pt[1], q[0] - pt[0]) : 0;
          ctx.save();
          ctx.translate(pt[0], pt[1]); ctx.rotate(ang); ctx.scale(1.3, 1.3);
          ctx.beginPath();
          PLANE.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.closePath();
          ctx.lineJoin = 'round'; ctx.lineWidth = 2.5; ctx.strokeStyle = c.halo; ctx.stroke();
          ctx.fillStyle = c.plane; ctx.fill();
          ctx.restore();
        }
      }
    }
    function set(next, animate) {
      scene = next;
      cancelAnimationFrame(anim);
      if (!animate || REDUCED || w < 2) {
        view.center = next.center.slice(); view.zoom = next.zoom; draw(); return;
      }
      const from = { center: view.center.slice(), zoom: view.zoom };
      const dLon = ((next.center[0] - from.center[0] + 540) % 360) - 180;
      const t0 = performance.now(), dur = 800;
      const step = (now) => {
        const t = Math.min(1, (now - t0) / dur);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        view.center = [from.center[0] + dLon * e, from.center[1] + (next.center[1] - from.center[1]) * e];
        view.zoom = Math.exp(Math.log(from.zoom) + (Math.log(next.zoom) - Math.log(from.zoom)) * e);
        draw();
        if (t < 1) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
    }
    return { resize, draw, set, zoomFor };
  }

  // ---------- 상태 ----------
  let log = store.get('log', []);
  if (!Array.isArray(log)) log = [];
  let loc = AP[store.get('loc', 'ICN')] ? store.get('loc', 'ICN') : 'ICN';
  let flight = store.get('flight', null);
  if (flight && (!AP[flight.from] || !AP[flight.to] || !(flight.endAt > flight.startAt))) { flight = null; store.del('flight'); }

  let depCode = loc;
  const sel = { type: 'route', to: null, minutes: 25 };
  let range = 'all';
  let query = '';
  let pending = null;
  let current = 'book';

  const planGlobe = HAS_GEO ? makeGlobe($('globe-plan')) : null;
  const flightGlobe = HAS_GEO ? makeGlobe($('globe-flight')) : null;
  if (!HAS_GEO) document.body.classList.add('no-geo');

  // ---------- 알림 토스트 ----------
  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  // ---------- 소리: 엔진 소음(브라운 노이즈) + 기내 차임 ----------
  let actx = null, noiseSrc = null, noiseGain = null;
  function ensureAudio() {
    try {
      if (!actx) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        actx = new C();
      }
      if (actx.state === 'suspended') actx.resume();
      return actx;
    } catch (e) { return null; }
  }
  function startNoise() {
    const c = ensureAudio();
    if (!c || noiseSrc) return false;
    const len = c.sampleRate * 8;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    // 루프 이음매가 튀지 않도록 앞뒤를 살짝 페이드
    const fade = Math.floor(c.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) { const k = i / fade; d[i] *= k; d[len - 1 - i] *= k; }
    noiseSrc = c.createBufferSource();
    noiseSrc.buffer = buf; noiseSrc.loop = true;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    noiseGain = c.createGain(); noiseGain.gain.value = 0;
    noiseSrc.connect(lp).connect(noiseGain).connect(c.destination);
    noiseSrc.start();
    noiseGain.gain.linearRampToValueAtTime(0.4, c.currentTime + 1.5);
    return true;
  }
  function stopNoise() {
    if (!noiseSrc) return;
    const src = noiseSrc;
    noiseGain.gain.setTargetAtTime(0, actx.currentTime, 0.25);
    setTimeout(() => { try { src.stop(); } catch (e) { /* 이미 멈춤 */ } }, 1200);
    noiseSrc = null;
    setNoiseBtn(false);
  }
  function setNoiseBtn(on) {
    $('btn-noise').setAttribute('aria-pressed', String(on));
    $('btn-noise').textContent = on ? '기내 소음 끄기' : '기내 소음 켜기';
  }
  function chime() {
    const c = ensureAudio();
    if (!c) return;
    [[784, 0], [587, 0.5]].forEach(([freq, at]) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      const t = c.currentTime + at;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.28, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
      o.connect(g).connect(c.destination);
      o.start(t); o.stop(t + 1.7);
    });
  }

  // ---------- 화면 켜두기 ----------
  let wakeLock = null, wakeWanted = false;
  async function requestWake() {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
      wakeLock = null;
      if (wakeWanted) { wakeWanted = false; toast('이 브라우저에서는 화면 켜두기를 쓸 수 없어요.'); }
    }
    $('btn-wake').setAttribute('aria-pressed', String(wakeWanted));
  }
  function releaseWake() {
    wakeWanted = false;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    $('btn-wake').setAttribute('aria-pressed', 'false');
  }
  if (!('wakeLock' in navigator)) $('btn-wake').hidden = true;

  // ---------- 화면 전환 ----------
  function show(view) {
    current = view;
    VIEWS.forEach((v) => { $('view-' + v).hidden = v !== view; });
    if (view === 'log') { $('nav-log').setAttribute('aria-current', 'page'); $('nav-book').removeAttribute('aria-current'); }
    else { $('nav-book').setAttribute('aria-current', 'page'); $('nav-log').removeAttribute('aria-current'); }

    if (view === 'book') {
      renderPlanner();
      if (planGlobe) { planGlobe.resize(); planGlobe.set(planScene(), false); }
    }
    if (view === 'flight') {
      renderFlightStatic();
      if (flightGlobe) flightGlobe.resize();
      tick();
      startLoop();
    }
    if (view === 'log') renderLog();
    window.scrollTo(0, 0);
  }
  function updateNav() {
    $('nav-book').textContent = flight ? '비행 중' : '비행 예약';
    $('loc-code').textContent = loc;
  }

  // ---------- 1. 예약 ----------
  function fillDepartures() {
    const groups = {};
    AIRPORTS.forEach((a) => { (groups[a.region] = groups[a.region] || []).push(a); });
    $('dep').innerHTML = Object.entries(groups).map(([region, list]) =>
      `<optgroup label="${esc(region)}">${list.map((a) => `<option value="${a.code}">${a.code} · ${esc(a.city)}</option>`).join('')}</optgroup>`
    ).join('');
    $('dep').value = depCode;
  }

  function destinations() {
    const d = AP[depCode];
    return AIRPORTS
      .filter((a) => a.code !== depCode)
      .map((a) => { const km = distanceKm(d, a); return { a, km, min: flightMinutes(km) }; })
      .filter((x) => x.km >= 100) // 인천–김포처럼 너무 가까운 구간은 제외
      .sort((x, y) => x.min - y.min || x.km - y.km);
  }
  function inRange(min) {
    switch (range) {
      case 'short': return min <= 60;
      case 'mid': return min > 60 && min <= 180;
      case 'long': return min > 180 && min <= 360;
      case 'ultra': return min > 360;
      default: return true;
    }
  }
  function pickDefault() {
    const ds = destinations();
    let best = ds[0] || null;
    ds.forEach((x) => { if (Math.abs(x.min - 60) < Math.abs(best.min - 60)) best = x; });
    sel.to = best ? best.a.code : null;
  }

  function renderDestList() {
    const q = query.trim().toLowerCase();
    const items = destinations().filter((x) => inRange(x.min) && (!q
      || x.a.code.toLowerCase().includes(q) || x.a.city.toLowerCase().includes(q) || x.a.country.includes(q)));
    $('dest-list').innerHTML = items.length ? items.map((x) => `
      <li><button type="button" class="dest" data-code="${x.a.code}" aria-pressed="${sel.to === x.a.code}">
        <span class="dest-code">${x.a.code}</span>
        <span class="dest-city">${esc(x.a.city)}<small>${esc(x.a.country)}</small></span>
        <span class="dest-time">${fmtDur(x.min)}<small>${fmtKm(x.km)}</small></span>
      </button></li>`).join('')
      : '<li class="empty">조건에 맞는 공항이 없어요. 검색어나 시간 필터를 바꿔 보세요.</li>';
  }

  function renderSummary() {
    const dep = AP[depCode];
    let text = '목적지를 골라 주세요.';
    let ok = false;
    if (sel.type === 'circuit') {
      text = `${dep.code} 상공 선회 · ${circuitLaps(sel.minutes)}바퀴 · ${fmtDur(sel.minutes)}`;
      ok = true;
    } else if (sel.to && AP[sel.to]) {
      const km = distanceKm(dep, AP[sel.to]);
      text = `${dep.code} → ${sel.to} · ${fmtDur(flightMinutes(km))} · ${fmtKm(km)}`;
      ok = true;
    }
    $('sel-summary').textContent = text;
    $('btn-ticket').disabled = !ok;
    $('plan-caption').textContent = ok ? text : `${dep.code} ${dep.city}`;
  }

  function renderPlanner() {
    $('dep').value = depCode;
    $('mode-route').setAttribute('aria-pressed', String(sel.type === 'route'));
    $('mode-circuit').setAttribute('aria-pressed', String(sel.type === 'circuit'));
    $('route-panel').hidden = sel.type !== 'route';
    $('circuit-panel').hidden = sel.type !== 'circuit';
    document.querySelectorAll('#route-panel .chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
    document.querySelectorAll('#circuit-panel .chip').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.min) === sel.minutes)));
    $('circuit-min').value = sel.minutes;
    $('circuit-out').textContent = fmtDur(sel.minutes);
    renderDestList();
    renderSummary();
  }

  function planScene() {
    const dep = AP[depCode];
    const D = lonlat(dep);
    const marks = [{ at: D, label: dep.code }];
    if (sel.type === 'circuit') {
      return { center: D, zoom: planGlobe.zoomFor(toRad(CIRCUIT_DEG) * 1.6), todo: circleLine(dep, 1), marks,
        plane: offsetPoint(dep.lon, dep.lat, 0, CIRCUIT_DEG), ahead: offsetPoint(dep.lon, dep.lat, 4, CIRCUIT_DEG) };
    }
    if (sel.to && AP[sel.to]) {
      const a = AP[sel.to];
      const A = lonlat(a);
      marks.push({ at: A, label: a.code });
      return { center: d3.geoInterpolate(D, A)(0.5), zoom: planGlobe.zoomFor(d3.geoDistance(D, A) / 2),
        todo: { type: 'LineString', coordinates: [D, A] }, marks };
    }
    return { center: D, zoom: 4, marks };
  }
  function refreshPlan(animate) {
    renderPlanner();
    if (planGlobe && current === 'book') planGlobe.set(planScene(), animate);
  }

  $('dep').addEventListener('change', (e) => {
    depCode = e.target.value;
    if (sel.to === depCode || !destinations().some((x) => x.a.code === sel.to)) pickDefault();
    refreshPlan(true);
  });
  $('mode-route').addEventListener('click', () => { sel.type = 'route'; refreshPlan(true); });
  $('mode-circuit').addEventListener('click', () => { sel.type = 'circuit'; refreshPlan(true); });
  $('q').addEventListener('input', (e) => { query = e.target.value; renderDestList(); });
  document.querySelectorAll('#route-panel .chip').forEach((b) => b.addEventListener('click', () => {
    range = b.dataset.range; renderPlanner();
  }));
  document.querySelectorAll('#circuit-panel .chip').forEach((b) => b.addEventListener('click', () => {
    sel.minutes = Number(b.dataset.min); refreshPlan(false);
  }));
  $('circuit-min').addEventListener('input', (e) => { sel.minutes = Number(e.target.value); refreshPlan(false); });
  $('dest-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.dest');
    if (!btn) return;
    sel.to = btn.dataset.code;
    const top = $('dest-list').scrollTop;
    refreshPlan(true);
    $('dest-list').scrollTop = top;
    const again = $('dest-list').querySelector(`[data-code="${sel.to}"]`);
    if (again) again.focus({ preventScroll: true });
  });

  // ---------- 2. 탑승권 ----------
  function buildFlight() {
    const dep = AP[depCode];
    const circuit = sel.type === 'circuit';
    const to = circuit ? depCode : sel.to;
    const minutes = circuit ? sel.minutes : flightMinutes(distanceKm(dep, AP[to]));
    const km = circuit ? circuitKm(minutes) : Math.round(distanceKm(dep, AP[to]));
    const h = hash(depCode + to + Date.now());
    return {
      type: circuit ? 'circuit' : 'route',
      from: depCode, to, minutes, km,
      flightNo: 'FA ' + (circuit ? 700 + (h % 100) : 100 + (h % 600)),
      gate: 'ABCDE'[h % 5] + (1 + ((h >>> 5) % 40)),
      seat: null, task: '', turbulence: 0,
    };
  }

  function renderSeatmap() {
    const r = rng(hash(pending.flightNo + pending.from));
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    const cells = ['<span></span>'];
    letters.forEach((l, i) => { if (i === 3) cells.push('<span></span>'); cells.push(`<span class="hdr">${l}</span>`); });
    let firstWindow = null;
    for (let row = 21; row <= 27; row++) {
      cells.push(`<span class="row-no">${row}</span>`);
      letters.forEach((l, i) => {
        if (i === 3) cells.push('<span></span>');
        const id = row + l;
        const taken = r() < 0.42;
        if (!taken && !firstWindow && (l === 'A' || l === 'F')) firstWindow = id;
        cells.push(`<button type="button" class="seat" data-seat="${id}" aria-label="${id} 좌석" ${taken ? 'disabled' : ''} aria-pressed="false">${l}</button>`);
      });
    }
    $('seatmap').innerHTML = cells.join('');
    selectSeat(firstWindow || $('seatmap').querySelector('.seat:not(:disabled)').dataset.seat);
  }
  function selectSeat(id) {
    pending.seat = id;
    $('seatmap').querySelectorAll('.seat').forEach((s) => s.setAttribute('aria-pressed', String(s.dataset.seat === id)));
    $('p-seat').textContent = id;
  }
  $('seatmap').addEventListener('click', (e) => {
    const s = e.target.closest('.seat');
    if (s && !s.disabled) selectSeat(s.dataset.seat);
  });

  function renderPass() {
    const f = pending;
    const a = AP[f.from], b = AP[f.to];
    const now = Date.now();
    $('p-flight').textContent = f.flightNo;
    $('p-from').textContent = a.code; $('p-from-city').textContent = a.city;
    $('p-to').textContent = b.code;
    $('p-to-city').textContent = f.type === 'circuit' ? `${circuitLaps(f.minutes)}바퀴 선회 후 귀환` : b.city;
    $('p-dur').textContent = fmtDur(f.minutes);
    $('p-dep-time').textContent = fmtHM(now);
    $('p-arr-time').textContent = fmtHM(now + f.minutes * 60000);
    $('p-gate').textContent = f.gate;
    $('p-km').textContent = fmtKm(f.km);
    const r = rng(hash(f.flightNo + f.to));
    let bars = '';
    for (let i = 0; i < 46; i++) bars += `<span style="width:${1 + Math.floor(r() * 3)}px"></span>`;
    $('barcode').innerHTML = bars;
    renderSeatmap();
  }

  $('btn-ticket').addEventListener('click', () => {
    if ($('btn-ticket').disabled) return;
    pending = buildFlight();
    renderPass();
    show('pass');
  });
  $('btn-back').addEventListener('click', () => { pending = null; show('book'); });
  $('btn-board').addEventListener('click', () => {
    if (!pending) return;
    ensureAudio(); // 사용자 클릭 시점에 오디오 잠금 해제
    const f = pending;
    f.task = $('task').value.trim().slice(0, 40);
    f.startAt = Date.now();
    f.endAt = f.startAt + f.minutes * 60000;
    f.turbulence = 0;
    flight = f; pending = null;
    store.set('flight', flight);
    $('task').value = '';
    stopBreak();
    updateNav();
    show('flight');
    toast(`${f.flightNo}편 이륙합니다. 좋은 비행 되세요.`);
  });

  // ---------- 3. 비행 중 ----------
  function progressOf(f, now) { return clamp((now - f.startAt) / (f.endAt - f.startAt), 0, 1); }

  function telemetry(f, p, now) {
    const circuit = f.type === 'circuit';
    const cruiseAlt = circuit ? 8000 : f.minutes <= 60 ? 24000 : f.minutes <= 180 ? 33000 : 37000;
    const cruiseSpd = circuit ? 320 : 860;
    const climb = Math.min(0.2, 18 / f.minutes);
    const descent = Math.min(0.2, 22 / f.minutes);
    let alt, spd, phase;
    if (p < climb) {
      const t = p / climb;
      alt = cruiseAlt * Math.sin(t * Math.PI / 2);
      spd = 290 + (cruiseSpd - 290) * t;
      phase = t < 0.2 ? '이륙' : '상승';
    } else if (p > 1 - descent) {
      const t = (1 - p) / descent;
      alt = cruiseAlt * t;
      spd = 260 + (cruiseSpd - 260) * t;
      phase = t < 0.3 ? '착륙 접근' : '하강';
    } else {
      alt = cruiseAlt;
      spd = cruiseSpd + 12 * Math.sin(now / 40000);
      phase = circuit ? '선회 중' : '순항';
    }
    return { alt: Math.round(alt / 100) * 100, spd: Math.round(Math.min(spd, cruiseSpd + 20)), phase };
  }

  function renderFlightStatic() {
    const f = flight;
    if (!f) return;
    $('f-flight').textContent = f.flightNo;
    $('f-route').textContent = f.type === 'circuit' ? `${f.from} 상공 선회` : `${f.from} → ${f.to}`;
    $('f-task').innerHTML = f.task ? `집중할 일 · <b>${esc(f.task)}</b>` : '집중할 일을 정하지 않은 비행이에요.';
    $('f-from').textContent = f.from;
    $('f-to').textContent = f.to;
    $('f-eta').textContent = fmtHM(f.endAt);
    $('f-seat').textContent = f.seat || '--';
    $('abort-confirm').hidden = true;
    $('btn-abort').hidden = false;
  }

  function flightScene(f, p) {
    const a = AP[f.from], b = AP[f.to];
    const pos = planeAt(f, p);
    const ahead = planeAt(f, p + (f.type === 'circuit' ? 0.002 / circuitLaps(f.minutes) : 0.002));
    const marks = [{ at: lonlat(a), label: a.code }];
    if (f.type === 'circuit') {
      const lap = (p * circuitLaps(f.minutes)) % 1;
      return { center: lonlat(a), zoom: flightGlobe.zoomFor(toRad(CIRCUIT_DEG) * 1.6), marks,
        todo: circleLine(a, 1), done: circleLine(a, Math.max(lap, 0.001)), plane: pos, ahead };
    }
    marks.push({ at: lonlat(b), label: b.code });
    return { center: pos, zoom: flightGlobe.zoomFor(d3.geoDistance(lonlat(a), lonlat(b))), marks,
      todo: { type: 'LineString', coordinates: [pos, lonlat(b)] },
      done: { type: 'LineString', coordinates: [lonlat(a), pos] }, plane: pos, ahead };
  }

  let lastTitle = '';
  function tick() {
    const f = flight;
    if (!f) return;
    const now = Date.now();
    const p = progressOf(f, now);
    if (p >= 1) { land(false); return; }
    const remainSec = (f.endAt - now) / 1000;
    const clock = fmtClock(remainSec);
    const tm = telemetry(f, p, now);
    $('f-remain').textContent = clock;
    $('f-bar').style.width = (p * 100).toFixed(2) + '%';
    $('f-phase').textContent = tm.phase;
    $('t-alt').textContent = tm.alt.toLocaleString('ko-KR') + ' ft';
    $('t-spd').textContent = tm.spd.toLocaleString('ko-KR') + ' km/h';
    $('t-dist').textContent = Math.round(f.km * (1 - p)).toLocaleString('ko-KR') + ' km';
    $('t-turb').textContent = f.turbulence + '회';
    const title = `${clock} · ${f.type === 'circuit' ? f.from + ' 선회' : f.from + '→' + f.to}`;
    if (title !== lastTitle) { document.title = title; lastTitle = title; }
    if (flightGlobe && current === 'flight' && !document.hidden) flightGlobe.set(flightScene(f, p), false);
  }

  let rafId = 0, lastFrame = 0;
  function loop(now) {
    rafId = 0;
    if (!flight || current !== 'flight') return;
    if (now - lastFrame > 150) { lastFrame = now; tick(); }
    if (flight && current === 'flight') rafId = requestAnimationFrame(loop);
  }
  function startLoop() { if (!rafId) rafId = requestAnimationFrame(loop); }
  // 다른 화면에 있거나 탭이 백그라운드여도 도착은 확인
  setInterval(() => { if (flight) tick(); }, 1000);

  $('btn-noise').addEventListener('click', () => {
    if (noiseSrc) { stopNoise(); return; }
    if (startNoise()) setNoiseBtn(true);
    else toast('이 브라우저에서는 소리를 낼 수 없어요.');
  });
  $('btn-wake').addEventListener('click', () => {
    if (wakeWanted) { releaseWake(); return; }
    wakeWanted = true;
    requestWake();
  });
  $('btn-abort').addEventListener('click', () => {
    if (!flight) return;
    const min = Math.floor((Date.now() - flight.startAt) / 60000);
    $('abort-text').textContent = min >= 1
      ? `정말 비상 착륙할까요? 지금까지 집중한 ${fmtDur(min)}은 '회항'으로 로그북에 남아요.`
      : '정말 비상 착륙할까요? 1분이 지나지 않아 기록은 남지 않아요.';
    $('abort-confirm').hidden = false;
    $('btn-abort').hidden = true;
  });
  $('abort-cancel').addEventListener('click', () => { $('abort-confirm').hidden = true; $('btn-abort').hidden = false; });
  $('abort-ok').addEventListener('click', () => land(true));

  // 비행 중 3초 넘게 화면을 떠났다가 돌아오면 난기류 1회
  // (돌아왔을 때 세므로 새로고침이나 창 닫기는 세지 않음)
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (!flight) return;
    if (document.hidden) { hiddenAt = Date.now(); return; }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    tick();
    if (!flight) return;
    if (away > 3000) {
      flight.turbulence += 1;
      store.set('flight', flight);
      tick();
      toast(`난기류를 지났어요. 다시 집중해요. (총 ${flight.turbulence}회)`);
    }
    if (wakeWanted && !wakeLock) requestWake();
  });

  // ---------- 4. 도착 ----------
  function land(diverted) {
    const f = flight;
    if (!f) return;
    const now = Math.min(Date.now(), f.endAt);
    const focusedMin = Math.round((now - f.startAt) / 60000);
    flight = null;
    store.del('flight');
    stopNoise();
    releaseWake();
    document.title = BASE_TITLE; lastTitle = '';
    updateNav();

    if (diverted && focusedMin < 1) {
      toast('비행을 취소했어요. 기록은 남지 않았어요.');
      show('book');
      return;
    }
    const entry = {
      id: f.startAt, date: f.startAt, flightNo: f.flightNo, type: f.type,
      from: f.from, to: diverted ? f.from : f.to, plannedTo: f.to,
      minutes: f.minutes, focusedMin,
      km: Math.round(f.km * progressOf(f, now)),
      task: f.task, seat: f.seat, turbulence: f.turbulence,
      status: diverted ? 'diverted' : 'arrived',
    };
    log.unshift(entry);
    store.set('log', log);
    if (!diverted) { loc = f.to; store.set('loc', loc); depCode = loc; pickDefault(); }
    updateNav();
    if (!diverted) chime();
    renderArrival(entry);
    show('arrive');
  }

  function renderArrival(e) {
    const dest = AP[e.to];
    const stamp = $('a-stamp');
    stamp.classList.toggle('is-diverted', e.status === 'diverted');
    // 애니메이션 다시 재생
    stamp.style.animation = 'none'; void stamp.offsetWidth; stamp.style.animation = '';
    $('a-stamp-top').textContent = e.status === 'diverted' ? 'RETURNED' : 'ARRIVED';
    $('a-stamp-code').textContent = dest.code;
    $('a-stamp-date').textContent = fmtDate(e.date);
    if (e.status === 'diverted') {
      $('a-title').textContent = `${dest.city}${euro(dest.city)} 회항했어요`;
      $('a-sub').textContent = '괜찮아요. 집중한 만큼은 로그북에 남았어요. 조금 쉬고 다시 떠나 봐요.';
    } else if (e.type === 'circuit') {
      $('a-title').textContent = `${dest.city} 상공 선회를 마쳤어요`;
      $('a-sub').textContent = e.task ? `“${e.task}” 비행을 끝까지 해냈어요.` : `${fmtDur(e.focusedMin)} 동안 집중했어요.`;
    } else {
      $('a-title').textContent = `${dest.city}에 도착했어요`;
      $('a-sub').textContent = e.task ? `“${e.task}” 비행을 끝까지 해냈어요.` : `${fmtDur(e.focusedMin)} 동안 집중했어요.`;
    }
    $('a-min').textContent = fmtDur(e.focusedMin);
    $('a-km').textContent = fmtKm(e.km);
    $('a-turb').textContent = e.turbulence + '회';
    $('break-clock').textContent = '--:--';
    $('break-msg').textContent = '다음 비행 전에 물 한 잔 마시고 스트레칭해요.';
    document.querySelectorAll('[data-break]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  }

  let breakTimer = 0, breakEnd = 0;
  function stopBreak() { clearInterval(breakTimer); breakTimer = 0; }
  function tickBreak() {
    const s = (breakEnd - Date.now()) / 1000;
    if (s <= 0) {
      stopBreak();
      $('break-clock').textContent = '00:00';
      $('break-msg').textContent = '환승 완료! 다음 비행을 예약해 보세요.';
      chime();
      return;
    }
    $('break-clock').textContent = fmtClock(s);
  }
  document.querySelectorAll('[data-break]').forEach((b) => b.addEventListener('click', () => {
    ensureAudio();
    document.querySelectorAll('[data-break]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    breakEnd = Date.now() + Number(b.dataset.break) * 60000;
    $('break-msg').textContent = '쉬는 중이에요. 화면에서 잠시 눈을 떼도 괜찮아요.';
    stopBreak();
    breakTimer = setInterval(tickBreak, 500);
    tickBreak();
  }));
  $('btn-next').addEventListener('click', () => show('book'));

  // ---------- 5. 로그북 ----------
  function renderLog() {
    const arrived = log.filter((e) => e.status === 'arrived');
    const totalMin = log.reduce((s, e) => s + (e.focusedMin || 0), 0);
    const totalKm = log.reduce((s, e) => s + (e.km || 0), 0);
    const airports = new Set();
    arrived.forEach((e) => { airports.add(e.from); airports.add(e.to); });
    $('s-flights').textContent = arrived.length.toLocaleString('ko-KR');
    $('s-time').textContent = fmtDur(totalMin);
    $('s-km').textContent = fmtKm(totalKm);
    $('s-airports').textContent = airports.size;

    $('log-body').innerHTML = log.length ? log.map((e) => {
      const route = e.type === 'circuit' ? `${e.from} 선회` : `${e.from} → ${e.plannedTo || e.to}`;
      const pill = e.status === 'arrived' ? '<span class="pill ok">도착</span>' : '<span class="pill bad">회항</span>';
      return `<tr>
        <td class="mono">${fmtDate(e.date)} ${fmtHM(e.date)}</td>
        <td class="mono">${esc(e.flightNo)}</td>
        <td class="route">${esc(route)}</td>
        <td class="task">${e.task ? esc(e.task) : '<span style="color:var(--muted)">—</span>'}</td>
        <td class="mono">${fmtDur(e.focusedMin)}</td>
        <td>${pill}</td>
      </tr>`;
    }).join('') : '<tr><td class="empty" colspan="6">아직 기록이 없어요. 첫 비행을 떠나 보세요.</td></tr>';
    $('btn-reset').hidden = !log.length;
    $('reset-confirm').hidden = true;
  }
  $('btn-reset').addEventListener('click', () => { $('reset-confirm').hidden = false; $('btn-reset').hidden = true; });
  $('reset-cancel').addEventListener('click', () => { $('reset-confirm').hidden = true; $('btn-reset').hidden = false; });
  $('reset-ok').addEventListener('click', () => {
    log = []; store.del('log');
    if (!flight) { loc = 'ICN'; store.del('loc'); depCode = loc; $('dep').value = depCode; pickDefault(); }
    updateNav();
    renderLog();
    toast('로그북을 비웠어요.');
  });

  // ---------- 탐색 ----------
  $('nav-book').addEventListener('click', () => show(flight ? 'flight' : pending ? 'pass' : 'book'));
  $('nav-log').addEventListener('click', () => show('log'));

  // 창 크기·테마가 바뀌면 지구본을 다시 그림
  function redrawGlobes() {
    if (planGlobe && current === 'book') { planGlobe.resize(); planGlobe.set(planScene(), false); }
    if (flightGlobe && current === 'flight') { flightGlobe.resize(); tick(); }
  }
  if (HAS_GEO) {
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(redrawGlobes);
      ro.observe($('globe-plan')); ro.observe($('globe-flight'));
    } else {
      window.addEventListener('resize', redrawGlobes);
    }
    new MutationObserver(redrawGlobes).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    if (window.matchMedia) {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', redrawGlobes);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(redrawGlobes);
  }

  // ---------- 시작 ----------
  fillDepartures();
  pickDefault();
  updateNav();
  if (flight) {
    if (Date.now() >= flight.endAt) land(false);
    else show('flight');
  } else {
    show('book');
  }
})();
