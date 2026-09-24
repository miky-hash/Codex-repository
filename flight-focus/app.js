(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const AIRPORTS = window.AIRPORTS || [];
  const AP = Object.fromEntries(AIRPORTS.map((a) => [a.code, a]));
  const HAS_GEO = !!(window.d3 && d3.geoOrthographic && window.WORLD_LAND);
  const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const BASE_TITLE = document.title;
  const VIEWS = ['book', 'pass', 'flight', 'arrive', 'log'];
  const SUBJECTS = ['국어', '수학', '영어', '과학', '사회', '한국사', '기타'];
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
  const lonlat = (a) => [a.lon, a.lat];

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
      return 0.035 * Math.sin(6.283 * m / 23 + ph[0]) + 0.02 * Math.sin(6.283 * m / 7 + ph[1]) + 0.008 * Math.sin(6.283 * m / 1.5 + ph[2])
        + 0.005 * Math.sin(6.283 * m / 0.35 + ph[3]);
    };
    function rel(p) {
      if (p < b[0]) return 22; // 지상 이동
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
    const scale = f.km / (total * T / 60); // rel 단위 → 실제 km/h
    const cruiseAlt = f.km < 500 ? 23000 : f.km < 1500 ? 33000 : 37000;
    const stepClimb = T > 360; // 장거리는 순항 중 두 번 고도를 올림
    const topAlt = cruiseAlt + (stepClimb ? 4000 : 0);

    const prof = {
      bounds: b,
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
      cruiseAlt,
    };
    profileCache.set(key, prof);
    return prof;
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
    // 중심에서 extent(라디안)만큼 떨어진 지점이 화면 안에 들어오도록 확대
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
    function drawPlane(c, pt, ang, size, engines) {
      ctx.save();
      ctx.translate(pt[0], pt[1]); ctx.rotate(ang); ctx.scale(1.3 * size, 1.3 * size);
      ctx.beginPath();
      PLANE.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.lineJoin = 'round'; ctx.lineWidth = 2.2 / size; ctx.strokeStyle = c.halo; ctx.stroke();
      ctx.fillStyle = c.plane; ctx.fill();
      const pods = engines === 4 ? [[0.6, 3.4], [-1.6, 6.4]] : [[0.4, 4.2]];
      pods.forEach(([x, y]) => [y, -y].forEach((yy) => {
        ctx.beginPath(); ctx.ellipse(x, yy, 1.7, 0.75, 0, 0, Math.PI * 2); ctx.fill();
      }));
      ctx.restore();
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
          drawPlane(c, pt, ang, scene.size || 1, scene.engines || 2);
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
  let loc = store.get('loc', 'ICN');
  if (!AP[loc]) loc = 'ICN';
  let flight = store.get('flight', null);
  if (flight && (!AP[flight.from] || !AP[flight.to] || !(flight.endAt > flight.startAt) || !ACMAP[flight.aircraft])) {
    flight = null; store.del('flight');
  }
  const prefs = Object.assign({ minutes: 60, subject: '수학', custom: '', aircraft: 'A220', voice: false }, store.get('prefs', {}));
  const savePrefs = () => store.set('prefs', prefs);

  let depCode = loc;
  const sel = { to: null, mode: 'real' };
  let showAll = false;
  let pending = null;
  let current = 'book';

  const planGlobe = HAS_GEO ? makeGlobe($('globe-plan')) : null;
  const flightGlobe = HAS_GEO ? makeGlobe($('globe-flight')) : null;
  if (!HAS_GEO) document.body.classList.add('no-geo');

  const totalMiles = () => log.reduce((s, e) => s + (e.miles || 0), 0);
  const unlocked = (miles) => AIRCRAFT.filter((a) => a.miles <= miles);
  const subjectName = () => (prefs.subject === '기타' ? (prefs.custom.trim() || '기타') : prefs.subject);

  // ---------- 알림 토스트 ----------
  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3400);
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
  const HAS_VOICE = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  function speak(text) {
    if (!HAS_VOICE || !prefs.voice) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR'; u.rate = 1.02;
      speechSynthesis.cancel();
      // 차임이 끝난 뒤 말하기
      setTimeout(() => speechSynthesis.speak(u), 1100);
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

  // ---------- 화면 전환 ----------
  let passTimer = 0;
  function show(view) {
    current = view;
    VIEWS.forEach((v) => { $('view-' + v).hidden = v !== view; });
    if (view === 'log') { $('nav-log').setAttribute('aria-current', 'page'); $('nav-book').removeAttribute('aria-current'); }
    else { $('nav-book').setAttribute('aria-current', 'page'); $('nav-log').removeAttribute('aria-current'); }
    clearInterval(passTimer);

    if (view === 'book') {
      renderBook();
      if (planGlobe) { planGlobe.resize(); planGlobe.set(planScene(), false); }
    }
    if (view === 'pass') passTimer = setInterval(updatePassTimes, 10000);
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
    $('nav-book').textContent = flight ? '비행 중' : '항공권 예약';
    $('loc-code').textContent = loc;
  }

  // ---------- 1. 항공권 예약 ----------
  function fillStaticInputs() {
    const groups = {};
    AIRPORTS.forEach((a) => { (groups[a.region] = groups[a.region] || []).push(a); });
    $('dep').innerHTML = Object.entries(groups).map(([region, list]) =>
      `<optgroup label="${esc(region)}">${list.map((a) => `<option value="${a.code}">${a.code} · ${esc(a.city)}</option>`).join('')}</optgroup>`
    ).join('');
    let hours = '';
    for (let h = 0; h <= 15; h++) hours += `<option value="${h}">${h}</option>`;
    $('t-hour').innerHTML = hours;
    let mins = '';
    for (let m = 0; m < 60; m += 5) mins += `<option value="${m}">${pad(m)}</option>`;
    $('t-min').innerHTML = mins;
    $('subjects').innerHTML = SUBJECTS.map((s) => `<button type="button" class="chip" data-subject="${s}">${s}</button>`).join('');
    $('subject-custom').value = prefs.custom;
  }

  function fillAircraft() {
    const miles = totalMiles();
    const own = unlocked(miles);
    if (!own.some((a) => a.id === prefs.aircraft)) prefs.aircraft = own[own.length - 1].id;
    $('aircraft').innerHTML = AIRCRAFT.map((a) => a.miles <= miles
      ? `<option value="${a.id}">${a.name}</option>`
      : `<option value="${a.id}" disabled>${a.name} · ${fmtNum(a.miles)}mi 필요</option>`).join('');
    $('aircraft').value = prefs.aircraft;
  }

  function routes() {
    const d = AP[depCode];
    return AIRPORTS
      .filter((a) => a.code !== depCode)
      .map((a) => { const km = distanceKm(d, a); return { a, km, min: realMinutes(km) }; })
      .filter((x) => x.km >= 100) // 인천–김포처럼 너무 가까운 구간은 제외
      .map((x) => Object.assign(x, { diff: x.min - prefs.minutes }))
      .sort((x, y) => Math.abs(x.diff) - Math.abs(y.diff) || x.km - y.km);
  }
  const selected = () => routes().find((x) => x.a.code === sel.to) || null;
  function pickBest() {
    const rs = routes();
    sel.to = rs.length ? rs[0].a.code : null;
    sel.mode = 'real';
  }

  function diffChip(diff) {
    if (Math.abs(diff) <= 5) return '<span class="diff exact">딱 맞아요</span>';
    return `<span class="diff">${diff > 0 ? '+' : '−'}${fmtDur(Math.abs(diff))}</span>`;
  }
  const PLANE_SVG = '<svg viewBox="-13 -10 26 20" aria-hidden="true"><path d="M11 0 8 1.3 2 1.5-3.5 9H-6l3.5-7.5L-8 1.3-10.5 4.5h-2L-11.2 0l-1.3-4.5h2L-8-1.3l5.5-.2L-6-9h2.5L2-1.5l6 .2Z"/></svg>';

  function renderList() {
    const dep = AP[depCode];
    const all = routes();
    const list = showAll ? all : all.slice(0, 8);
    $('flight-list').innerHTML = list.map((x) => `
      <li><button type="button" class="fl" data-code="${x.a.code}" aria-pressed="${sel.to === x.a.code}">
        <span class="fl-route">
          <span class="fl-code">${dep.code}<span class="fl-city">${esc(dep.city)}</span></span>
          <span class="fl-line">${PLANE_SVG}</span>
          <span class="fl-code fl-to">${x.a.code}<span class="fl-city">${esc(x.a.city)}</span></span>
        </span>
        <span class="fl-meta">
          <span class="fl-dur">${fmtHHMM(x.min)}</span>
          <span class="fl-km">${fmtKm(x.km)}</span>
          ${diffChip(x.diff)}
        </span>
      </button></li>`).join('');
    $('btn-more').textContent = showAll ? '가까운 항공편만 보기' : `항공편 ${all.length}개 모두 보기`;
    $('results-sub').textContent = `${dep.code} ${dep.city} 출발 · 집중 ${fmtHHMM(prefs.minutes)} · ${subjectName()}`;
  }

  function renderPreview() {
    const x = selected();
    const ok = !!x;
    $('btn-ticket').disabled = !ok; $('btn-ticket-m').disabled = !ok;
    if (!ok) { $('pv-route').textContent = '항공편을 골라 주세요'; $('m-summary').textContent = '-'; return; }
    const same = Math.abs(x.diff) <= 0;
    $('pv-route').textContent = `${depCode} → ${x.a.code} · ${x.a.city}`;
    $('mode-real-t').textContent = fmtHHMM(x.min);
    $('mode-mine-t').textContent = fmtHHMM(prefs.minutes);
    $('mode-seg').hidden = same;
    if (same) sel.mode = 'real';
    $('mode-real').setAttribute('aria-pressed', String(sel.mode === 'real'));
    $('mode-mine').setAttribute('aria-pressed', String(sel.mode === 'mine'));
    const minutes = sel.mode === 'real' ? x.min : prefs.minutes;
    let note;
    if (sel.mode === 'real') {
      note = same ? '적어 준 집중 시간과 실제 비행시간이 같아요.'
        : `실제 비행시간 기준이에요. 적어 준 시간보다 ${fmtDur(Math.abs(x.diff))} ${x.diff > 0 ? '길어요' : '짧아요'}.`;
    } else {
      const pct = Math.round((x.min / prefs.minutes - 1) * 100);
      note = Math.abs(pct) < 3 ? '실제와 거의 같은 속도로 날아요.'
        : `내가 정한 시간에 맞춰 실제보다 ${Math.abs(pct)}% ${pct > 0 ? '빠르게' : '느리게'} 날아요.`;
    }
    $('pv-note').textContent = note;
    $('m-summary').textContent = `${depCode} → ${x.a.code} · ${fmtHHMM(minutes)} · ${subjectName()}`;
  }

  function renderBook() {
    $('dep').value = depCode;
    $('t-hour').value = String(Math.floor(prefs.minutes / 60));
    $('t-min').value = String(prefs.minutes % 60);
    document.querySelectorAll('[data-quick]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.quick) === prefs.minutes)));
    document.querySelectorAll('[data-subject]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.subject === prefs.subject)));
    $('subject-custom').hidden = prefs.subject !== '기타';
    fillAircraft();
    if (!selected()) pickBest();
    renderList();
    renderPreview();
  }

  function planScene() {
    const dep = AP[depCode];
    const D = lonlat(dep);
    const marks = [{ at: D, label: dep.code }];
    const x = selected();
    if (!x) return { center: D, zoom: 4, marks };
    const A = lonlat(x.a);
    marks.push({ at: A, label: x.a.code });
    const ac = ACMAP[prefs.aircraft];
    return { center: d3.geoInterpolate(D, A)(0.5), zoom: planGlobe.zoomFor(d3.geoDistance(D, A) / 2),
      todo: { type: 'LineString', coordinates: [D, A] }, marks,
      plane: D, ahead: d3.geoInterpolate(D, A)(0.02), size: ac.size, engines: ac.engines };
  }
  function refreshBook(animate) {
    renderBook();
    if (planGlobe && current === 'book') planGlobe.set(planScene(), animate);
  }
  function setMinutes(min) {
    prefs.minutes = clamp(min, 5, 15 * 60 + 55);
    savePrefs();
    pickBest();
    refreshBook(true);
  }

  $('dep').addEventListener('change', (e) => { depCode = e.target.value; pickBest(); refreshBook(true); });
  $('t-hour').addEventListener('change', () => setMinutes(Number($('t-hour').value) * 60 + Number($('t-min').value)));
  $('t-min').addEventListener('change', () => setMinutes(Number($('t-hour').value) * 60 + Number($('t-min').value)));
  document.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => setMinutes(Number(b.dataset.quick))));
  $('subjects').addEventListener('click', (e) => {
    const b = e.target.closest('[data-subject]');
    if (!b) return;
    prefs.subject = b.dataset.subject; savePrefs();
    renderBook();
    if (prefs.subject === '기타') $('subject-custom').focus();
  });
  $('subject-custom').addEventListener('input', (e) => { prefs.custom = e.target.value.slice(0, 16); savePrefs(); renderList(); renderPreview(); });
  $('aircraft').addEventListener('change', (e) => { prefs.aircraft = e.target.value; savePrefs(); refreshBook(false); });
  $('btn-more').addEventListener('click', () => { showAll = !showAll; renderList(); });
  $('flight-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.fl');
    if (!btn) return;
    sel.to = btn.dataset.code;
    sel.mode = 'real';
    refreshBook(true);
    const again = $('flight-list').querySelector(`[data-code="${sel.to}"]`);
    if (again) again.focus({ preventScroll: true });
  });
  $('mode-real').addEventListener('click', () => { sel.mode = 'real'; renderPreview(); });
  $('mode-mine').addEventListener('click', () => { sel.mode = 'mine'; renderPreview(); });

  // ---------- 2. 탑승권 ----------
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
  function updatePassTimes() {
    if (!pending) return;
    const now = Date.now();
    $('p-board').textContent = fmtHM(now);
    $('p-arr').textContent = fmtHM(now + pending.minutes * 60000);
  }
  function renderPass() {
    const f = pending;
    const a = AP[f.from], b = AP[f.to];
    $('p-flight').textContent = f.flightNo;
    $('p-from').textContent = a.code; $('p-from-city').textContent = a.city;
    $('p-to').textContent = b.code; $('p-to-city').textContent = b.city;
    $('p-dur').textContent = fmtHHMM(f.minutes);
    $('p-subject').textContent = f.subject;
    $('p-gate').textContent = f.gate;
    $('p-ac').textContent = ACMAP[f.aircraft].name.replace(/^(Airbus|Boeing) /, '');
    $('p-km').textContent = fmtKm(f.km);
    $('s-route').textContent = `${a.code} → ${b.code}`;
    $('s-flight').textContent = `${f.flightNo} · ${f.gate}`;
    updatePassTimes();
    const r = rng(hash(f.flightNo + f.to));
    let bars = '';
    for (let i = 0; i < 44; i++) bars += `<span style="width:${1 + Math.floor(r() * 3)}px"></span>`;
    $('barcode').innerHTML = bars;
    $('pass-stub').classList.remove('is-torn');
    $('tear-handle').style.transform = '';
    boarding = false;
  }

  $('btn-ticket').addEventListener('click', openPass);
  $('btn-ticket-m').addEventListener('click', openPass);
  function openPass() {
    pending = buildFlight();
    if (!pending) return;
    renderPass();
    show('pass');
  }
  $('btn-back').addEventListener('click', () => { pending = null; show('book'); });

  // 절취선 찢기: 손잡이를 끝까지 밀면 탑승
  let boarding = false;
  function tearAndBoard() {
    if (!pending || boarding) return;
    boarding = true;
    ensureAudio(); // 사용자 동작 시점에 오디오 잠금 해제
    $('pass-stub').classList.add('is-torn');
    setTimeout(board, REDUCED ? 0 : 560);
  }
  const handle = $('tear-handle'), track = $('tear-track');
  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    if (!pending || boarding) return;
    drag = { x0: e.clientX, dx: 0, max: track.clientWidth - handle.offsetWidth - 6 };
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('is-dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.dx = clamp(e.clientX - drag.x0, 0, drag.max);
    handle.style.transform = `translateX(${drag.dx}px)`;
  });
  function endDrag() {
    if (!drag) return;
    const done = drag.dx >= drag.max * 0.85;
    const max = drag.max;
    drag = null;
    handle.classList.remove('is-dragging');
    if (done) { handle.style.transform = `translateX(${max}px)`; tearAndBoard(); return; }
    handle.style.transition = 'transform .2s';
    handle.style.transform = '';
    setTimeout(() => { handle.style.transition = ''; }, 220);
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('click', (e) => { if (e.detail === 0) tearAndBoard(); }); // 키보드(Enter/Space)
  $('btn-start').addEventListener('click', tearAndBoard);

  function board() {
    const f = pending;
    if (!f) return;
    f.startAt = Date.now();
    f.endAt = f.startAt + f.minutes * 60000;
    f.phase = -1;
    flight = f; pending = null;
    store.set('flight', flight);
    stopBreak();
    updateNav();
    show('flight');
  }

  // ---------- 3. 비행 중 ----------
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
  function setPA(text, time) {
    $('pa-text').textContent = text;
    $('pa-time').textContent = fmtHM(time);
  }

  function renderPhases(idx) {
    $('phases').innerHTML = PHASES.map((ph, i) =>
      `<li class="phase ${i < idx ? 'is-done' : i === idx ? 'is-now' : ''}"${i === idx ? ' aria-current="step"' : ''}><b>${ph.en}</b>${ph.ko}</li>`
    ).join('');
  }

  function renderFlightStatic() {
    const f = flight;
    if (!f) return;
    const ac = ACMAP[f.aircraft];
    $('f-flight').textContent = f.flightNo;
    $('f-route').textContent = `${f.from} → ${f.to}`;
    $('f-subject').textContent = f.subject;
    $('f-ac').textContent = ac.name;
    $('f-from').textContent = f.from;
    $('f-to').textContent = f.to;
    $('f-eta').textContent = fmtHM(f.endAt);
    $('abort-confirm').hidden = true;
    $('btn-abort').hidden = false;
    $('btn-voice').setAttribute('aria-pressed', String(prefs.voice));
    const p = progressOf(f, Date.now());
    const idx = profileOf(f).phase(p);
    renderPhases(idx);
    // 새로고침 뒤에는 지난 방송을 다시 울리지 않고 문구만 보여 줌
    if (f.phase >= 0) setPA(announcement(f, f.phase, p), Date.now());
    lastPhaseRendered = idx;
  }

  function flightScene(f, p) {
    const a = AP[f.from], b = AP[f.to];
    const A = lonlat(a), B = lonlat(b);
    const prof = profileOf(f);
    const s = prof.frac(p);
    const interp = d3.geoInterpolate(A, B);
    const pos = interp(s);
    const ac = ACMAP[f.aircraft];
    return {
      center: pos, zoom: flightGlobe.zoomFor(d3.geoDistance(A, B)),
      marks: [{ at: A, label: a.code }, { at: B, label: b.code }],
      todo: { type: 'LineString', coordinates: [pos, B] },
      done: { type: 'LineString', coordinates: [A, pos] },
      plane: pos, ahead: interp(s + 0.002), size: ac.size, engines: ac.engines,
    };
  }

  let lastTitle = '', lastPhaseRendered = -1, lastText = 0;
  function tick() {
    const f = flight;
    if (!f) return;
    const now = Date.now();
    const p = progressOf(f, now);
    if (p >= 1) { land(false); return; }
    const prof = profileOf(f);
    const idx = prof.phase(p);

    if (idx !== f.phase) {
      f.phase = idx;
      store.set('flight', f);
      const text = announcement(f, idx, p);
      setPA(text, now);
      chime();
      speak(text);
    }
    if (idx !== lastPhaseRendered) { renderPhases(idx); lastPhaseRendered = idx; }

    // 숫자는 1초에 한 번만 갱신
    if (now - lastText >= 1000 || lastText === 0) {
      lastText = now;
      const s = prof.frac(p);
      const remainSec = (f.endAt - now) / 1000;
      const clock = fmtClock(remainSec);
      const spd = prof.speed(p);
      const before = prof.speed(p - 4 / (f.minutes * 60)); // 4초 전과 비교
      const flown = f.km * s;
      $('f-remain').textContent = clock;
      $('h-time').textContent = clock;
      $('h-dist').textContent = fmtNum(f.km - flown) + ' km';
      $('f-bar').style.width = (p * 100).toFixed(2) + '%';
      $('t-alt').textContent = fmtNum(Math.round(prof.alt(p) / 10) * 10) + ' ft';
      $('t-spd').textContent = fmtNum(spd) + ' km/h';
      $('t-trend').textContent = spd - before > 0.3 ? '▲ 가속' : before - spd > 0.3 ? '▼ 감속' : '';
      $('t-flown').textContent = fmtNum(flown) + ' km';
      $('t-miles').textContent = fmtNum(flown * KM_TO_MI) + ' mi';
      const title = `${clock} · ${f.from}→${f.to}`;
      if (title !== lastTitle) { document.title = title; lastTitle = title; }
    }
    if (flightGlobe && current === 'flight' && !document.hidden) flightGlobe.set(flightScene(f, p), false);
  }

  let rafId = 0, lastFrame = 0;
  function loop(now) {
    rafId = 0;
    if (!flight || current !== 'flight') return;
    if (now - lastFrame > 150) { lastFrame = now; tick(); }
    if (flight && current === 'flight') rafId = requestAnimationFrame(loop);
  }
  function startLoop() { lastText = 0; if (!rafId) rafId = requestAnimationFrame(loop); }
  // 다른 화면에 있거나 탭이 백그라운드여도 착륙은 확인
  setInterval(() => { if (flight) tick(); }, 1000);

  $('btn-noise').addEventListener('click', () => {
    if (noiseSrc) { stopNoise(); return; }
    if (startNoise()) setNoiseBtn(true);
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

  // ---------- 4. 도착 / 회항 ----------
  function streaks() {
    const days = new Set(log.filter((e) => e.status === 'arrived').map((e) => dayKey(new Date(e.landedAt || e.date))));
    const today = new Date();
    let d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
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

  function land(diverted) {
    const f = flight;
    if (!f) return;
    const now = Math.min(Date.now(), f.endAt);
    const focusedMin = Math.round((now - f.startAt) / 60000);
    flight = null;
    store.del('flight');
    stopNoise();
    releaseWake();
    if (HAS_VOICE) speechSynthesis.cancel();
    document.title = BASE_TITLE; lastTitle = '';
    updateNav();

    if (diverted && focusedMin < 1) {
      toast('비행을 취소했어요. 기록은 남지 않았어요.');
      show('book');
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
      loc = f.to; store.set('loc', loc); depCode = loc; sel.to = null;
      chime();
      speak(`${AP[f.to].city}에 도착했습니다. 오늘도 수고하셨습니다.`);
    }
    updateNav();
    renderArrival(entry, newAc);
    show('arrive');
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
      $('break-msg').textContent = '환승 완료! 다음 항공권을 예약해 보세요.';
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
        <span class="hbar-track"><span class="hbar-fill" style="display:block;width:${(v / max * 100).toFixed(1)}%"></span></span>
        <span class="hbar-val">${fmtDur(v)}</span>
      </div>`).join('') : '<p class="muted small">아직 기록이 없어요. 첫 비행을 떠나 보세요.</p>';

    $('hangar').innerHTML = AIRCRAFT.map((a) => {
      const own = a.miles <= miles;
      return `<li class="${own ? '' : 'locked'}">
        <span class="ac-name">${a.name}</span>
        <span class="ac-state">${own ? '보유' : `${fmtNum(a.miles - miles)}mi 남음`}</span>
        ${own ? '' : `<span class="ac-bar"><span style="width:${(miles / a.miles * 100).toFixed(1)}%"></span></span>`}
      </li>`;
    }).join('');

    const cities = [...new Set(arrived.map((e) => e.to))];
    $('s-cities-n').textContent = cities.length ? `${cities.length}곳` : '';
    $('s-cities').textContent = cities.length ? cities.map((c) => `${c} ${AP[c] ? AP[c].city : ''}`).join(' · ') : '아직 착륙한 도시가 없어요.';

    $('log-body').innerHTML = log.length ? log.map((e) => {
      const pill = e.status === 'arrived' ? '<span class="pill ok">착륙</span>' : '<span class="pill bad">회항</span>';
      return `<tr>
        <td class="mono">${fmtDate(e.date)} ${fmtHM(e.date)}</td>
        <td class="mono">${esc(e.flightNo)}</td>
        <td class="route">${esc(e.from)} → ${esc(e.plannedTo || e.to)}</td>
        <td>${esc(e.subject || '-')}</td>
        <td>${esc(ACMAP[e.aircraft] ? ACMAP[e.aircraft].name.replace(/^(Airbus|Boeing) /, '') : '-')}</td>
        <td class="mono">${fmtDur(e.focusedMin)}</td>
        <td class="mono">${fmtNum(e.miles || 0)}</td>
        <td>${pill}</td>
      </tr>`;
    }).join('') : '<tr><td class="empty" colspan="8">아직 기록이 없어요. 첫 비행을 떠나 보세요.</td></tr>';
    $('btn-reset').hidden = !log.length;
    $('reset-confirm').hidden = true;
  }
  $('btn-reset').addEventListener('click', () => { $('reset-confirm').hidden = false; $('btn-reset').hidden = true; });
  $('reset-cancel').addEventListener('click', () => { $('reset-confirm').hidden = true; $('btn-reset').hidden = false; });
  $('reset-ok').addEventListener('click', () => {
    log = []; store.del('log');
    if (!flight) { loc = 'ICN'; store.del('loc'); depCode = loc; sel.to = null; }
    prefs.aircraft = 'A220'; savePrefs();
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
  fillStaticInputs();
  updateNav();
  if (flight) {
    if (Date.now() >= flight.endAt) land(false);
    else show('flight');
  } else {
    show('book');
  }
})();
