(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const AIRPORTS = window.AIRPORTS || [];
  const AP = Object.fromEntries(AIRPORTS.map((a) => [a.code, a]));
  const HAS_GEO = !!(window.d3 && d3.geoOrthographic && window.WORLD_LAND);
  const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const WIDE = window.matchMedia ? matchMedia('(min-width: 900px) and (min-aspect-ratio: 1/1)') : { matches: true };
  const BASE_TITLE = document.title;
  const FONT = "'Noto Sans KR', system-ui, sans-serif";

  const SUBJECTS = [
    { n: '공부', e: '📚', c: '#FFF1B8' },
    { n: '국어', e: '📖', c: '#E6CCF0' },
    { n: '수학', e: '📐', c: '#C4E3FA' },
    { n: '영어', e: '🔤', c: '#B8E4DD' },
    { n: '과학', e: '🔬', c: '#D6EDC8' },
    { n: '사회', e: '🌏', c: '#FFDDC8' },
    { n: '한국사', e: '🏛️', c: '#F8D3DC' },
    { n: '기타', e: '✏️', c: '#E4E4E7' },
  ];
  const PHASES = [
    { en: 'Gate', ko: '탑승구' },
    { en: 'Takeoff', ko: '이륙' },
    { en: 'Cruise', ko: '순항' },
    { en: 'Descent', ko: '하강' },
    { en: 'Landing', ko: '착륙' },
  ];
  // 누적 마일리지로 해금되는 기종 (cruise: 순항 속도 km/h, size: 지도 아이콘 크기)
  const AIRCRAFT = [
    { id: 'A220', name: 'Airbus A220-300', miles: 0, cruise: 830, size: 0.95, engines: 2 },
    { id: 'A321', name: 'Airbus A321neo', miles: 1000, cruise: 840, size: 1.05, engines: 2 },
    { id: 'B787', name: 'Boeing 787-9', miles: 5000, cruise: 900, size: 1.18, engines: 2 },
    { id: 'A350', name: 'Airbus A350-900', miles: 15000, cruise: 900, size: 1.28, engines: 2 },
    { id: 'B777', name: 'Boeing 777-300ER', miles: 30000, cruise: 905, size: 1.38, engines: 2 },
    { id: 'A380', name: 'Airbus A380-800', miles: 60000, cruise: 900, size: 1.52, engines: 4 },
  ];
  const ACMAP = Object.fromEntries(AIRCRAFT.map((a) => [a.id, a]));
  const acShort = (id) => (ACMAP[id] ? ACMAP[id].name.replace(/^(Airbus|Boeing) /, '') : '-');
  const KM_TO_MI = 0.621371;

  // ---------- 저장소 (막혀 있어도 앱은 동작) ----------
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('focusair2.' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem('focusair2.' + key, JSON.stringify(value)); } catch (e) { /* 무시 */ } },
    del(key) { try { localStorage.removeItem('focusair2.' + key); } catch (e) { /* 무시 */ } },
  };

  // ---------- 계산 도우미 ----------
  const toRad = (d) => d * Math.PI / 180;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pad = (n) => String(n).padStart(2, '0');
  const lonlat = (a) => [a.lon, a.lat];

  function distanceKm(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // 실제 항공편 소요시간에 가깝게: 지상 이동·이착륙 40분 + 순항 780km/h, 5분 단위
  const realMinutes = (km) => Math.max(30, Math.round((40 + km / 780 * 60) / 5) * 5);

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    let s = seed || 1;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }

  const fmtKm = (km) => Math.round(km).toLocaleString('ko-KR') + 'km';
  const fmtNum = (n) => Math.round(n).toLocaleString('ko-KR');
  const fmtHHMM = (min) => `${pad(Math.floor(min / 60))}:${pad(Math.round(min % 60))}`;
  const fmtHm = (min) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? `${h}h ${pad(m)}m` : `${m}m`; };
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
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const subjectColor = (name) => (SUBJECTS.find((s) => s.n === name) || SUBJECTS[SUBJECTS.length - 1]).c;

  // 받침에 따라 '로' / '으로'
  function euro(word) {
    const code = word.charCodeAt(word.length - 1) - 0xAC00;
    if (code < 0 || code > 11171) return '(으)로';
    const jong = code % 28;
    return jong === 0 || jong === 8 ? '로' : '으로';
  }

  // ---------- 비행 프로필: 단계, 속도, 고도, 위치 ----------
  // 속도는 단계마다 바뀌고 순항 중에도 바람처럼 조금씩 오르내린다.
  // 비행기 위치는 이 속도를 적분해서 구하므로, 빨라지면 실제로 더 멀리 간다.
  // 전체 거리를 정확히 정해진 시간에 날도록 속도를 비례 조정한다.
  const profileCache = new Map();
  function profileOf(f) {
    const key = f.seed + ':' + f.minutes + ':' + f.km;
    if (profileCache.has(key)) return profileCache.get(key);
    const T = f.minutes;
    const g = Math.min(0.1, 10 / T); // 푸시백·지상 이동
    const c = Math.min(0.18, 20 / T);
    const d = Math.min(0.18, 24 / T);
    const l = Math.min(0.1, 8 / T); // 접지·지상 이동
    const b = [g, g + c, 1 - d - l, 1 - l];
    const r = rng(f.seed);
    const ph = [r() * 6.283, r() * 6.283, r() * 6.283, r() * 6.283];
    const cruise = f.cruise;
    const wind = (p) => {
      const m = p * T;
      return 0.035 * Math.sin(6.283 * m / 23 + ph[0]) + 0.02 * Math.sin(6.283 * m / 7 + ph[1])
        + 0.008 * Math.sin(6.283 * m / 1.5 + ph[2]) + 0.005 * Math.sin(6.283 * m / 0.35 + ph[3]);
    };
    function rel(p) {
      if (p < b[0]) return 22;
      if (p < b[1]) {
        const t = (p - b[0]) / (b[1] - b[0]);
        return 22 + (cruise * (1 + wind(p) * t) - 22) * (1 - Math.pow(1 - t, 3));
      }
      if (p < b[2]) return cruise * (1 + wind(p));
      if (p < b[3]) {
        const t = (p - b[2]) / (b[3] - b[2]);
        return cruise * (1 + wind(p) * (1 - t)) * (1 - t) + 320 * t;
      }
      const t = (p - b[3]) / (1 - b[3]);
      return 320 - 295 * t * t;
    }
    const N = 1500;
    const cum = new Float64Array(N + 1);
    let prev = rel(0);
    for (let i = 1; i <= N; i++) {
      const v = rel(i / N);
      cum[i] = cum[i - 1] + (prev + v) / 2 / N;
      prev = v;
    }
    const total = cum[N];
    const scale = f.km / (total * T / 60);
    const cruiseAlt = f.km < 500 ? 23000 : f.km < 1500 ? 33000 : 37000;
    const stepClimb = T > 360;
    const topAlt = cruiseAlt + (stepClimb ? 4000 : 0);
    const prof = {
      phase(p) { return p < b[0] ? 0 : p < b[1] ? 1 : p < b[2] ? 2 : p < b[3] ? 3 : 4; },
      frac(p) {
        p = clamp(p, 0, 1);
        const x = p * N, i = Math.floor(x);
        if (i >= N) return 1;
        return (cum[i] + (cum[i + 1] - cum[i]) * (x - i)) / total;
      },
      speed(p) { return rel(clamp(p, 0, 1)) * scale; },
      alt(p) {
        if (p < b[0]) return 0;
        if (p < b[1]) return cruiseAlt * Math.sin((p - b[0]) / (b[1] - b[0]) * Math.PI / 2);
        if (p < b[2]) {
          if (!stepClimb) return cruiseAlt;
          const t = (p - b[1]) / (b[2] - b[1]);
          return cruiseAlt + (t > 0.66 ? 4000 : t > 0.33 ? 2000 : 0);
        }
        if (p < b[3]) {
          const t = (p - b[2]) / (b[3] - b[2]);
          return 3000 + (topAlt - 3000) * (1 + Math.cos(t * Math.PI)) / 2;
        }
        const t = (p - b[3]) / (1 - b[3]);
        return t < 0.6 ? 3000 * (1 - t / 0.6) : 0;
      },
    };
    profileCache.set(key, prof);
    return prof;
  }

  // ---------- 상태 ----------
  let log = store.get('log', []);
  if (!Array.isArray(log)) log = [];
  let loc = store.get('loc', 'ICN');
  if (!AP[loc]) loc = 'ICN';
  let flight = store.get('flight', null);
  if (flight && (!AP[flight.from] || !AP[flight.to] || !(flight.endAt > flight.startAt) || !ACMAP[flight.aircraft])) {
    flight = null; store.del('flight');
  }
  const prefs = Object.assign({ minutes: 60, subject: '공부', custom: '', aircraft: 'A220', voice: false }, store.get('prefs', {}));
  if (!SUBJECTS.some((s) => s.n === prefs.subject)) prefs.subject = '공부';
  const savePrefs = () => store.set('prefs', prefs);

  let depCode = loc;
  const sel = { to: null, mode: 'real' };
  let selKey = '';
  let pending = null;
  let lastEntry = null;
  let step = 'home';

  const totalMiles = () => log.reduce((s, e) => s + (e.miles || 0), 0);
  const unlocked = (miles) => AIRCRAFT.filter((a) => a.miles <= miles);
  const subjectName = () => (prefs.subject === '기타' ? (prefs.custom.trim() || '기타') : prefs.subject);

  // ---------- 지도 엔진: 우주 배경 + 지구본 (원 안에 잘라서 그림) ----------
  // view.r = 원(창) 반지름, view.zoom = 지구 확대. zoom 1이면 지구 전체가 보이고, 크면 둥근 창 속 지도처럼 보임.
  const cv = $('map');
  const ctx = cv.getContext('2d');
  const COL = {
    space: '#0A1120', ocean: '#86CEF6', oceanHi: '#BDE7FD', land: '#D3E9C3', landEdge: '#B4D39F',
    grat: 'rgba(255,255,255,0.3)', ink: '#141414', yellow: '#FFD43B', white: '#FFFFFF',
  };
  const PLANE = [[11, 0], [8, 1.3], [2, 1.5], [-3.5, 9], [-6, 9], [-2.5, 1.5], [-8, 1.3], [-10.5, 4.5], [-12.5, 4.5], [-11.2, 0],
    [-12.5, -4.5], [-10.5, -4.5], [-8, -1.3], [-2.5, -1.5], [-6, -9], [-3.5, -9], [2, -1.5], [8, -1.3]];
  const proj = HAS_GEO ? d3.geoOrthographic().clipAngle(90).precision(0.5) : null;
  const gpath = HAS_GEO ? d3.geoPath(proj, ctx) : null;
  const GRAT = HAS_GEO ? d3.geoGraticule10() : null;
  const SPHERE = { type: 'Sphere' };
  const STARS = (() => { const r = rng(42); return Array.from({ length: 200 }, () => ({ x: r(), y: r(), s: r() < 0.9 ? 1 : 2, a: 0.2 + r() * 0.6 })); })();
  let W = 1, H = 1, DPR = 1;
  const view = { cx: 0, cy: 0, r: 100, lon: 127, lat: 37, zoom: 1 };
  let tween = null, raf = 0;
  const scene = { chips: [], line: null, done: null, todo: null, plane: null, ahead: null, size: 1, engines: 2 };
  let chipHits = [];

  function resizeCanvas() {
    W = Math.max(1, window.innerWidth); H = Math.max(1, window.innerHeight);
    DPR = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  }
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  function lerpView(a, b, e) {
    const dLon = ((b.lon - a.lon + 540) % 360) - 180;
    return {
      cx: a.cx + (b.cx - a.cx) * e, cy: a.cy + (b.cy - a.cy) * e, r: a.r + (b.r - a.r) * e,
      lon: a.lon + dLon * e, lat: a.lat + (b.lat - a.lat) * e,
      zoom: Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * e),
    };
  }
  function flyTo(target, dur) {
    if (REDUCED || !dur) { tween = null; Object.assign(view, target); kick(); return; }
    tween = { from: Object.assign({}, view), to: target, t0: performance.now(), dur };
    kick();
  }
  // 비행 중처럼 목표가 계속 바뀔 때: 전환 중이면 목적지만 바꾸고, 아니면 바로 따라감
  function follow(target) {
    if (tween) tween.to = target; else { Object.assign(view, target); kick(); }
  }
  function kick() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame(now) {
    raf = 0;
    if (tween) {
      const t = Math.min(1, (now - tween.t0) / tween.dur);
      Object.assign(view, lerpView(tween.from, tween.to, ease(t)));
      if (t >= 1) tween = null;
    }
    draw();
    if (tween) kick();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function planePath(x, y, ang, s) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(ang); ctx.scale(s, s);
    ctx.beginPath();
    PLANE.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath();
    ctx.restore();
  }
  function frontPoint(ll) {
    if (d3.geoDistance(ll, [view.lon, view.lat]) > Math.PI / 2 - 0.02) return null;
    const p = proj(ll);
    if (Math.hypot(p[0] - view.cx, p[1] - view.cy) > view.r - 4) return null;
    return p;
  }

  function draw() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = COL.space;
    ctx.fillRect(0, 0, W, H);
    for (const s of STARS) { ctx.fillStyle = `rgba(255,255,255,${s.a})`; ctx.fillRect(s.x * W, s.y * H, s.s, s.s); }
    if (!HAS_GEO) return;

    const { cx, cy } = view;
    const R = view.r * view.zoom;
    proj.translate([cx, cy]).scale(R).rotate([-view.lon, -view.lat]);
    const whole = R <= view.r * 1.02;

    if (whole) { // 대기권 빛
      const g = ctx.createRadialGradient(cx, cy, R * 0.96, cx, cy, R * 1.16);
      g.addColorStop(0, 'rgba(120,190,255,0.55)');
      g.addColorStop(1, 'rgba(120,190,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.16, 0, Math.PI * 2); ctx.fill();
    }

    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, view.r, 0, Math.PI * 2); ctx.clip();
    const og = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R);
    og.addColorStop(0, COL.oceanHi); og.addColorStop(1, COL.ocean);
    ctx.beginPath(); gpath(SPHERE); ctx.fillStyle = whole ? og : COL.ocean; ctx.fill();
    ctx.beginPath(); gpath(GRAT); ctx.strokeStyle = COL.grat; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath(); gpath(window.WORLD_LAND); ctx.fillStyle = COL.land; ctx.fill();
    ctx.strokeStyle = COL.landEdge; ctx.lineWidth = 1; ctx.stroke();
    if (whole) { // 가장자리 그림자로 입체감
      const sh = ctx.createRadialGradient(cx, cy, R * 0.7, cx, cy, R);
      sh.addColorStop(0, 'rgba(0,20,60,0)'); sh.addColorStop(1, 'rgba(0,20,60,0.28)');
      ctx.beginPath(); gpath(SPHERE); ctx.fillStyle = sh; ctx.fill();
    }
    ctx.lineCap = 'round';
    ctx.strokeStyle = COL.ink;
    if (scene.line) { ctx.beginPath(); gpath(scene.line); ctx.lineWidth = 3; ctx.stroke(); }
    if (scene.todo) { ctx.beginPath(); gpath(scene.todo); ctx.setLineDash([8, 8]); ctx.lineWidth = 2.5; ctx.stroke(); ctx.setLineDash([]); }
    if (scene.done) { ctx.beginPath(); gpath(scene.done); ctx.lineWidth = 3.5; ctx.stroke(); }
    ctx.restore();

    if (!whole && view.r < Math.max(W, H) * 0.6) { // 확대했을 때는 둥근 창 테두리
      ctx.beginPath(); ctx.arc(cx, cy, view.r, 0, Math.PI * 2);
      ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.stroke();
    }

    drawChips();

    if (scene.plane) {
      const p = frontPoint(scene.plane);
      if (p) {
        const q = scene.ahead ? proj(scene.ahead) : null;
        const ang = q ? Math.atan2(q[1] - p[1], q[0] - p[0]) : 0;
        const s = 1.5 * scene.size;
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
        planePath(p[0], p[1], ang, s);
        ctx.fillStyle = COL.ink; ctx.fill();
        ctx.restore();
        planePath(p[0], p[1], ang, s);
        ctx.lineWidth = 1.6; ctx.strokeStyle = COL.white; ctx.stroke();
        // 엔진
        ctx.save();
        ctx.translate(p[0], p[1]); ctx.rotate(ang); ctx.scale(s, s); ctx.fillStyle = COL.ink;
        const pods = scene.engines === 4 ? [[0.6, 3.4], [-1.6, 6.4]] : [[0.4, 4.2]];
        pods.forEach(([x, y]) => [y, -y].forEach((yy) => { ctx.beginPath(); ctx.ellipse(x, yy, 1.7, 0.75, 0, 0, Math.PI * 2); ctx.fill(); }));
        ctx.restore();
      }
    }
  }

  // 노란 공항 칩 (겹치면 중요도가 낮은 칩은 생략)
  function drawChips() {
    const placed = [];
    const drawn = [];
    ctx.font = `700 13px ${FONT}`;
    for (const c of scene.chips) {
      const p = frontPoint(c.at);
      if (!p) continue;
      const w = ctx.measureText(c.code).width + 40, h = 30;
      const rect = { x: p[0] - w / 2, y: p[1] - h / 2, w, h };
      if (placed.some((q) => rect.x < q.x + q.w + 4 && q.x < rect.x + rect.w + 4 && rect.y < q.y + q.h + 4 && q.y < rect.y + rect.h + 4)) continue;
      placed.push(rect);
      drawn.push({ c, rect });
    }
    for (let i = drawn.length - 1; i >= 0; i--) {
      const { c, rect } = drawn[i];
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
      roundRect(rect.x, rect.y, rect.w, rect.h, 9);
      ctx.fillStyle = COL.yellow; ctx.fill();
      ctx.restore();
      if (c.kind === 'sel' || c.kind === 'here') {
        roundRect(rect.x, rect.y, rect.w, rect.h, 9);
        ctx.lineWidth = 2.5; ctx.strokeStyle = COL.ink; ctx.stroke();
      }
      const landing = c.kind === 'sel' || c.kind === 'cand';
      planePath(rect.x + 15, rect.y + rect.h / 2, landing ? 0.45 : -0.45, 0.6);
      ctx.fillStyle = COL.ink; ctx.fill();
      ctx.fillStyle = COL.ink;
      ctx.textBaseline = 'middle';
      ctx.fillText(c.code, rect.x + 27, rect.y + rect.h / 2 + 1);
    }
    chipHits = drawn.map((d) => Object.assign({ code: d.c.code }, d.rect));
  }

  // 단계별 지구본 자리: 흰 박스를 피해서 남는 공간 가운데
  function slotFor(s, d) {
    if (s === 'flight') {
      // 지도는 화면 전체, 비행기는 흰 박스에 가리지 않는 곳의 가운데
      const side = d.width < W * 0.7;
      const a = side ? { x: d.right, y: 0, w: W - d.right, h: H } : { x: 0, y: 70, w: W, h: d.top - 70 };
      return { cx: a.x + a.w / 2, cy: a.y + a.h / 2, r: Math.hypot(W, H) + 40, area: Math.min(a.w, a.h) };
    }
    if (s === 'pass' || s === 'log') return { cx: W / 2, cy: H / 2, r: Math.min(W, H) * 0.34 };
    let a;
    if (s === 'home') {
      const top = WIDE.matches ? 70 : 170;
      a = { x: 0, y: top, w: W, h: d.top - top - 10 };
    } else if (d.width < W * 0.7) {
      a = { x: 0, y: 0, w: d.left, h: H };
    } else {
      a = { x: 0, y: 70, w: W, h: d.top - 76 };
    }
    const r = Math.max(50, Math.min(a.w, a.h) * 0.44);
    return { cx: a.x + a.w / 2, cy: a.y + a.h / 2, r };
  }
  const lensZoom = (ext) => clamp(0.7 / Math.sin(clamp(ext, 0.004, Math.PI / 2)), 1, 14);

  function viewFor(s, d) {
    const slot = slotFor(s, d);
    const dep = AP[depCode];
    let center = lonlat(dep);
    let zoom = 1;
    if (!HAS_GEO) return Object.assign(slot, { lon: center[0], lat: center[1], zoom });
    if (s === 'route') {
      const x = selected();
      if (x) {
        const A = lonlat(dep), B = lonlat(x.a);
        center = d3.geoInterpolate(A, B)(0.5);
        zoom = lensZoom(d3.geoDistance(A, B) / 2);
      }
    } else if (s === 'flight' && flight) {
      const A = lonlat(AP[flight.from]), B = lonlat(AP[flight.to]);
      const p = progressOf(flight, Date.now());
      center = d3.geoInterpolate(A, B)(profileOf(flight).frac(p));
      const dist = Math.min(d3.geoDistance(A, B), Math.PI / 2);
      zoom = clamp((slot.area * 0.42) / (slot.r * Math.sin(Math.max(dist, 0.004))), 0.15, 30);
    } else if (s === 'arrive' && lastEntry && AP[lastEntry.to]) {
      center = lonlat(AP[lastEntry.to]);
    } else if (s === 'home') {
      center = lonlat(AP[loc]);
    }
    return Object.assign(slot, { lon: center[0], lat: center[1], zoom });
  }

  function updateScene() {
    scene.chips = []; scene.line = scene.done = scene.todo = scene.plane = scene.ahead = null;
    const chip = (code, kind) => ({ code, kind, at: lonlat(AP[code]) });
    if (step === 'home') {
      scene.chips = [chip(loc, 'here')].concat(AIRPORTS.filter((a) => a.code !== loc).map((a) => chip(a.code, 'plain')));
    } else if (step === 'time') {
      scene.chips = [chip(depCode, 'here')];
    } else if (step === 'route') {
      const x = selected();
      const cands = routes().slice(0, 16).filter((r) => !x || r.a.code !== x.a.code).map((r) => chip(r.a.code, 'cand'));
      scene.chips = (x ? [chip(x.a.code, 'sel')] : []).concat([chip(depCode, 'plain')], cands);
      if (x) scene.line = { type: 'LineString', coordinates: [lonlat(AP[depCode]), lonlat(x.a)] };
    } else if (step === 'flight' && flight) {
      scene.chips = [chip(flight.to, 'sel'), chip(flight.from, 'plain')];
      const ac = ACMAP[flight.aircraft];
      scene.size = ac.size; scene.engines = ac.engines;
      flightGeometry();
    } else if (step === 'arrive' && lastEntry) {
      scene.chips = [chip(lastEntry.to, 'here')];
    }
    kick();
  }

  function flightGeometry() {
    if (!HAS_GEO || !flight) return;
    const A = lonlat(AP[flight.from]), B = lonlat(AP[flight.to]);
    const interp = d3.geoInterpolate(A, B);
    const s = profileOf(flight).frac(progressOf(flight, Date.now()));
    const pos = interp(s);
    scene.done = { type: 'LineString', coordinates: [A, pos] };
    scene.todo = { type: 'LineString', coordinates: [pos, B] };
    scene.plane = pos; scene.ahead = interp(s + 0.002);
  }

  // 지구본 드래그로 돌리기 + 공항 칩 누르기
  let gdrag = null;
  const canTouchGlobe = () => ['home', 'time', 'route', 'arrive'].includes(step);
  cv.addEventListener('pointerdown', (e) => {
    if (!canTouchGlobe() || !HAS_GEO) return;
    gdrag = { x: e.clientX, y: e.clientY, lon: view.lon, lat: view.lat, moved: false };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!gdrag) {
      cv.style.cursor = canTouchGlobe() ? (chipAt(e.clientX, e.clientY) ? 'pointer' : 'grab') : 'default';
      return;
    }
    const dx = e.clientX - gdrag.x, dy = e.clientY - gdrag.y;
    if (!gdrag.moved && Math.hypot(dx, dy) < 6) return;
    gdrag.moved = true;
    tween = null;
    const k = 180 / Math.PI / (view.r * view.zoom);
    view.lon = gdrag.lon - dx * k;
    view.lat = clamp(gdrag.lat + dy * k, -80, 80);
    kick();
  });
  const endGlobeDrag = (e) => {
    if (!gdrag) return;
    const tap = !gdrag.moved;
    gdrag = null;
    if (tap) { const hit = chipAt(e.clientX, e.clientY); if (hit) onChipTap(hit.code); }
  };
  cv.addEventListener('pointerup', endGlobeDrag);
  cv.addEventListener('pointercancel', () => { gdrag = null; });
  const chipAt = (x, y) => chipHits.find((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);
  function onChipTap(code) {
    if (step === 'home') openAirportModal(code);
    else if (step === 'route' && code !== depCode) selectDest(code);
  }

  // ---------- 화면 단계: 흰 박스가 모양을 바꾸며 이동 ----------
  const dock = $('dock');
  const PANES = [...document.querySelectorAll('.pane')];
  let morphUntil = 0;
  let lastDock = null;

  function go(next, instant) {
    const first = dock.getBoundingClientRect();
    const cs1 = getComputedStyle(dock);
    const bg1 = cs1.backgroundColor, rad1 = cs1.borderRadius;
    step = next;
    document.body.dataset.step = next;
    PANES.forEach((p) => { p.hidden = p.dataset.pane !== next; });
    renderStep(next);
    const last = dock.getBoundingClientRect();
    const cs2 = getComputedStyle(dock);
    lastDock = last;
    if (!instant && !REDUCED) {
      dock.getAnimations().forEach((a) => a.cancel());
      const box = (r, bg, rad) => ({
        left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px',
        right: 'auto', bottom: 'auto', backgroundColor: bg, borderRadius: rad,
      });
      dock.animate([box(first, bg1, rad1), box(last, cs2.backgroundColor, cs2.borderRadius)],
        { duration: 640, easing: 'cubic-bezier(.2,.8,.2,1)' });
      const pane = PANES.find((p) => !p.hidden);
      if (pane) pane.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }],
        { duration: 380, delay: 220, easing: 'ease-out', fill: 'backwards' });
      morphUntil = performance.now() + 700;
    }
    updateScene();
    flyTo(viewFor(next, last), instant ? 0 : 860);
    if (next === 'flight') startFlightLoop(); else stopFlightLoop();
  }

  function renderStep(s) {
    if (s === 'home') renderHome();
    if (s === 'time') renderTime();
    if (s === 'route') renderRoute();
    if (s === 'pass') renderPass();
    if (s === 'flight') renderFlightStatic();
    if (s === 'log') renderLog();
  }

  // 박스 크기가 바뀌면(내용 변화·화면 회전) 지구본 자리도 맞춤
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      if (performance.now() < morphUntil) return;
      const r = dock.getBoundingClientRect();
      if (lastDock && Math.abs(r.width - lastDock.width) < 4 && Math.abs(r.height - lastDock.height) < 4
        && Math.abs(r.top - lastDock.top) < 4 && Math.abs(r.left - lastDock.left) < 4) return;
      lastDock = r;
      flyTo(viewFor(step, r), 320);
    }).observe(dock);
  }
  window.addEventListener('resize', () => {
    resizeCanvas();
    const r = dock.getBoundingClientRect();
    lastDock = r;
    flyTo(viewFor(step, r), 0);
  });

  $('btn-back').addEventListener('click', back);
  function back() {
    if (step === 'time') go('home');
    else if (step === 'route') go('time');
    else if (step === 'pass') { pending = null; go('route'); }
    else if (step === 'log') go('home');
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('airport-modal').hidden) closeAirportModal();
    else if (!$('subject-sheet').hidden) closeSheet();
    else back();
  });

  // ---------- 알림 토스트 ----------
  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3400);
  }

  // ---------- 처음 화면 ----------
  function streaks() {
    const days = new Set(log.filter((e) => e.status === 'arrived').map((e) => dayKey(new Date(e.landedAt || e.date))));
    const today = new Date();
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1); // 오늘 아직 안 날았으면 어제부터 셈
    let current = 0;
    while (days.has(dayKey(d))) { current++; d.setDate(d.getDate() - 1); }
    const sorted = [...days].map((k) => { const [y, m, dd] = k.split('-').map(Number); return new Date(y, m - 1, dd).getTime(); }).sort((a, b) => a - b);
    let best = 0, run = 0, prev = null;
    sorted.forEach((t) => {
      run = prev !== null && Math.round((t - prev) / 86400000) === 1 ? run + 1 : 1;
      best = Math.max(best, run);
      prev = t;
    });
    return { current, best };
  }
  function renderHome() {
    const h = new Date().getHours();
    $('greet-hi').textContent = h < 5 ? '늦은 밤이에요' : h < 11 ? '좋은 아침이에요' : h < 17 ? '좋은 오후예요' : h < 22 ? '좋은 저녁이에요' : '늦은 밤이에요';
    const a = AP[loc];
    $('greet-loc').textContent = `${a.city}, ${a.country}`;
    const today = dayKey(new Date());
    const todayMin = log.filter((e) => dayKey(new Date(e.landedAt || e.date)) === today).reduce((s, e) => s + (e.focusedMin || 0), 0);
    $('g-today').textContent = `오늘 ${fmtDur(todayMin)} 집중`;
    $('g-streak').textContent = `연속 ${streaks().current}일`;
    fillAircraft();
    $('plane-pill').textContent = `${acShort(prefs.aircraft)} · ${fmtNum(totalMiles())} mi`;
  }
  $('btn-journey').addEventListener('click', () => { depCode = loc; go('time'); });
  $('btn-log').addEventListener('click', () => go('log'));

  // 공항 확인 모달
  let modalCode = null;
  function openAirportModal(code) {
    modalCode = code;
    const a = AP[code];
    $('am-code').textContent = a.code;
    $('am-name').textContent = a.city;
    $('am-country').textContent = a.country;
    $('airport-modal').hidden = false;
    $('am-ok').focus();
  }
  function closeAirportModal() { $('airport-modal').hidden = true; modalCode = null; }
  $('am-close').addEventListener('click', closeAirportModal);
  $('am-cancel').addEventListener('click', closeAirportModal);
  $('airport-modal').addEventListener('click', (e) => { if (e.target === $('airport-modal')) closeAirportModal(); });
  $('am-ok').addEventListener('click', () => {
    if (!modalCode) return;
    loc = depCode = modalCode; store.set('loc', loc);
    closeAirportModal();
    go('time');
  });

  // ---------- 1. 소요 시간 (다이얼: 한 바퀴 = 60분) ----------
  const dial = $('dial');
  (() => {
    let t = '';
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      const [x1, y1] = polar(a, 86), [x2, y2] = polar(a, i % 3 === 0 ? 76 : 80);
      t += `<line class="dial-tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }
    $('dial-ticks').innerHTML = t;
  })();
  function polar(a, r) { return [+(150 + r * Math.sin(a)).toFixed(2), +(150 - r * Math.cos(a)).toFixed(2)]; }
  function renderTime() {
    const m = prefs.minutes;
    const part = m % 60;
    const frac = part === 0 ? 1 : part / 60;
    const a = frac * Math.PI * 2;
    const [sx, sy] = polar(0, 118);
    if (frac >= 0.999) {
      $('dial-arc').setAttribute('d', `M ${sx} ${sy} A 118 118 0 1 1 ${polar(Math.PI, 118).join(' ')} A 118 118 0 1 1 ${sx} ${sy}`);
    } else {
      const [ex, ey] = polar(a, 118);
      $('dial-arc').setAttribute('d', `M ${sx} ${sy} A 118 118 0 ${a > Math.PI ? 1 : 0} 1 ${ex} ${ey}`);
    }
    const [kx, ky] = polar(a, 118);
    $('dial-knob').setAttribute('cx', kx); $('dial-knob').setAttribute('cy', ky);
    $('dial-value').textContent = `${Math.floor(m / 60)}:${pad(m % 60)}`;
    $('dial-sub').textContent = fmtDur(m);
    const sl = $('dial-slider');
    sl.setAttribute('aria-valuenow', String(m));
    sl.setAttribute('aria-valuetext', fmtDur(m));
    document.querySelectorAll('[data-quick]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.quick) === m)));
    const best = routes()[0];
    $('time-best').innerHTML = best
      ? `<span><span class="hint">가장 가까운 항공편</span><br><b>${depCode} → ${best.a.code}</b> ${esc(best.a.city)}</span><span class="ychip">${fmtHm(best.min)}</span>`
      : '';
  }
  function setMinutes(m) {
    prefs.minutes = clamp(Math.round(m / 5) * 5, 5, 960);
    savePrefs();
    renderTime();
  }
  function angleOf(e) {
    const r = dial.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * 300 - 150;
    const y = (e.clientY - r.top) / r.height * 300 - 150;
    let a = Math.atan2(x, -y);
    if (a < 0) a += Math.PI * 2;
    return a;
  }
  let dd = null;
  dial.addEventListener('pointerdown', (e) => {
    dd = { a: angleOf(e), acc: prefs.minutes };
    dial.setPointerCapture(e.pointerId);
    dial.style.cursor = 'grabbing';
  });
  dial.addEventListener('pointermove', (e) => {
    if (!dd) return;
    const a = angleOf(e);
    let d = a - dd.a;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    dd.a = a;
    dd.acc = clamp(dd.acc + d / (Math.PI * 2) * 60, 5, 960);
    const snapped = Math.round(dd.acc / 5) * 5;
    if (snapped !== prefs.minutes) { prefs.minutes = snapped; renderTime(); }
  });
  const endDial = () => { if (!dd) return; dd = null; dial.style.cursor = ''; savePrefs(); };
  dial.addEventListener('pointerup', endDial);
  dial.addEventListener('pointercancel', endDial);
  $('dial-slider').addEventListener('keydown', (e) => {
    const map = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 60, PageDown: -60 };
    if (e.key in map) { e.preventDefault(); setMinutes(prefs.minutes + map[e.key]); }
    else if (e.key === 'Home') { e.preventDefault(); setMinutes(5); }
    else if (e.key === 'End') { e.preventDefault(); setMinutes(960); }
  });
  document.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => setMinutes(Number(b.dataset.quick))));
  $('btn-to-route').addEventListener('click', () => go('route'));

  // ---------- 2. 출발지 / 도착지 ----------
  function routes() {
    const d = AP[depCode];
    return AIRPORTS
      .filter((a) => a.code !== depCode)
      .map((a) => { const km = distanceKm(d, a); return { a, km, min: realMinutes(km) }; })
      .filter((x) => x.km >= 100) // 인천–김포처럼 너무 가까운 구간은 제외
      .map((x) => Object.assign(x, { diff: x.min - prefs.minutes }))
      .sort((x, y) => Math.abs(x.diff) - Math.abs(y.diff) || x.km - y.km);
  }
  const selected = () => (sel.to ? routes().find((x) => x.a.code === sel.to) || null : null);
  function pickBest() {
    const rs = routes();
    sel.to = rs.length ? rs[0].a.code : null;
    sel.mode = 'real';
  }

  function fillStatic() {
    const groups = {};
    AIRPORTS.forEach((a) => { (groups[a.region] = groups[a.region] || []).push(a); });
    $('dep').innerHTML = Object.entries(groups).map(([region, list]) =>
      `<optgroup label="${esc(region)}">${list.map((a) => `<option value="${a.code}">${a.code} · ${esc(a.city)}</option>`).join('')}</optgroup>`
    ).join('');
    $('subjects').innerHTML = SUBJECTS.map((s) =>
      `<button type="button" class="subject" data-subject="${s.n}" style="background:${s.c}"><span class="emo" aria-hidden="true">${s.e}</span>${s.n}</button>`
    ).join('');
    $('subject-custom').value = prefs.custom;
  }
  function fillAircraft() {
    const miles = totalMiles();
    const own = unlocked(miles);
    if (!own.some((a) => a.id === prefs.aircraft)) prefs.aircraft = own[own.length - 1].id;
    $('aircraft').innerHTML = AIRCRAFT.map((a) => (a.miles <= miles
      ? `<option value="${a.id}">✈ ${acShort(a.id)}</option>`
      : `<option value="${a.id}" disabled>${acShort(a.id)} · ${fmtNum(a.miles)}mi</option>`)).join('');
    $('aircraft').value = prefs.aircraft;
  }

  function renderRoute() {
    const key = depCode + ':' + prefs.minutes;
    if (key !== selKey || !selected()) { pickBest(); selKey = key; }
    $('dep').value = depCode;
    $('btn-change-time').textContent = fmtHHMM(prefs.minutes);
    fillAircraft();
    const rs = routes();
    $('cards').innerHTML = rs.map((x) => {
      const exact = Math.abs(x.diff) <= 5;
      const diff = exact ? '딱 맞아요' : `${x.diff > 0 ? '+' : '−'}${fmtDur(Math.abs(x.diff))}`;
      return `<button type="button" class="card" role="option" data-code="${x.a.code}" aria-selected="${sel.to === x.a.code}">
        <span class="ychip">${x.a.code}</span>
        <span class="card-city">${esc(x.a.city)}</span>
        <span class="card-time">${fmtHm(x.min)} · ${fmtKm(x.km)}</span>
        <span class="card-diff${exact ? '' : ' off'}">${diff}</span>
      </button>`;
    }).join('');
    renderRouteSummary();
  }
  function renderRouteSummary() {
    const x = selected();
    $('btn-go').disabled = !x;
    if (!x) { $('dest-name').textContent = '-'; $('route-note').textContent = ''; return; }
    $('dest-name').textContent = `${x.a.code} · ${x.a.city}`;
    const same = x.diff === 0;
    if (same) sel.mode = 'real';
    $('mode-seg').style.visibility = same ? 'hidden' : '';
    $('mode-real-t').textContent = fmtHHMM(x.min);
    $('mode-mine-t').textContent = fmtHHMM(prefs.minutes);
    $('mode-real').setAttribute('aria-pressed', String(sel.mode === 'real'));
    $('mode-mine').setAttribute('aria-pressed', String(sel.mode === 'mine'));
    let note;
    if (sel.mode === 'real') {
      note = same ? '정한 집중 시간과 실제 비행시간이 같아요.'
        : `실제 비행시간 ${fmtHHMM(x.min)} 동안 날아요. 정한 시간보다 ${fmtDur(Math.abs(x.diff))} ${x.diff > 0 ? '길어요' : '짧아요'}.`;
    } else {
      const pct = Math.round((x.min / prefs.minutes - 1) * 100);
      note = Math.abs(pct) < 3 ? '실제와 거의 같은 속도로 날아요.'
        : `정한 시간 ${fmtHHMM(prefs.minutes)}에 맞춰 실제보다 ${Math.abs(pct)}% ${pct > 0 ? '빠르게' : '느리게'} 날아요.`;
    }
    $('route-note').textContent = note;
  }
  function selectDest(code) {
    sel.to = code; sel.mode = 'real';
    $('cards').querySelectorAll('.card').forEach((c) => c.setAttribute('aria-selected', String(c.dataset.code === code)));
    const card = $('cards').querySelector(`[data-code="${code}"]`);
    if (card) card.scrollIntoView({ block: 'nearest', behavior: REDUCED ? 'auto' : 'smooth' });
    renderRouteSummary();
    updateScene();
    flyTo(viewFor('route', dock.getBoundingClientRect()), 700);
  }
  $('cards').addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) selectDest(c.dataset.code); });
  $('dep').addEventListener('change', (e) => {
    depCode = loc = e.target.value; store.set('loc', loc);
    pickBest(); selKey = depCode + ':' + prefs.minutes;
    renderRoute(); updateScene();
    flyTo(viewFor('route', dock.getBoundingClientRect()), 800);
  });
  $('aircraft').addEventListener('change', (e) => { prefs.aircraft = e.target.value; savePrefs(); });
  $('mode-real').addEventListener('click', () => { sel.mode = 'real'; renderRouteSummary(); });
  $('mode-mine').addEventListener('click', () => { sel.mode = 'mine'; renderRouteSummary(); });
  $('btn-change-time').addEventListener('click', () => go('time'));
  $('btn-go').addEventListener('click', () => { if (selected()) openSheet(); });

  // ---------- 과목 시트 ----------
  function openSheet() {
    const x = selected();
    $('sheet-route').textContent = `${depCode} → ${x.a.code} · ${fmtHHMM(sel.mode === 'real' ? x.min : prefs.minutes)}`;
    document.querySelectorAll('[data-subject]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.subject === prefs.subject)));
    $('custom-row').hidden = prefs.subject !== '기타';
    $('sheet-backdrop').hidden = false;
    $('subject-sheet').hidden = false;
    const cur = document.querySelector(`[data-subject="${prefs.subject}"]`);
    if (cur) cur.focus();
  }
  function closeSheet() { $('subject-sheet').hidden = true; $('sheet-backdrop').hidden = true; }
  $('sheet-backdrop').addEventListener('click', closeSheet);
  $('subjects').addEventListener('click', (e) => {
    const b = e.target.closest('[data-subject]');
    if (!b) return;
    if (b.dataset.subject === '기타') {
      document.querySelectorAll('[data-subject]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      $('custom-row').hidden = false;
      $('subject-custom').focus();
      return;
    }
    prefs.subject = b.dataset.subject; savePrefs();
    closeSheet();
    toPass();
  });
  function confirmCustom() {
    prefs.subject = '기타';
    prefs.custom = $('subject-custom').value.trim().slice(0, 16);
    savePrefs();
    closeSheet();
    toPass();
  }
  $('custom-ok').addEventListener('click', confirmCustom);
  $('subject-custom').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmCustom(); });

  // ---------- 3. 탑승권 ----------
  function buildFlight() {
    const x = selected();
    if (!x) return null;
    const ac = ACMAP[prefs.aircraft];
    const minutes = sel.mode === 'real' ? x.min : prefs.minutes;
    const h = hash(depCode + x.a.code + Date.now());
    return {
      from: depCode, to: x.a.code, km: Math.round(x.km), realMin: x.min, minutes, mode: sel.mode,
      subject: subjectName(), aircraft: ac.id, cruise: ac.cruise, seed: h || 1,
      flightNo: 'FA ' + (100 + (h % 900)),
      gate: 'ABCDE'[h % 5] + (1 + ((h >>> 5) % 40)),
      phase: -1,
    };
  }
  function toPass() { pending = buildFlight(); if (pending) go('pass'); }

  function renderPass() {
    const f = pending;
    if (!f) return;
    const a = AP[f.from], b = AP[f.to];
    const now = Date.now();
    $('p-flight').textContent = f.flightNo;
    $('p-from').textContent = a.code; $('p-from-city').textContent = a.city;
    $('p-to').textContent = b.code; $('p-to-city').textContent = b.city;
    $('p-dur').textContent = fmtHm(f.minutes);
    $('p-ft').textContent = fmtHHMM(f.minutes);
    $('p-subject').textContent = f.subject;
    $('p-gate').textContent = f.gate;
    $('p-board').textContent = fmtHM(now);
    $('p-arr').textContent = fmtHM(now + f.minutes * 60000);
    $('p-ac').textContent = acShort(f.aircraft);
    $('p-km').textContent = fmtKm(f.km);
    $('p-date').textContent = fmtDate(now);
    const r = rng(hash(f.flightNo + f.to));
    let bars = '';
    for (let i = 0; i < 34; i++) bars += `<span style="width:${2 + Math.floor(r() * 5)}px"></span>`;
    $('barcode').innerHTML = bars;
    $('stub').style.visibility = '';
    boarding = false;
  }

  // 바코드 부분을 끌어내려 찢기
  let boarding = false, fly = null;
  const stub = $('stub');
  stub.tabIndex = 0;
  stub.setAttribute('role', 'button');
  stub.setAttribute('aria-label', '탑승권을 찢고 탑승하기');
  function makeFly() {
    const r = stub.getBoundingClientRect();
    const c = stub.cloneNode(true);
    c.removeAttribute('id'); c.removeAttribute('tabindex'); c.removeAttribute('role');
    c.classList.add('stub-fly');
    Object.assign(c.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: '0' });
    document.body.appendChild(c);
    stub.style.visibility = 'hidden';
    return c;
  }
  let sd = null;
  stub.addEventListener('pointerdown', (e) => {
    if (!pending || boarding) return;
    fly = makeFly();
    sd = { y: e.clientY, dy: 0 };
    stub.setPointerCapture(e.pointerId);
  });
  stub.addEventListener('pointermove', (e) => {
    if (!sd || !fly) return;
    sd.dy = Math.max(0, e.clientY - sd.y);
    fly.style.transform = `translateY(${sd.dy}px) rotate(${-sd.dy / 18}deg)`;
  });
  const endStub = () => {
    if (!sd) return;
    const far = sd.dy > 60;
    sd = null;
    if (far) { tear(); return; }
    const f = fly; fly = null;
    const done = () => { f.remove(); stub.style.visibility = ''; };
    if (REDUCED) done();
    else f.animate([{ transform: f.style.transform || 'none' }, { transform: 'none' }], { duration: 200, easing: 'ease-out' }).finished.then(done, done);
  };
  stub.addEventListener('pointerup', endStub);
  stub.addEventListener('pointercancel', endStub);
  stub.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tear(); } });
  $('btn-board').addEventListener('click', tear);

  function tear() {
    if (!pending || boarding) return;
    boarding = true;
    ensureAudio(); // 사용자 동작 시점에 오디오 잠금 해제
    const f = fly || makeFly();
    fly = null;
    const from = f.style.transform || 'translateY(0px) rotate(0deg)';
    const cleanup = () => f.remove();
    if (REDUCED) { cleanup(); board(); return; }
    f.animate([{ transform: from, opacity: 1 }, { transform: 'translate(60px, 320px) rotate(-18deg)', opacity: 0 }],
      { duration: 700, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' }).finished.then(cleanup, cleanup);
    setTimeout(board, 520);
  }
  function board() {
    const f = pending;
    if (!f) return;
    f.startAt = Date.now();
    f.endAt = f.startAt + f.minutes * 60000;
    f.phase = -1;
    flight = f; pending = null;
    store.set('flight', flight);
    stopBreak();
    go('flight');
  }

  // ---------- 소리: 엔진 소음(브라운 노이즈), 기내 차임, 방송 음성 ----------
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
    $('btn-noise').setAttribute('aria-pressed', 'false');
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
  const HAS_VOICE = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  function speak(text) {
    if (!HAS_VOICE || !prefs.voice) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR'; u.rate = 1.02;
      speechSynthesis.cancel();
      setTimeout(() => speechSynthesis.speak(u), 1100); // 차임이 끝난 뒤
    } catch (e) { /* 음성 없음 */ }
  }
  if (!HAS_VOICE) $('btn-voice').hidden = true;

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
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (flight) tick();
    if (wakeWanted && !wakeLock) requestWake();
  });

  // ---------- 4. 비행 중 ----------
  const progressOf = (f, now) => clamp((now - f.startAt) / (f.endAt - f.startAt), 0, 1);

  function announcement(f, idx, p) {
    const city = AP[f.to].city;
    switch (idx) {
      case 0: return `${f.flightNo}편 ${city}행에 탑승하신 것을 환영합니다. 오늘 집중할 과목은 ${f.subject}입니다. 휴대전화는 비행기 모드로 바꿔 주세요.`;
      case 1: return `승무원 이륙 준비. 곧 이륙합니다. 지금부터 ${f.subject}에 집중해 주세요.`;
      case 2: {
        const alt = Math.round(profileOf(f).alt(p) / 1000) * 1000;
        const remain = Math.max(1, Math.round((1 - p) * f.minutes));
        return `기장입니다. 순항 고도 ${fmtNum(alt)}피트에 도달했습니다. ${city}까지 ${fmtDur(remain)} 남았습니다. 편안하게 집중하세요.`;
      }
      case 3: return `${city} 도착을 위해 하강을 시작합니다. 오늘 공부한 내용을 정리해 보세요.`;
      default: return '곧 착륙합니다. 좌석 등받이와 테이블을 제자리로 해 주세요.';
    }
  }
  function setPA(text, time) { $('pa-text').textContent = text; $('pa-time').textContent = fmtHM(time); }
  function renderPhases(idx) {
    $('phases').innerHTML = PHASES.map((ph, i) =>
      `<li class="phase ${i < idx ? 'is-done' : i === idx ? 'is-now' : ''}"${i === idx ? ' aria-current="step"' : ''}><b>${ph.en}</b>${ph.ko}</li>`
    ).join('');
  }

  let lastPhaseRendered = -1, lastText = 0, lastTitle = '';
  function renderFlightStatic() {
    const f = flight;
    if (!f) return;
    $('f-flight').textContent = f.flightNo;
    $('f-route').textContent = `${f.from} → ${f.to}`;
    $('f-subject').textContent = f.subject;
    $('f-subject').style.background = subjectColor(SUBJECTS.some((s) => s.n === f.subject) ? f.subject : '기타');
    $('t-eta').textContent = fmtHM(f.endAt);
    $('abort-confirm').hidden = true;
    $('btn-abort').hidden = false;
    $('btn-voice').setAttribute('aria-pressed', String(prefs.voice));
    const p = progressOf(f, Date.now());
    const idx = profileOf(f).phase(p);
    renderPhases(idx);
    lastPhaseRendered = idx;
    // 새로고침 뒤에는 지난 방송을 다시 울리지 않고 문구만 보여 줌
    if (f.phase >= 0) setPA(announcement(f, f.phase, p), Date.now());
    lastText = 0;
    updateTexts(f, p, Date.now());
  }

  function updateTexts(f, p, now) {
    const prof = profileOf(f);
    const s = prof.frac(p);
    const clock = fmtClock((f.endAt - now) / 1000);
    const spd = prof.speed(p);
    const before = prof.speed(p - 4 / (f.minutes * 60)); // 4초 전과 비교
    const flown = f.km * s;
    $('f-remain').textContent = clock;
    $('f-dist').textContent = fmtNum(f.km - flown) + ' km';
    $('f-bar').style.width = (p * 100).toFixed(2) + '%';
    $('t-alt').textContent = fmtNum(Math.round(prof.alt(p) / 10) * 10) + ' ft';
    $('t-spd').textContent = fmtNum(spd) + ' km/h';
    $('t-trend').textContent = spd - before > 0.3 ? '▲ 가속' : before - spd > 0.3 ? '▼ 감속' : '';
    $('t-miles').textContent = fmtNum(flown * KM_TO_MI) + ' mi';
    const title = `${clock} · ${f.from}→${f.to}`;
    if (title !== lastTitle) { document.title = title; lastTitle = title; }
  }

  function tick() {
    const f = flight;
    if (!f) return;
    const now = Date.now();
    const p = progressOf(f, now);
    if (p >= 1) { land(false); return; }
    const idx = profileOf(f).phase(p);
    if (idx !== f.phase) {
      f.phase = idx;
      store.set('flight', f);
      const text = announcement(f, idx, p);
      setPA(text, now);
      chime();
      speak(text);
    }
    if (step !== 'flight') return;
    if (idx !== lastPhaseRendered) { renderPhases(idx); lastPhaseRendered = idx; }
    if (now - lastText >= 1000) { lastText = now; updateTexts(f, p, now); }
    if (!document.hidden) { flightGeometry(); follow(viewFor('flight', dock.getBoundingClientRect())); }
  }
  let flightTimer = 0;
  function startFlightLoop() { if (!flightTimer) flightTimer = setInterval(tick, 200); tick(); }
  function stopFlightLoop() { clearInterval(flightTimer); flightTimer = 0; }
  // 다른 화면이거나 탭이 백그라운드여도 착륙은 확인
  setInterval(() => { if (flight && !flightTimer) tick(); }, 1000);

  $('btn-noise').addEventListener('click', () => {
    if (noiseSrc) { stopNoise(); return; }
    if (startNoise()) $('btn-noise').setAttribute('aria-pressed', 'true');
    else toast('이 브라우저에서는 소리를 낼 수 없어요.');
  });
  $('btn-voice').addEventListener('click', () => {
    prefs.voice = !prefs.voice; savePrefs();
    $('btn-voice').setAttribute('aria-pressed', String(prefs.voice));
    if (prefs.voice && flight) speak($('pa-text').textContent);
    else if (HAS_VOICE) speechSynthesis.cancel();
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
      ? `정말 비행을 중단할까요? 지금까지 집중한 ${fmtDur(min)}은 로그북에 '회항'으로 남고, 착륙 성공으로는 세지 않아요.`
      : '정말 비행을 중단할까요? 1분이 지나지 않아 기록은 남지 않아요.';
    $('abort-confirm').hidden = false;
    $('btn-abort').hidden = true;
  });
  $('abort-cancel').addEventListener('click', () => { $('abort-confirm').hidden = true; $('btn-abort').hidden = false; });
  $('abort-ok').addEventListener('click', () => land(true));

  // ---------- 5. 도착 / 회항 ----------
  function land(diverted) {
    const f = flight;
    if (!f) return;
    const now = Math.min(Date.now(), f.endAt);
    const focusedMin = Math.round((now - f.startAt) / 60000);
    flight = null;
    store.del('flight');
    stopFlightLoop();
    stopNoise();
    releaseWake();
    if (HAS_VOICE) speechSynthesis.cancel();
    document.title = BASE_TITLE; lastTitle = '';

    if (diverted && focusedMin < 1) {
      toast('비행을 취소했어요. 기록은 남지 않았어요.');
      go('home');
      return;
    }
    const p = progressOf(f, now);
    const kmFlown = diverted ? Math.round(f.km * profileOf(f).frac(p)) : f.km;
    const milesBefore = totalMiles();
    const entry = {
      id: f.startAt, date: f.startAt, landedAt: now, flightNo: f.flightNo,
      from: f.from, to: diverted ? f.from : f.to, plannedTo: f.to,
      subject: f.subject, aircraft: f.aircraft, minutes: f.minutes, focusedMin,
      km: kmFlown, miles: Math.round(kmFlown * KM_TO_MI),
      status: diverted ? 'diverted' : 'arrived',
    };
    log.unshift(entry);
    store.set('log', log);
    const milesAfter = totalMiles();
    const newAc = AIRCRAFT.filter((a) => a.miles > milesBefore && a.miles <= milesAfter).pop();
    if (newAc) { prefs.aircraft = newAc.id; savePrefs(); }
    if (!diverted) {
      loc = depCode = f.to; store.set('loc', loc);
      chime();
      speak(`${AP[f.to].city}에 도착했습니다. 오늘도 수고하셨습니다.`);
    }
    lastEntry = entry;
    renderArrival(entry, newAc);
    go('arrive');
  }

  function renderArrival(e, newAc) {
    const dest = AP[e.to];
    const stamp = $('a-stamp');
    stamp.classList.toggle('is-diverted', e.status === 'diverted');
    stamp.style.animation = 'none'; void stamp.offsetWidth; stamp.style.animation = '';
    $('a-stamp-top').textContent = e.status === 'diverted' ? 'RETURNED' : 'ARRIVED';
    $('a-stamp-code').textContent = dest.code;
    $('a-stamp-date').textContent = fmtDate(e.landedAt);
    if (e.status === 'diverted') {
      $('a-title').textContent = `${dest.city}${euro(dest.city)} 회항했어요`;
      $('a-sub').textContent = `${e.subject} 비행을 중간에 멈췄어요. 집중한 ${fmtDur(e.focusedMin)}과 날아간 거리만큼의 마일은 기록에 남았어요.`;
    } else {
      $('a-title').textContent = `${dest.city}에 도착했어요`;
      $('a-sub').textContent = `${e.subject} ${fmtDur(e.focusedMin)} 비행을 끝까지 마쳤어요. 착륙 성공!`;
    }
    $('a-min').textContent = fmtDur(e.focusedMin);
    $('a-km').textContent = fmtKm(e.km);
    $('a-miles').textContent = '+' + fmtNum(e.miles);
    $('a-streak').textContent = streaks().current + '일';
    $('a-unlock').hidden = !newAc;
    if (newAc) $('a-unlock-name').textContent = newAc.name;
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
      $('break-msg').textContent = '환승 완료! 다음 여정을 떠나 보세요.';
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
  $('btn-next').addEventListener('click', () => { depCode = loc; go('time'); });
  $('btn-home').addEventListener('click', () => go('home'));

  // ---------- 로그북 ----------
  function renderLog() {
    const arrived = log.filter((e) => e.status === 'arrived');
    const totalMin = log.reduce((s, e) => s + (e.focusedMin || 0), 0);
    const miles = totalMiles();
    const st = streaks();
    $('s-flights').textContent = fmtNum(arrived.length);
    $('s-time').textContent = fmtDur(totalMin);
    $('s-miles').textContent = fmtNum(miles);
    $('s-streak').textContent = st.current + '일';
    $('s-best').textContent = `최고 ${st.best}일`;

    // 과목별 집중 시간 (회항한 비행도 집중한 만큼 포함)
    const bySubject = {};
    log.forEach((e) => { bySubject[e.subject] = (bySubject[e.subject] || 0) + (e.focusedMin || 0); });
    const rows = Object.entries(bySubject).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const max = rows.length ? rows[0][1] : 1;
    $('subject-bars').innerHTML = rows.length ? rows.map(([name, v]) => `
      <div class="hbar" title="${esc(name)}: ${fmtDur(v)}">
        <span class="hbar-name">${esc(name)}</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:${(v / max * 100).toFixed(1)}%"></span></span>
        <span class="hbar-val">${fmtDur(v)}</span>
      </div>`).join('') : '<p class="hint">아직 기록이 없어요. 첫 여정을 떠나 보세요.</p>';

    $('hangar').innerHTML = AIRCRAFT.map((a) => {
      const own = a.miles <= miles;
      return `<li class="${own ? '' : 'locked'}">
        <span class="ac-name">${a.name}</span>
        <span class="ac-state">${own ? '보유' : `${fmtNum(a.miles - miles)}mi 남음`}</span>
        ${own ? '' : `<span class="ac-bar"><span style="width:${(miles / a.miles * 100).toFixed(1)}%"></span></span>`}
      </li>`;
    }).join('');

    const cities = [...new Set(arrived.map((e) => e.to))].filter((c) => AP[c]);
    $('s-cities-n').textContent = cities.length ? `${cities.length}곳` : '';
    $('s-cities').innerHTML = cities.length
      ? cities.map((c) => `<span class="ychip">${c} · ${esc(AP[c].city)}</span>`).join('')
      : '<p class="hint">아직 착륙한 도시가 없어요.</p>';

    $('log-body').innerHTML = log.length ? log.map((e) => {
      const pill = e.status === 'arrived' ? '<span class="pill ok">착륙</span>' : '<span class="pill bad">회항</span>';
      return `<tr>
        <td>${fmtDate(e.date)} ${fmtHM(e.date)}</td>
        <td>${esc(e.flightNo)}</td>
        <td class="route">${esc(e.from)} → ${esc(e.plannedTo || e.to)}</td>
        <td>${esc(e.subject || '-')}</td>
        <td>${esc(acShort(e.aircraft))}</td>
        <td>${fmtDur(e.focusedMin)}</td>
        <td>${fmtNum(e.miles || 0)}</td>
        <td>${pill}</td>
      </tr>`;
    }).join('') : '<tr><td class="empty" colspan="8">아직 기록이 없어요. 첫 여정을 떠나 보세요.</td></tr>';
    $('btn-reset').hidden = !log.length;
    $('reset-confirm').hidden = true;
  }
  $('btn-reset').addEventListener('click', () => { $('reset-confirm').hidden = false; $('btn-reset').hidden = true; });
  $('reset-cancel').addEventListener('click', () => { $('reset-confirm').hidden = true; $('btn-reset').hidden = false; });
  $('reset-ok').addEventListener('click', () => {
    log = []; store.del('log');
    if (!flight) { loc = depCode = 'ICN'; store.del('loc'); }
    prefs.aircraft = 'A220'; savePrefs();
    renderLog();
    toast('로그북을 비웠어요.');
  });

  // ---------- 시작 ----------
  resizeCanvas();
  fillStatic();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(kick);
  if (flight) {
    if (Date.now() >= flight.endAt) { go('home', true); land(false); }
    else go('flight', true);
  } else {
    go('home', true);
  }
})();
