(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const AIRPORTS = window.AIRPORTS || [];
  const AP = Object.fromEntries(AIRPORTS.map((a) => [a.code, a]));
  const HAS_GEO = !!(window.d3 && d3.geoOrthographic && window.WORLD_LAND);
  const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const WIDE = window.matchMedia ? matchMedia('(min-width: 640px) and (min-aspect-ratio: 1/1)') : { matches: true };
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
  // 마일리지는 집중한 시간에 비례: 1분에 8마일 (여객기 평균 속도 약 780km/h ≈ 분당 8마일)
  const MI_PER_MIN = 8;
  const milesFor = (ms) => Math.round(ms / 60000 * MI_PER_MIN);

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
    // 느린 단계: 탑승구 2분, 이륙 4분, 하강 4분, 착륙 2분 (합계 12분). 나머지는 모두 순항
    let g = 2 / T, c = 4 / T, d = 4 / T, l = 2 / T;
    const slow = g + c + d + l;
    if (slow > 0.2) { const k = 0.2 / slow; g *= k; c *= k; d *= k; l *= k; } // 60분보다 짧은 비행은 같은 비율로 줄여서 순항이 80%는 되게
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
      bounds: [0, b[0], b[1], b[2], b[3], 1], // 단계마다 시작·끝 (진행률)
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
  const prefs = Object.assign({ minutes: 60, subject: '공부', custom: '', aircraft: 'A220', voice: true, mapStyle: 'satellite', notify: true, flightMini: false }, store.get('prefs', {}));
  if (!prefs.voiceV2) { prefs.voice = true; prefs.voiceV2 = true; } // 새 방송 음성은 기본으로 켬
  if (!SUBJECTS.some((s) => s.n === prefs.subject)) prefs.subject = '공부';
  const savePrefs = () => store.set('prefs', prefs);

  let depCode = loc;
  let homeSel = loc; // 처음 화면에서 고른(노란) 공항
  const sel = { to: null, mode: 'real' };
  let selKey = '';
  let pending = null;
  let lastEntry = null;
  let step = 'home';

  const totalMiles = () => log.reduce((s, e) => s + (e.miles || 0), 0);
  const unlocked = (miles) => AIRCRAFT.filter((a) => a.miles <= miles);
  const subjectName = () => (prefs.subject === '기타' ? (prefs.custom.trim() || '기타') : prefs.subject);

  // ---------- 지도 엔진: 별 하늘 + 위성 사진 지구(WebGL) + 항로·칩·비행기 ----------
  // view.r = 단계별 지구본 기본 반지름, view.zoom = 확대 배율 (1이면 지구 전체가 보임)
  const cv = $('map');
  const ctx = cv.getContext('2d');
  const skyCv = $('sky');
  const sky = skyCv.getContext('2d');
  const COL = {
    space: '#0A1120', ocean: '#86CEF6', land: '#D3E9C3', landEdge: '#B4D39F',
    grat: 'rgba(255,255,255,0.3)', ink: '#141414', yellow: '#FFD43B', white: '#FFFFFF',
  };
  const PLANE = [[11, 0], [8, 1.3], [2, 1.5], [-3.5, 9], [-6, 9], [-2.5, 1.5], [-8, 1.3], [-10.5, 4.5], [-12.5, 4.5], [-11.2, 0],
    [-12.5, -4.5], [-10.5, -4.5], [-8, -1.3], [-2.5, -1.5], [-6, -9], [-3.5, -9], [2, -1.5], [8, -1.3]];
  const proj = HAS_GEO ? d3.geoOrthographic().clipAngle(90).precision(0.5) : null;
  const gpath = HAS_GEO ? d3.geoPath(proj, ctx) : null;
  const GRAT = HAS_GEO ? d3.geoGraticule10() : null;
  const SPHERE = { type: 'Sphere' };
  const W50 = window.WORLD50 || null;
  const STARS = (() => { const r = rng(42); return Array.from({ length: 220 }, () => ({ x: r(), y: r(), s: r() < 0.9 ? 1 : 2, a: 0.2 + r() * 0.6 })); })();
  let W = 1, H = 1, DPR = 1;
  const view = { cx: 0, cy: 0, r: 100, lon: 127, lat: 37, zoom: 1 };
  let tween = null, raf = 0;
  const scene = { chips: [], line: null, done: null, todo: null, plane: null, ahead: null, size: 1, engines: 2, pop: null };
  let chipHits = [];

  // 위성 사진 지구: 화면의 각 점을 정사영 역변환해서 NASA 블루 마블 사진에서 색을 가져옴
  const globeGL = initGlobeGL($('earth'));
  function initGlobeGL(canvas) {
    if (!window.EARTH_JPG) return null;
    let gl = null;
    try { gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false }); } catch (e) { gl = null; }
    if (!gl) return null;
    // 조각 셰이더 정밀도가 낮은 기기에서는 위성 사진이 네모 조각처럼 깨져 보이므로 내장 단색 지도를 씀
    const hp = gl.getShaderPrecisionFormat && gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    if (!hp || hp.precision < 20) return null;
    const vs = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
    const fs = `precision highp float;
      uniform sampler2D tex; uniform vec2 c; uniform float R; uniform float lam0; uniform float phi0;
      const float PI = 3.141592653589793;
      void main() {
        vec2 q = (gl_FragCoord.xy - c) / R;
        float rho = length(q);
        if (rho > 1.0) discard;
        float cc = asin(rho);
        float s = sin(cc), co = cos(cc);
        float phi = phi0, lam = lam0;
        if (rho > 1e-7) {
          phi = asin(clamp(co * sin(phi0) + q.y * s * cos(phi0) / rho, -1.0, 1.0));
          lam = lam0 + atan(q.x * s, rho * co * cos(phi0) - q.y * s * sin(phi0));
        }
        // fract를 쓰지 않고 REPEAT 감싸기에 맡겨야 날짜변경선에 이음매 줄이 안 생김
        vec2 uv = vec2((lam + PI) / (2.0 * PI), (0.5 * PI - phi) / PI);
        vec3 col = texture2D(tex, uv).rgb;
        float a = clamp((1.0 - rho) * R, 0.0, 1.0);
        gl_FragColor = vec4(col * a, a);
      }`;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
    const v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = {};
    ['tex', 'c', 'R', 'lam0', 'phi0'].forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });
    let ready = false;
    const img = new Image();
    img.onload = () => {
      let src = img;
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (max < img.width) { // 작은 기기면 사진을 줄여서 올림
        const c2 = document.createElement('canvas');
        c2.width = max; c2.height = max / 2;
        c2.getContext('2d').drawImage(img, 0, 0, c2.width, c2.height);
        src = c2;
      }
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(U.tex, 0);
      ready = true;
      kick();
    };
    img.src = window.EARTH_JPG;
    return {
      ready: () => ready,
      resize() { canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR); },
      render() {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (!ready) return;
        gl.uniform2f(U.c, view.cx * DPR, (H - view.cy) * DPR);
        gl.uniform1f(U.R, view.r * view.zoom * DPR);
        gl.uniform1f(U.lam0, toRad(view.lon));
        gl.uniform1f(U.phi0, toRad(view.lat));
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      },
    };
  }
  const satellite = () => !!(globeGL && globeGL.ready());

  // ---------- 인터넷 지도 (MapLibre): 일반 · 위성 · 지형 ----------
  // 지도 서비스에 닿으면 MapLibre 지구본을 쓰고, 닿지 않으면(예: Claude 미리보기) 내장 지구본으로 대신함
  const MAP_MODES = { normal: '일반', satellite: '위성', terrain: '지형' };
  const LIBERTY = 'https://tiles.openfreemap.org/styles/liberty';
  const ATTRIB = {
    normal: '© OpenFreeMap © OpenMapTiles © OpenStreetMap',
    satellite: 'Imagery © Esri, Maxar, Earthstar Geographics · Labels © OpenFreeMap © OpenStreetMap',
    terrain: '© OpenFreeMap © OpenMapTiles © OpenStreetMap · Terrain © Mapzen, AWS Open Data',
    builtinSat: 'NASA Blue Marble · Natural Earth',
    builtinFlat: 'Natural Earth',
  };
  let ml = null, mlReady = false, mlCap = Math.PI / 2, baseStyle = null, tilesFailed = false;
  let camMoving = false; // 앱이 카메라를 계속 옮기는 중인지 (비행기 따라가기·전환 애니메이션·손으로 끌기)
  const tilesOn = () => !!(ml && mlReady);
  const mapMode = () => (MAP_MODES[prefs.mapStyle] ? prefs.mapStyle : 'satellite');
  const camF = () => 1.5 * H; // MapLibre 기본 시야각(36.87°)에서 카메라~화면 거리
  // 확대 1배일 때 지구의 겉보기 반지름이 view.r이 되는 실제 반지름 × 배율 (원근 보정)
  function worldR() {
    const f = camF(), rho = view.r;
    return (rho * rho + rho * Math.sqrt(rho * rho + f * f)) / f * view.zoom;
  }
  function apparentR() {
    if (!tilesOn()) return view.r * view.zoom;
    const f = camF(), Rw = worldR();
    return f * Rw / Math.sqrt(f * f + 2 * f * Rw);
  }
  const maxZoom = () => (tilesOn() ? 60000 : 300);

  function koLabels(layers) { // 지명은 한국어 우선
    return layers.map((l) => {
      if (l.type !== 'symbol' || !l.layout || !l.layout['text-field']) return l;
      if (!JSON.stringify(l.layout['text-field']).includes('name')) return l;
      return Object.assign({}, l, { layout: Object.assign({}, l.layout, { 'text-field': ['coalesce', ['get', 'name:ko'], ['get', 'name:latin'], ['get', 'name']] }) });
    });
  }
  function buildStyle(mode) {
    const s = JSON.parse(JSON.stringify(baseStyle));
    s.projection = { type: 'globe' };
    s.sky = { 'atmosphere-blend': 0 }; // 가장자리 그라데이션 빛은 끔
    let layers = koLabels(s.layers || []);
    if (mode === 'satellite') {
      s.sources.sat = {
        type: 'raster', tileSize: 256, maxzoom: 19, attribution: ATTRIB.satellite,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      };
      layers = [{ id: 'sat', type: 'raster', source: 'sat' }].concat(
        layers.filter((l) => l.type === 'symbol' || (l.type === 'line' && /boundary|admin/.test(l.id)))
          .map((l) => (l.type === 'symbol' ? Object.assign({}, l, { paint: Object.assign({}, l.paint, { 'text-color': '#FFFFFF', 'text-halo-color': 'rgba(0,0,0,0.75)', 'text-halo-width': 1.2 }) }) : l)));
    } else if (mode === 'terrain') {
      s.sources.dem = {
        type: 'raster-dem', tileSize: 256, maxzoom: 14, encoding: 'terrarium', attribution: 'Terrain © Mapzen, AWS Open Data',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      };
      const i = layers.findIndex((l) => /water/.test(l.id));
      layers.splice(i < 0 ? 1 : i, 0, {
        id: 'hills', type: 'hillshade', source: 'dem',
        paint: { 'hillshade-exaggeration': 0.7, 'hillshade-shadow-color': '#3E3526', 'hillshade-highlight-color': '#FFFDF5', 'hillshade-accent-color': '#6B6150' },
      });
    }
    s.layers = layers;
    return s;
  }
  function loadScript(src) {
    return new Promise((ok, no) => { const el = document.createElement('script'); el.src = src; el.onload = ok; el.onerror = no; document.head.appendChild(el); });
  }
  async function startTiles() {
    if (!HAS_GEO || !window.fetch) { tilesFailed = true; return; }
    try {
      const ctl = window.AbortController ? new AbortController() : null;
      const timer = setTimeout(() => { if (ctl) ctl.abort(); }, 6000);
      const r = await fetch(LIBERTY, ctl ? { signal: ctl.signal } : {});
      clearTimeout(timer);
      if (!r.ok) throw new Error('style');
      baseStyle = await r.json();
      if (!window.maplibregl) {
        const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/maplibre-gl.css'; document.head.appendChild(css);
        await loadScript('vendor/maplibre-gl.js');
      }
      ml = new maplibregl.Map({
        container: 'mlmap', style: buildStyle(mapMode()), interactive: false, attributionControl: false,
        center: [view.lon, view.lat], zoom: 1, minZoom: -2, maxZoom: 19, fadeDuration: 200, renderWorldCopies: false,
      });
      // MapLibre는 지도가 멈춰 있다고 보면 위성 사진을 픽셀 격자에 딱 맞춰 그림. 카메라를 매 프레임 직접 옮기는 동안에도
      // 그렇게 하면 크게 확대했을 때 사진만 1픽셀씩 끊겨 움직여서, 글자·선과 어긋나 흔들려 보임 → 옮기는 동안은 "움직이는 중"으로 알림
      const baseIsMoving = ml.isMoving.bind(ml);
      ml.isMoving = () => camMoving || baseIsMoving();
      ml.on('load', () => {
        mlReady = true;
        $('earth').hidden = true;
        $('mlmap').classList.add('on');
        setAttrib();
        kick();
      });
      ml.on('error', () => {}); // 타일 하나가 안 와도 전체는 계속
    } catch (e) {
      tilesFailed = true;
      setAttrib();
    }
  }
  function syncMap() {
    const f = camF(), Rw = worldR();
    const lat = clamp(view.lat, -84, 84);
    const z = Math.log2(2 * Math.PI * Rw * Math.cos(toRad(lat)) / 512);
    mlCap = Math.acos(Rw / (f + Rw));
    const cx = clamp(view.cx, 1, W - 1), cy = clamp(view.cy, 1, H - 1);
    ml.jumpTo({
      center: [(((view.lon + 180) % 360) + 360) % 360 - 180, lat], zoom: clamp(z, -2, 19),
      padding: { left: Math.max(0, 2 * cx - W), right: Math.max(0, W - 2 * cx), top: Math.max(0, 2 * cy - H), bottom: Math.max(0, H - 2 * cy) },
    });
    if (ml.redraw) ml.redraw(); // 지도와 위에 그린 항로·칩이 같은 순간을 보이도록
  }
  function setAttrib() {
    const m = mapMode();
    $('attrib').textContent = tilesOn() ? ATTRIB[m] : (m === 'satellite' && satellite() ? ATTRIB.builtinSat : ATTRIB.builtinFlat);
  }
  let mapFade = null; // 지도 바꿀 때 잠깐 흐리게 하는 애니메이션 (가장 최근 것 하나만 유효)
  function setMapMode(m) {
    if (m === mapMode()) return; // 이미 고른 지도를 또 누르면 아무것도 안 함
    prefs.mapStyle = m; savePrefs();
    renderMapMenu();
    if (tilesOn()) {
      const el = $('mlmap');
      if (mapFade) mapFade.cancel(); // 빠르게 여러 번 바꾸면 앞의 전환은 그만둠
      const a = REDUCED ? null : el.animate([{ opacity: 1 }, { opacity: 0.2 }], { duration: 160, fill: 'forwards' });
      mapFade = a;
      let timer = 0;
      // 다시 또렷하게: 새 지도가 준비되면, 또는 준비 신호가 안 와도 1.5초 뒤에는 반드시
      const restore = () => {
        clearTimeout(timer);
        if (mapFade !== a) return; // 더 나중에 고른 지도가 있으면 그쪽이 처리
        mapFade = null;
        if (a) { a.cancel(); el.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 450, easing: 'ease-out' }); }
      };
      const swap = () => {
        if (mapFade !== a) return;
        ml.setStyle(buildStyle(m));
        ml.once('styledata', restore);
        timer = setTimeout(restore, 1500);
      };
      if (a) a.finished.then(swap, () => {}); else swap();
    } else if (tilesFailed && m !== 'satellite') {
      toast('여기서는 인터넷 지도를 쓸 수 없어서 내장 지도로 보여 줘요. GitHub Pages 주소에서 열면 실제 지도가 나와요.');
    }
    setAttrib();
    kick();
  }

  function resizeCanvas() {
    W = Math.max(1, window.innerWidth); H = Math.max(1, window.innerHeight);
    DPR = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    skyCv.width = cv.width; skyCv.height = cv.height;
    if (globeGL) globeGL.resize();
    if (ml) ml.resize();
    sky.setTransform(DPR, 0, 0, DPR, 0, 0);
    sky.fillStyle = COL.space;
    sky.fillRect(0, 0, W, H);
    for (const s of STARS) { sky.fillStyle = `rgba(255,255,255,${s.a})`; sky.fillRect(s.x * W, s.y * H, s.s, s.s); }
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
  const builtinSat = () => !tilesOn() && mapMode() === 'satellite' && satellite();
  // 비행기가 화면에서 1초에 몇 픽셀 움직이는지: 느리면 0.2초마다, 빠르면(확대했을 때) 매 프레임 그림
  function planePxPerSec() {
    if (!flight || flight.pausedAt) return 0;
    const kmh = profileOf(flight).speed(progressOf(flight, Date.now()));
    // 화면 한가운데의 1km가 몇 픽셀인지: 인터넷 지도는 원근 때문에 겉보기 반지름이 아니라 실제 반지름(worldR)으로 계산
    const pxPerKm = (tilesOn() ? worldR() : view.r * view.zoom) / 6371;
    return kmh / 3600 * pxPerKm;
  }
  function frame(now) {
    raf = 0;
    const flying = step === 'flight' && !!flight;
    if (flying) {
      flightGeometry();
      if (following) { // 비행기 따라가기: 목표 자리를 매 프레임 새로 계산
        const v = viewFor('flight', dockRect());
        if (tween) tween.to = v; else Object.assign(view, v);
      }
    }
    if (tween) {
      const t = Math.min(1, (now - tween.t0) / tween.dur);
      Object.assign(view, lerpView(tween.from, tween.to, ease(t)));
      if (t >= 1) tween = null;
    }
    // 움직이는 동안은 부드럽게, 멈추면 마지막 프레임에서 사진을 다시 또렷하게(격자에 맞춰) 그림
    camMoving = !!tween || !!(gdrag && gdrag.moved) || !!pinch || (flying && following && !flight.pausedAt);
    if (tilesOn()) syncMap();
    else if (globeGL) {
      const on = builtinSat();
      if ($('earth').hidden === on) $('earth').hidden = !on;
      if (on) globeGL.render();
    }
    draw(now);
    if (tween || (scene.pop && now - scene.pop.t0 < 420) || (flying && planePxPerSec() > 0.8)) kick();
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
  const unitVec = (lon, lat) => { const a = toRad(lon), b = toRad(lat), cb = Math.cos(b); return [cb * Math.cos(a), cb * Math.sin(a), Math.sin(b)]; };
  // 지구 앞면에 보이는 점이면 화면 좌표, 뒤쪽이면 null
  function projectVisible(ll) {
    if (tilesOn()) {
      if (d3.geoDistance(ll, [view.lon, view.lat]) > mlCap - 0.01) return null;
      const p = ml.project(ll);
      return [p.x, p.y];
    }
    if (d3.geoDistance(ll, [view.lon, view.lat]) > Math.PI / 2 - 0.02) return null;
    return proj(ll);
  }
  function frontPoint(ll) {
    const p = projectVisible(ll);
    if (!p || p[0] < -40 || p[1] < -40 || p[0] > W + 40 || p[1] > H + 40) return null;
    return p;
  }
  // 대권 항로 선: 내장 지구본은 d3로, 인터넷 지도는 점을 촘촘히 찍어 이음
  function geoLine(line) {
    ctx.beginPath();
    if (!tilesOn()) { gpath(line); return; }
    const [A, B] = line.coordinates;
    const n = clamp(Math.ceil(d3.geoDistance(A, B) / 0.004), 2, 500);
    const interp = d3.geoInterpolate(A, B);
    let pen = false;
    for (let i = 0; i <= n; i++) {
      const p = projectVisible(interp(i / n));
      if (!p) { pen = false; continue; }
      if (pen) ctx.lineTo(p[0], p[1]); else { ctx.moveTo(p[0], p[1]); pen = true; }
    }
  }

  // ---------- 비행기: 기종별 실제 비율로 위에서 본 모습 ----------
  // L 길이, w 동체 폭, span 날개폭, sweep 날개 뒤로 젖힘, rc/tc 날개 뿌리·끝 폭, eng 엔진 위치(날개폭 비율), hs 수평꼬리날개 폭 (단위 m)
  const AC_SHAPE = {
    A220: { L: 38.7, w: 3.7, span: 35.1, sweep: 7.5, rc: 6.5, tc: 1.8, eng: [0.34], ew: 2.1, el: 4.8, hs: 11.5 },
    A321: { L: 44.5, w: 3.95, span: 35.8, sweep: 8.2, rc: 7, tc: 1.6, eng: [0.33], ew: 2.3, el: 5.2, hs: 12.5, sharklet: true },
    B787: { L: 62.8, w: 5.8, span: 60.1, sweep: 15.5, rc: 11, tc: 1.8, eng: [0.3], ew: 3.3, el: 7.2, hs: 19.5, raked: true },
    A350: { L: 66.8, w: 6, span: 64.75, sweep: 16, rc: 11.5, tc: 2, eng: [0.3], ew: 3.3, el: 7.4, hs: 19, raked: true },
    B777: { L: 73.9, w: 6.2, span: 64.8, sweep: 17, rc: 13, tc: 2.2, eng: [0.31], ew: 3.9, el: 8.2, hs: 21.5, raked: true },
    A380: { L: 72.7, w: 7.1, span: 79.8, sweep: 19, rc: 17, tc: 3, eng: [0.26, 0.47], ew: 3, el: 6.6, hs: 30.4, sharklet: true },
  };
  const PX_PER_M = 1.05;
  const planeImgs = {}, planeShadows = {}; // planes/<기종>.png 가 있으면 그 그림을 씀 (위에서 본 모습, 기수가 위쪽)
  AIRCRAFT.forEach((a) => {
    const img = new Image();
    img.onload = () => {
      // 그림자용 검은 실루엣을 한 번만 만들어 둠 (캔버스 filter가 없는 브라우저에서도 똑같이 보이게)
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
      planeShadows[a.id] = c;
      planeImgs[a.id] = img;
      kick();
    };
    img.src = `planes/${a.id}.png`;
  });
  function aircraftPath(g) { // 동체·날개·꼬리날개 윤곽 (기수가 +x)
    const p = new Path2D();
    const xl = g.L * 0.1, hsp = g.span / 2;
    const wing = (sgn) => {
      p.moveTo(xl, sgn * g.w * 0.45);
      p.lineTo(xl - g.sweep, sgn * hsp);
      if (g.raked) p.lineTo(xl - g.sweep - g.tc * 1.4, sgn * (hsp - 0.3));
      p.lineTo(xl - g.sweep - g.tc, sgn * hsp);
      p.lineTo(xl - g.rc, sgn * g.w * 0.45);
      p.closePath();
    };
    wing(1); wing(-1);
    const tx = -g.L / 2 + g.L * 0.16, hh = g.hs / 2;
    [1, -1].forEach((sgn) => {
      p.moveTo(tx, sgn * g.w * 0.25);
      p.lineTo(tx - hh * 0.55, sgn * hh);
      p.lineTo(tx - hh * 0.55 - g.tc * 0.9, sgn * hh);
      p.lineTo(tx - g.rc * 0.45, sgn * g.w * 0.2);
      p.closePath();
    });
    return p;
  }
  function fuselagePath(g) {
    const p = new Path2D(), n = g.L / 2, t = -g.L / 2, hw = g.w / 2;
    p.moveTo(n, 0);
    p.quadraticCurveTo(n - 0.1, hw, n - g.w * 1.4, hw);
    p.lineTo(t + g.L * 0.2, hw);
    p.quadraticCurveTo(t + g.L * 0.05, hw * 0.55, t, hw * 0.12);
    p.lineTo(t, -hw * 0.12);
    p.quadraticCurveTo(t + g.L * 0.05, -hw * 0.55, t + g.L * 0.2, -hw);
    p.lineTo(n - g.w * 1.4, -hw);
    p.quadraticCurveTo(n - 0.1, -hw, n, 0);
    p.closePath();
    return p;
  }
  function drawAircraft(x, y, ang, id, altFrac) {
    const g = AC_SHAPE[id] || AC_SHAPE.A321;
    const k = PX_PER_M;
    const shadowOff = 3 + clamp(altFrac, 0, 1) * 16; // 높이 날수록 그림자가 멀어짐
    const img = planeImgs[id];
    ctx.save();
    ctx.translate(x, y);
    if (img) {
      const len = g.L * k * 1.05, wid = len * img.width / img.height;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.save(); ctx.translate(shadowOff, shadowOff); ctx.rotate(ang + Math.PI / 2);
      ctx.globalAlpha = 0.3;
      ctx.drawImage(planeShadows[id], -wid / 2, -len / 2, wid, len); ctx.restore();
      ctx.rotate(ang + Math.PI / 2);
      ctx.drawImage(img, -wid / 2, -len / 2, wid, len);
      ctx.restore();
      return;
    }
    const body = aircraftPath(g), fus = fuselagePath(g);
    // 그림자
    ctx.save();
    ctx.translate(shadowOff, shadowOff); ctx.rotate(ang); ctx.scale(k, k);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fill(body); ctx.fill(fus);
    ctx.restore();
    ctx.rotate(ang); ctx.scale(k, k);
    const lw = 0.9 / k;
    ctx.lineJoin = 'round';
    // 날개·꼬리날개
    ctx.fillStyle = '#DDE1E7'; ctx.fill(body);
    ctx.strokeStyle = 'rgba(40,45,55,0.85)'; ctx.lineWidth = lw; ctx.stroke(body);
    // 엔진
    const xl = g.L * 0.1, hsp = g.span / 2;
    g.eng.forEach((fr) => [1, -1].forEach((sgn) => {
      const ey = sgn * hsp * fr, xle = xl - g.sweep * fr;
      const front = xle + g.el * 0.5;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(front - g.el, ey - g.ew / 2, g.el, g.ew, g.ew / 2.2) : ctx.rect(front - g.el, ey - g.ew / 2, g.el, g.ew);
      ctx.fillStyle = '#A5ADB8'; ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.rect(front - 0.6, ey - g.ew * 0.42, 0.6, g.ew * 0.84);
      ctx.fillStyle = '#2F343C'; ctx.fill();
    }));
    // 윙렛(샤크렛)
    if (g.sharklet) [1, -1].forEach((sgn) => {
      ctx.beginPath(); ctx.rect(xl - g.sweep - g.tc, sgn * hsp - 0.25, g.tc, 0.5);
      ctx.fillStyle = '#FFD43B'; ctx.fill();
    });
    // 동체
    ctx.fillStyle = '#FBFBFD'; ctx.fill(fus); ctx.stroke(fus);
    // 조종석 창
    ctx.beginPath();
    ctx.moveTo(g.L / 2 - g.w * 0.55, g.w * 0.3); ctx.lineTo(g.L / 2 - g.w * 0.95, g.w * 0.38);
    ctx.lineTo(g.L / 2 - g.w * 0.95, -g.w * 0.38); ctx.lineTo(g.L / 2 - g.w * 0.55, -g.w * 0.3); ctx.closePath();
    ctx.fillStyle = '#1F2937'; ctx.fill();
    // 수직꼬리날개(위에서 보면 가는 띠) — 항공사 색인 노랑
    ctx.beginPath();
    ctx.moveTo(-g.L / 2 + g.L * 0.2, 0.18 * g.w); ctx.lineTo(-g.L / 2 + 0.2, 0.1 * g.w);
    ctx.lineTo(-g.L / 2 + 0.2, -0.1 * g.w); ctx.lineTo(-g.L / 2 + g.L * 0.2, -0.18 * g.w); ctx.closePath();
    ctx.fillStyle = '#FFD43B'; ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // 위: 대기권 테두리, 계단식 그림자(그라데이션 없음), 확대 시 해안선·국경선, 항로·칩·비행기
  function draw(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!HAS_GEO) return;
    const tiles = tilesOn();
    const sat = builtinSat();
    const { cx, cy } = view;
    const R = apparentR();
    if (!tiles) proj.translate([cx, cy]).scale(R).rotate([-view.lon, -view.lat]);
    const limb = R < Math.hypot(W, H) * 1.2; // 공의 가장자리가 화면 근처에 있을 때만

    if (limb) { // 대기권: 두께 있는 단색 테두리 두 겹
      ctx.beginPath(); ctx.arc(cx, cy, R + 9, 0, Math.PI * 2);
      ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(130,195,255,0.16)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, R + 4, 0, Math.PI * 2);
      ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(130,195,255,0.32)'; ctx.stroke();
    }

    if (!tiles) {
      if (!sat) { // 내장 단색 지도
        ctx.beginPath(); gpath(SPHERE); ctx.fillStyle = COL.ocean; ctx.fill();
        ctx.beginPath(); gpath(GRAT); ctx.strokeStyle = COL.grat; ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); gpath(view.zoom > 3 && W50 ? W50.coast : window.WORLD_LAND); ctx.fillStyle = COL.land;
        if (!(view.zoom > 3 && W50)) ctx.fill();
        ctx.strokeStyle = COL.landEdge; ctx.lineWidth = 1; ctx.stroke();
      }
      if (W50 && view.zoom > 1.6) { // 확대하면 선명한 해안선·국경선을 덧그림
        const k = clamp((view.zoom - 1.6) / 1.5, 0, 1);
        ctx.lineWidth = 1;
        ctx.beginPath(); gpath(W50.coast);
        ctx.strokeStyle = sat ? `rgba(255,255,255,${0.45 * k})` : COL.landEdge; ctx.stroke();
        ctx.beginPath(); gpath(W50.borders);
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = sat ? `rgba(255,230,160,${0.55 * k})` : `rgba(90,120,80,${0.6 * k})`; ctx.stroke();
        ctx.setLineDash([]);
      }
      if (limb) { // 오른쪽 아래로 갈수록 한 단계씩 어두워지는 초승달 그림자
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
        [[0.07, 0.08], [0.17, 0.08], [0.32, 0.1]].forEach(([k, alpha]) => {
          ctx.beginPath();
          ctx.rect(cx - R - 2, cy - R - 2, R * 2 + 4, R * 2 + 4);
          ctx.arc(cx - R * k, cy - R * k, R, 0, Math.PI * 2, true);
          ctx.fillStyle = `rgba(5,15,40,${alpha})`;
          ctx.fill('evenodd');
        });
        ctx.restore();
      }
    }
    if (limb) {
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.stroke();
    }

    // 항로: 어두운 지도(위성) 위에서는 흰 선, 밝은 지도에서는 흰 테두리를 두른 검은 선
    const dark = sat || (tiles && mapMode() === 'satellite');
    ctx.lineCap = 'round';
    const stroke = (geom, width, dash) => {
      if (!geom) return;
      geoLine(geom);
      ctx.setLineDash(dash || []);
      if (!dark) { ctx.lineWidth = width + 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke(); }
      ctx.save();
      if (dark) { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 4; }
      ctx.lineWidth = width; ctx.strokeStyle = dark ? COL.white : COL.ink; ctx.stroke();
      ctx.restore();
      ctx.setLineDash([]);
    };
    stroke(scene.line, 3);
    stroke(scene.todo, 2.5, [8, 8]);
    stroke(scene.done, 3.5);

    drawChips(now);

    if (scene.plane) {
      const p = frontPoint(scene.plane);
      if (p) {
        const q = scene.ahead ? projectVisible(scene.ahead) : null;
        const ang = q ? Math.atan2(q[1] - p[1], q[0] - p[0]) : 0;
        drawAircraft(p[0], p[1], ang, scene.acId || 'A321', scene.altFrac || 0);
      }
    }
  }

  // 공항 칩: 고른 공항(sel)·출발 공항(here)은 노랑, 나머지는 흰색. 겹치면 덜 중요한 칩은 생략
  const chipW = new Map(); // 코드별 칩 너비 (글자 폭 재기는 한 번만)
  function drawChips(now) {
    const drawn = [];
    ctx.font = `700 13px ${FONT}`;
    // 지구 앞면 판정: 화면 가운데 지점과의 각도가 보이는 범위(cap) 안인지, 삼각함수 없이 내적으로
    const cap = tilesOn() ? mlCap - 0.01 : Math.PI / 2 - 0.02, minDot = Math.cos(cap);
    const c0 = unitVec(view.lon, view.lat);
    // 겹침 검사는 64px 격자 칸에 나눠 담아서, 가까운 칸의 칩과만 비교
    const G = 64, grid = new Map();
    const cells = (r, fn) => { for (let gx = Math.floor((r.x - 4) / G); gx <= Math.floor((r.x + r.w + 4) / G); gx++) for (let gy = Math.floor((r.y - 4) / G); gy <= Math.floor((r.y + r.h + 4) / G); gy++) fn(gx + ',' + gy); };
    for (const c of scene.chips) {
      const v = c.v || (c.v = unitVec(c.at[0], c.at[1]));
      if (v[0] * c0[0] + v[1] * c0[1] + v[2] * c0[2] < minDot) continue; // 지구 뒤편
      const p = frontPoint(c.at);
      if (!p) continue;
      let w = chipW.get(c.code);
      if (w === undefined) { w = ctx.measureText(c.code).width + 40; chipW.set(c.code, w); }
      const h = 30, rect = { x: p[0] - w / 2, y: p[1] - h / 2, w, h };
      let hit = false;
      cells(rect, (k) => { if (!hit) { const l = grid.get(k); if (l && l.some((q) => rect.x < q.x + q.w + 4 && q.x < rect.x + rect.w + 4 && rect.y < q.y + q.h + 4 && q.y < rect.y + rect.h + 4)) hit = true; } });
      if (hit) continue;
      cells(rect, (k) => { const l = grid.get(k); if (l) l.push(rect); else grid.set(k, [rect]); });
      drawn.push({ c, rect });
    }
    for (let i = drawn.length - 1; i >= 0; i--) {
      const { c, rect } = drawn[i];
      const hot = c.kind === 'sel' || c.kind === 'here';
      ctx.save();
      // 방금 고른 칩은 살짝 튀어나왔다가 제자리로
      if (scene.pop && scene.pop.code === c.code && now) {
        const t = clamp((now - scene.pop.t0) / 420, 0, 1);
        const sc = 1 + 0.35 * Math.sin(t * Math.PI) * (1 - t);
        ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2); ctx.scale(sc, sc); ctx.translate(-(rect.x + rect.w / 2), -(rect.y + rect.h / 2));
      }
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
      roundRect(rect.x, rect.y, rect.w, rect.h, 9);
      ctx.fillStyle = hot ? COL.yellow : 'rgba(255,255,255,0.94)'; ctx.fill();
      ctx.restore();
      if (c.kind === 'sel') {
        roundRect(rect.x, rect.y, rect.w, rect.h, 9);
        ctx.lineWidth = 2.5; ctx.strokeStyle = COL.ink; ctx.stroke();
      }
      const landing = c.kind === 'sel' && step !== 'home' || c.kind === 'cand';
      planePath(rect.x + 15, rect.y + rect.h / 2, landing ? 0.45 : -0.45, 0.6);
      ctx.fillStyle = hot ? COL.ink : '#55555C'; ctx.fill();
      ctx.fillStyle = hot ? COL.ink : '#3A3A40';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.code, rect.x + 27, rect.y + rect.h / 2 + 1);
      ctx.restore();
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
  // 항로에 맞춰 조금 확대하되, 공의 가장자리가 보이도록 1.4배까지만 (더 보려면 직접 확대)
  const routeZoom = (ext) => clamp(0.7 / Math.sin(clamp(ext, 0.004, Math.PI / 2)), 1, 1.4);
  let zoomMul = 1; // 사용자가 손가락·휠·버튼으로 바꾼 배율

  // 확대·축소 한계: 비행 중에는 지구 전체가 보일 때까지 축소할 수 있음
  const flightMinZoom = () => 0.34 * Math.min(W, H) / (Math.hypot(W, H) + 40);
  const minZoom = () => (step === 'flight' ? flightMinZoom() : 0.4);
  let flightBase = 1; // 비행 중 기본 배율 (사용자 배율 zoomMul을 곱하기 전)
  const mulRange = (m) => clamp(m, step === 'flight' ? flightMinZoom() / flightBase : 0.4, maxZoom() / 2);
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
        zoom = routeZoom(d3.geoDistance(A, B) / 2);
      }
    } else if (s === 'flight' && flight) {
      const A = lonlat(AP[flight.from]), B = lonlat(AP[flight.to]);
      const p = progressOf(flight, Date.now());
      center = d3.geoInterpolate(A, B)(profileOf(flight).frac(p));
      const dist = Math.min(d3.geoDistance(A, B), Math.PI / 2);
      zoom = clamp((slot.area * 0.42) / (slot.r * Math.sin(Math.max(dist, 0.004))), 0.15, 30);
      flightBase = zoom;
    } else if (s === 'arrive' && lastEntry && AP[lastEntry.to]) {
      center = lonlat(AP[lastEntry.to]);
    } else if (s === 'home') {
      center = lonlat(AP[homeSel]);
    }
    return Object.assign(slot, { lon: center[0], lat: center[1], zoom: clamp(zoom * zoomMul, s === 'flight' ? flightMinZoom() : 0.15, maxZoom()) });
  }

  function updateScene() {
    scene.chips = []; scene.line = scene.done = scene.todo = scene.plane = scene.ahead = null;
    const chip = (code, kind) => ({ code, kind, at: lonlat(AP[code]) });
    if (step === 'home') {
      scene.chips = [chip(homeSel, 'sel')].concat(AIRPORTS.filter((a) => a.code !== homeSel).map((a) => chip(a.code, 'plain')));
    } else if (step === 'time') {
      scene.chips = [chip(depCode, 'here')];
    } else if (step === 'route') {
      const x = selected();
      const pool = hasQuery($('dest-q')) ? searchRows : routes(); // 검색 중이면 검색 결과를 지구본에 표시
      const cands = pool.slice(0, 16).filter((r) => !x || r.a.code !== x.a.code).map((r) => chip(r.a.code, 'cand'));
      scene.chips = (x ? [chip(x.a.code, 'sel')] : []).concat([chip(depCode, 'here')], cands);
      if (x) scene.line = { type: 'LineString', coordinates: [lonlat(AP[depCode]), lonlat(x.a)] };
    } else if (step === 'flight' && flight) {
      scene.chips = [chip(flight.to, 'sel'), chip(flight.from, 'here')];
      const ac = ACMAP[flight.aircraft];
      scene.size = ac.size; scene.engines = ac.engines; scene.acId = ac.id;
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
    scene.altFrac = profileOf(flight).alt(progressOf(flight, Date.now())) / 41000;
  }

  // 지구본: 한 손가락(마우스)으로 돌리기, 두 손가락·휠·버튼으로 확대·축소, 공항 칩 누르기
  let gdrag = null, pinch = null;
  const pts = new Map();
  const canTouchGlobe = () => ['home', 'time', 'route', 'flight', 'arrive'].includes(step);
  const canZoom = () => HAS_GEO && step !== 'pass' && step !== 'log';
  function zoomBy(f) {
    if (!canZoom()) return;
    zoomMul = mulRange(zoomMul * f);
    if (step === 'flight' && following) { follow(viewFor('flight', dockRect())); return; }
    if (tween) { tween.to.zoom = clamp(tween.to.zoom * f, minZoom(), maxZoom()); return; }
    view.zoom = clamp(view.zoom * f, minZoom(), maxZoom());
    kick();
  }
  cv.addEventListener('pointerdown', (e) => {
    if (!canZoom()) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cv.setPointerCapture(e.pointerId);
    if (pts.size === 2) {
      const [p1, p2] = [...pts.values()];
      pinch = { d: Math.hypot(p1.x - p2.x, p1.y - p2.y) };
      gdrag = null;
      return;
    }
    if (canTouchGlobe()) gdrag = { x: e.clientX, y: e.clientY, lon: view.lon, lat: view.lat, moved: false };
  });
  cv.addEventListener('pointermove', (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const [p1, p2] = [...pts.values()];
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (pinch.d > 0) zoomBy(d / pinch.d);
      pinch.d = d;
      return;
    }
    if (!gdrag) {
      cv.style.cursor = canTouchGlobe() ? (chipAt(e.clientX, e.clientY) ? 'pointer' : 'grab') : 'default';
      return;
    }
    const dx = e.clientX - gdrag.x, dy = e.clientY - gdrag.y;
    if (!gdrag.moved && Math.hypot(dx, dy) < 6) return;
    if (!gdrag.moved && step === 'flight' && following) setFollowing(false); // 손으로 움직이면 따라가기를 멈춤
    gdrag.moved = true;
    tween = null;
    const k = 180 / Math.PI / (tilesOn() ? worldR() : view.r * view.zoom);
    view.lon = gdrag.lon - dx * k;
    view.lat = clamp(gdrag.lat + dy * k, -80, 80);
    kick();
  });
  const endPointer = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2 && pinch) { pinch = null; kick(); } // 손을 떼면 한 번 더 그려서 위성 사진을 또렷하게
    if (!gdrag) return;
    if (gdrag.moved) kick();
    const tap = !gdrag.moved && e.type === 'pointerup';
    gdrag = null;
    if (tap) { const hit = chipAt(e.clientX, e.clientY); if (hit) onChipTap(hit.code); }
  };
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);
  cv.addEventListener('wheel', (e) => {
    if (!canZoom()) return;
    e.preventDefault();
    zoomBy(Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  // 지도 종류(일반·위성·지형) 메뉴: 버튼 옆에 톡 나타남
  function renderMapMenu() {
    document.querySelectorAll('[data-map]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.map === mapMode())));
  }
  function placeMapMenu() {
    const r = $('map-btn').getBoundingClientRect(), m = $('map-menu');
    const mw = m.offsetWidth || 240, mh = m.offsetHeight || 90;
    const left = r.left + r.width / 2 < W / 2 ? r.right + 10 : r.left - 10 - mw;
    m.style.left = clamp(left, 8, W - mw - 8) + 'px';
    m.style.top = clamp(r.top + r.height / 2 - mh / 2, 8, H - mh - 8) + 'px';
  }
  function toggleMapMenu(force) {
    const m = $('map-menu');
    const open = force !== undefined ? force : m.hidden;
    $('map-btn').setAttribute('aria-expanded', String(open));
    if (open) { renderMapMenu(); m.hidden = false; placeMapMenu(); m.hidden = true; showEl(m, { opacity: 0, transform: 'scale(0.9)' }); }
    else hideEl(m, { opacity: 0, transform: 'scale(0.9)' });
  }
  $('map-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMapMenu(); });
  $('map-menu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-map]');
    if (!b) return;
    setMapMode(b.dataset.map);
    setTimeout(() => toggleMapMenu(false), 250);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('map-menu').hidden && !e.target.closest('#map-menu') && !e.target.closest('#map-btn')) toggleMapMenu(false);
  });

  $('zoom-in').addEventListener('click', () => zoomSmooth(1.8));
  $('zoom-out').addEventListener('click', () => zoomSmooth(1 / 1.8));
  // 버튼 확대는 한 번에 바뀌지 않고 부드럽게
  function zoomSmooth(f) {
    if (!canZoom()) return;
    zoomMul = mulRange(zoomMul * f);
    if (step === 'flight' && following) { flyTo(viewFor('flight', dockRect()), 450); return; }
    const target = Object.assign({}, tween ? tween.to : view);
    target.zoom = clamp(target.zoom * f, minZoom(), maxZoom());
    flyTo(target, 450);
  }
  // 비행 중 지도를 손으로 옮기면 따라가기가 꺼지고, 이 버튼을 누르면 다시 비행기를 따라감 (실제 지도 앱처럼)
  let following = true;
  function setFollowing(on) {
    following = on;
    const b = $('btn-follow');
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? '비행기를 따라가는 중' : '비행기 따라가기');
  }
  $('btn-follow').addEventListener('click', () => {
    if (step !== 'flight' || !flight) return;
    if (!following) { // 지금 확대 배율은 그대로 두고 비행기 쪽으로 돌아감
      zoomMul = 1;
      const base = viewFor('flight', dockRect()).zoom;
      zoomMul = mulRange(view.zoom / base);
    }
    setFollowing(true);
    flyTo(viewFor('flight', dockRect()), 800);
  });
  const chipAt = (x, y) => chipHits.find((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);
  function onChipTap(code) {
    if (step === 'home') selectHome(code);
    else if (step === 'route' && code !== depCode) selectDest(code);
  }

  // ---------- 화면 단계: 흰 박스가 모양을 바꾸며 이동 ----------
  const dock = $('dock');
  const PANES = [...document.querySelectorAll('.pane')];
  let morphUntil = 0;
  let lastDock = null;
  // 박스가 모양을 바꾸는 중에는 움직이는 도중의 크기가 아니라 도착할 자리를 기준으로 삼음 (지구본이 흔들리지 않게)
  const dockRect = () => (lastDock && performance.now() < morphUntil ? lastDock : dock.getBoundingClientRect());

  function go(next, instant, slow) {
    if (!$('map-menu').hidden) toggleMapMenu(false);
    if (!$('home-search').hidden) { $('home-search').hidden = true; $('btn-search').setAttribute('aria-expanded', 'false'); }
    zoomMul = 1;
    setFollowing(true);
    if (next !== 'route' && $('dest-q').value) { $('dest-q').value = ''; $('dest-q-x').hidden = true; } // 경로 화면을 떠나면 도착지 검색어는 비움
    closeDrawers();
    const first = dock.getBoundingClientRect();
    const cs1 = getComputedStyle(dock);
    const r1 = [cs1.borderTopLeftRadius, cs1.borderTopRightRadius, cs1.borderBottomRightRadius, cs1.borderBottomLeftRadius].join(' ');
    if (next !== 'pass') dock.classList.remove('cut');
    if (step === 'pass' && next !== 'pass' && !boarding) resetTear(); // 찢다 만 탑승권 조각 치우기
    const bg1 = cs1.backgroundColor, rad1 = r1;
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
      const r2 = [cs2.borderTopLeftRadius, cs2.borderTopRightRadius, cs2.borderBottomRightRadius, cs2.borderBottomLeftRadius].join(' ');
      dock.animate([box(first, bg1, rad1), box(last, cs2.backgroundColor, r2)],
        { duration: slow ? 1100 : 640, easing: 'cubic-bezier(.2,.8,.2,1)' });
      const pane = PANES.find((p) => !p.hidden);
      if (pane) pane.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }],
        { duration: slow ? 600 : 380, delay: slow ? 500 : 220, easing: 'ease-out', fill: 'backwards' });
      morphUntil = performance.now() + (slow ? 1200 : 700);
    }
    updateScene();
    flyTo(viewFor(next, last), instant ? 0 : slow ? 2200 : 860);
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
      if (step === 'flight' && !following) return; // 손으로 옮겨 둔 지도는 그대로
      if (step === 'pass') return; // 탑승권을 찢을 때 박스가 줄어도 지구본은 그대로
      flyTo(viewFor(step, r), 320);
    }).observe(dock);
  }
  window.addEventListener('resize', () => {
    resizeCanvas();
    const r = dock.getBoundingClientRect();
    lastDock = r;
    if (step === 'flight' && !following) { kick(); return; }
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
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (!$('airport-modal').hidden) closeAirportModal();
    else if (!$('subject-sheet').hidden) closeSheet();
    else back();
  });

  // ---------- 모션 도우미: 바뀌는 모든 것에 짧은 움직임 ----------
  // 글자가 바뀔 때 아래에서 올라오며 나타남
  function setText(el, text) {
    if (typeof el === 'string') el = $(el);
    if (!el || el.textContent === String(text)) return;
    el.textContent = text;
    if (!REDUCED && el.animate) el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  function setHTML(el, html) {
    if (typeof el === 'string') el = $(el);
    if (!el || el.innerHTML === html) return;
    el.innerHTML = html;
    if (!REDUCED && el.animate) el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  // 나타나기·사라지기 (hidden 속성을 쓰되 애니메이션을 곁들임)
  function showEl(el, from) {
    if (typeof el === 'string') el = $(el);
    if (!el.hidden) return;
    el.hidden = false;
    if (!REDUCED && el.animate) el.animate([from || { opacity: 0, transform: 'translateY(10px) scale(0.98)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  function hideEl(el, to) {
    if (typeof el === 'string') el = $(el);
    if (el.hidden) return Promise.resolve();
    if (REDUCED || !el.animate) { el.hidden = true; return Promise.resolve(); }
    const a = el.animate([{ opacity: 1, transform: 'none' }, to || { opacity: 0, transform: 'translateY(10px) scale(0.98)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
    return a.finished.then(() => { el.hidden = true; a.cancel(); }, () => { el.hidden = true; });
  }

  // ---------- 알림 토스트 ----------
  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    if (el.hidden) showEl(el, { opacity: 0, transform: 'translate(-50%, -12px)' });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hideEl(el, { opacity: 0, transform: 'translate(-50%, -12px)' }), 3400);
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
    homeSel = loc;
    const h = new Date().getHours();
    $('greet-hi').textContent = h < 5 ? '늦은 밤이에요' : h < 11 ? '좋은 아침이에요' : h < 17 ? '좋은 오후예요' : h < 22 ? '좋은 저녁이에요' : '늦은 밤이에요';
    renderHomeLoc(false);
    const today = dayKey(new Date());
    const todayMin = log.filter((e) => dayKey(new Date(e.landedAt || e.date)) === today).reduce((s, e) => s + (e.focusedMin || 0), 0);
    $('g-today').textContent = `오늘 ${fmtDur(todayMin)} 집중`;
    $('g-streak').textContent = `연속 ${streaks().current}일`;
    fillAircraft();
    $('plane-pill').textContent = `${acShort(prefs.aircraft)} · ${fmtNum(totalMiles())} mi`;
  }
  // 왼쪽 위 위치와 아래 버튼: 지금 고른(노란) 공항을 이름과 코드로 보여 줌
  function renderHomeLoc(animate) {
    const a = AP[homeSel];
    const put = animate ? setText : (id, t) => { $(id).textContent = t; };
    put('greet-loc', `${a.city}, ${a.country}`);
    put('journey-label', `${a.city}(${a.code})에서 여정 시작`);
  }
  // 공항 칩을 누르면: 그 공항이 노랗게 되고 지구본이 그쪽으로 돌아감 (확인은 출발 버튼에서)
  function selectHome(code) {
    homeSel = code;
    scene.pop = { code, t0: performance.now() };
    updateScene();
    flyTo(viewFor('home', dockRect()), 900);
    renderHomeLoc(true);
  }
  $('btn-journey').addEventListener('click', () => openAirportModal(homeSel));

  // 처음 화면 공항 검색: 고르면 그 공항이 노랗게 되고 지구본이 그쪽으로 돌아감 (확인은 출발 버튼에서)
  const HS_ANIM = { opacity: 0, transform: 'translateY(-10px)' };
  function openHomeSearch() {
    $('home-q').value = '';
    renderHomeResults();
    showEl('home-search', HS_ANIM);
    $('btn-search').setAttribute('aria-expanded', 'true');
    $('home-q').focus();
  }
  function closeHomeSearch() {
    if ($('home-search').hidden) return;
    hideEl('home-search', HS_ANIM);
    $('btn-search').setAttribute('aria-expanded', 'false');
  }
  function renderHomeResults() {
    const q = $('home-q').value;
    if (!hasQuery($('home-q'))) {
      $('home-results').innerHTML = `<p class="sr-empty">도시 이름(도쿄), 영어(tokyo), 공항 코드(NRT), 나라(일본), 초성(ㄷㅋ)으로 찾아요. 지금 ${AIRPORTS.length}곳이 있어요.</p>`;
      return;
    }
    const rs = searchAirports(q).slice(0, 30);
    $('home-results').innerHTML = rs.length ? rs.map(({ a }) => `<button type="button" class="sr" role="option" data-code="${a.code}" aria-selected="${a.code === homeSel}">
        <span class="ychip">${a.code}</span><span class="sr-city"><b>${esc(a.city)}</b><small>${esc(a.country)} · ${esc(a.en)}${a.code === loc ? ' · 현재 위치' : ` · 여기서 ${fmtKm(distanceKm(AP[loc], a))}`}</small></span></button>`).join('')
      : '<p class="sr-empty">찾는 공항이 없어요. 도시 이름, 공항 코드(예: NRT), 나라 이름이나 초성(예: ㅇㅊ)으로 찾아 보세요.</p>';
  }
  function pickHomeFromSearch(code) { closeHomeSearch(); selectHome(code); }
  $('btn-search').addEventListener('click', () => ($('home-search').hidden ? openHomeSearch() : closeHomeSearch()));
  $('home-q').addEventListener('input', renderHomeResults);
  $('home-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = $('home-results').querySelector('.sr'); if (first) pickHomeFromSearch(first.dataset.code); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeHomeSearch(); }
  });
  $('home-q-x').addEventListener('click', closeHomeSearch);
  $('home-results').addEventListener('click', (e) => { const b = e.target.closest('.sr'); if (b) pickHomeFromSearch(b.dataset.code); });
  document.addEventListener('pointerdown', (e) => { // 바깥을 누르면 닫힘
    if (!$('home-search').hidden && !e.target.closest('#home-search') && !e.target.closest('#btn-search')) closeHomeSearch();
  });
  $('btn-log').addEventListener('click', () => go('log'));

  // 전체 화면 + (휴대폰이면) 가로 고정. 안 되는 환경이면 안내만 함
  const root = document.documentElement;
  const canFull = !!(root.requestFullscreen || root.webkitRequestFullscreen);
  if (!canFull) $('btn-full').hidden = true;
  $('btn-full').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        return;
      }
      await (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
      if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    } catch (e) {
      toast('여기서는 전체 화면을 쓸 수 없어요. 링크를 브라우저에서 열어 주세요.');
    }
  });

  // 공항 확인 모달
  let modalCode = null;
  function openAirportModal(code) {
    modalCode = code;
    const a = AP[code];
    $('am-code').textContent = a.code;
    $('am-name').textContent = a.city;
    $('am-country').textContent = a.country;
    $('am-q').textContent = `${a.city}(${a.code}) 공항에서 여정을 시작하시겠습니까?`;
    showEl('airport-modal', { opacity: 0 });
    $('am-ok').focus();
  }
  function closeAirportModal() { hideEl('airport-modal', { opacity: 0 }); modalCode = null; }
  $('am-close').addEventListener('click', closeAirportModal);
  $('am-cancel').addEventListener('click', closeAirportModal);
  $('airport-modal').addEventListener('click', (e) => { if (e.target === $('airport-modal')) closeAirportModal(); });
  $('am-ok').addEventListener('click', () => {
    if (!modalCode) return;
    loc = depCode = homeSel = modalCode; store.set('loc', loc);
    closeAirportModal();
    go('time');
  });

  // ---------- 룰렛 휠: 목록을 위아래로 굴려 가운데 칸을 고름 ----------
  function makeWheel(el, label, onChange) {
    el.setAttribute('role', 'listbox');
    el.setAttribute('aria-label', label);
    el.tabIndex = 0;
    el.innerHTML = '<div class="wheel-band"></div><ul class="wheel-list"></ul>';
    const list = el.querySelector('.wheel-list');
    const w = { items: [], idx: 0 };
    let lis = [];
    const rowH = () => 44; // 칸 높이는 CSS에서 44px로 고정 (재면 수백 칸 목록의 배치를 매번 다시 계산해서 느려짐)
    // 보이는 칸(가운데 ±6칸)만 다시 계산: 항목이 수백 개여도 굴릴 때 가벼움
    let painted = [];
    function paint() {
      const c = list.scrollTop / rowH();
      const lo = Math.max(0, Math.floor(c) - 6), hi = Math.min(lis.length - 1, Math.ceil(c) + 6);
      painted.forEach((i) => { if ((i < lo || i > hi) && lis[i]) lis[i].classList.remove('on'); });
      painted = [];
      for (let i = lo; i <= hi; i++) {
        const li = lis[i], d = i - c, ad = Math.min(Math.abs(d), 3);
        li.style.transform = `perspective(500px) rotateX(${(-d * 20).toFixed(1)}deg) scale(${(1 - ad * 0.07).toFixed(3)})`;
        li.classList.toggle('on', Math.abs(d) < 0.5);
        painted.push(i);
      }
    }
    const scrollToIdx = (i, smooth) => list.scrollTo({ top: i * rowH(), behavior: smooth && !REDUCED ? 'smooth' : 'auto' });
    function mark(i) {
      lis.forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
      if (lis[i]) el.setAttribute('aria-activedescendant', lis[i].id);
    }
    // 굴리는 동안 가운데 칸이 바뀔 때마다 바로 반영
    list.addEventListener('scroll', () => {
      paint();
      const i = clamp(Math.round(list.scrollTop / rowH()), 0, w.items.length - 1);
      if (i === w.idx) return;
      w.idx = i; mark(i);
      onChange(w.items[i].v);
    }, { passive: true });
    list.addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) scrollToIdx(+li.dataset.i, true); });
    el.addEventListener('keydown', (e) => {
      const d = { ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 }[e.key];
      if (d) { e.preventDefault(); scrollToIdx(clamp(w.idx + d, 0, w.items.length - 1), true); }
    });
    w.setItems = (items, value) => {
      w.items = items;
      list.innerHTML = items.map((it, i) => `<li role="option" id="${el.id}-o${i}" data-i="${i}">${it.t}</li>`).join('');
      lis = [...list.children];
      painted = [];
      w.set(value);
    };
    w.set = (value) => {
      w.idx = Math.max(0, w.items.findIndex((it) => it.v === value));
      scrollToIdx(w.idx, false); paint(); mark(w.idx);
    };
    return w;
  }

  // 펼쳐지는 휠 서랍 (한 번에 하나만 열림)
  let openDrawer = null;
  function closeDrawers() {
    const dq = $('dep-q');
    if (dq && dq.value) { dq.value = ''; renderDepResults(); }
    document.querySelectorAll('.wheel-drawer.open').forEach((d) => {
      d.classList.remove('open');
      // 접히는 움직임이 끝나면 안쪽 목록(공항 1,000칸 등)은 배치 계산을 건너뛰게 재움
      setTimeout(() => { if (!d.classList.contains('open')) d.classList.add('asleep'); }, 450);
    });
    document.querySelectorAll('[aria-controls^="wd-"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    openDrawer = null;
  }
  function toggleDrawer(id, btn, wheel, value) {
    const willOpen = openDrawer !== id;
    closeDrawers();
    if (!willOpen) return;
    $(id).classList.remove('asleep');
    $(id).classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    openDrawer = id;
    wheel.set(value());
    $(id).querySelector('.wheel').focus({ preventScroll: true });
  }

  // ---------- 1. 소요 시간: ( )h ( )m, 누르면 휠이 펼쳐짐 ----------
  const wheelH = makeWheel($('wheel-h'), '시간', (v) => setHM(v, null));
  const wheelM = makeWheel($('wheel-m'), '분', (v) => setHM(null, v));
  wheelH.setItems(Array.from({ length: 16 }, (_, i) => ({ v: i, t: String(i) })), Math.floor(prefs.minutes / 60));
  wheelM.setItems(Array.from({ length: 12 }, (_, i) => ({ v: i * 5, t: pad(i * 5) })), prefs.minutes % 60);
  function setHM(h, m) {
    const h0 = Math.floor(prefs.minutes / 60), m0 = prefs.minutes % 60;
    prefs.minutes = (h === null ? h0 : h) * 60 + (m === null ? m0 : m); // 0시간 0분이면 다음 버튼만 막음
    savePrefs();
    renderTimeText();
  }
  function renderTimeText() {
    const m = prefs.minutes;
    setText('hm-h-val', String(Math.floor(m / 60)));
    setText('hm-m-val', pad(m % 60));
    document.querySelectorAll('[data-quick]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.quick) === m)));
    $('btn-to-route').disabled = m <= 0;
    if (m <= 0) { setHTML('time-best', '<span class="hint">0시간 0분으로는 떠날 수 없어요. 시간을 골라 주세요.</span>'); return; }
    const best = routes()[0];
    setHTML('time-best', best
      ? `<span><span class="hint">가장 가까운 항공편</span><br><b>${depCode} → ${best.a.code}</b> ${esc(best.a.city)}</span><span class="ychip">${fmtHm(best.min)}</span>`
      : '');
  }
  function renderTime() {
    renderTimeText();
    wheelH.set(Math.floor(prefs.minutes / 60));
    wheelM.set(prefs.minutes % 60);
  }
  function setMinutes(m) {
    prefs.minutes = clamp(Math.round(m / 5) * 5, 5, 15 * 60 + 55);
    savePrefs();
    renderTime();
  }
  $('hm-h').addEventListener('click', () => toggleDrawer('wd-h', $('hm-h'), wheelH, () => Math.floor(prefs.minutes / 60)));
  $('hm-m').addEventListener('click', () => toggleDrawer('wd-m', $('hm-m'), wheelM, () => prefs.minutes % 60));
  document.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => setMinutes(Number(b.dataset.quick))));
  $('btn-to-route').addEventListener('click', () => { if (prefs.minutes > 0) go('route'); });

  // ---------- 2. 출발지 / 도착지 ----------
  // 출발지에서 모든 공항까지 거리는 출발지가 바뀔 때만 계산하고, 정렬 결과는 출발지·시간이 같으면 다시 씀
  let legsDep = '', legs = [], routesKey = '', routesCache = [];
  function routes() {
    if (legsDep !== depCode) {
      const d = AP[depCode];
      legs = AIRPORTS.filter((a) => a.code !== depCode)
        .map((a) => { const km = distanceKm(d, a); return { a, km, min: realMinutes(km) }; })
        .filter((x) => x.km >= 60); // 인천–김포처럼 너무 가까운 구간은 제외
      legsDep = depCode; routesKey = '';
    }
    const key = depCode + ':' + prefs.minutes;
    if (key !== routesKey) {
      routesCache = legs.map((x) => Object.assign({}, x, { diff: x.min - prefs.minutes }))
        .sort((x, y) => Math.abs(x.diff) - Math.abs(y.diff) || x.km - y.km);
      routesKey = key;
    }
    return routesCache;
  }
  const SUGGEST_MAX_DIFF = 180; // 정한 시간과 3시간 넘게 차이 나는 곳은 목록에 제안하지 않음 (검색하면 찾을 수 있음)
  const selected = () => (sel.to ? routes().find((x) => x.a.code === sel.to) || null : null);
  function pickBest() {
    const rs = routes();
    sel.to = rs.length ? rs[0].a.code : null;
    sel.mode = 'real';
  }

  function fillStatic() {
    $('subjects').innerHTML = SUBJECTS.map((s) =>
      `<button type="button" class="subject" data-subject="${s.n}" style="background:${s.c}"><span class="emo" aria-hidden="true">${s.e}</span>${s.n}</button>`
    ).join('');
    $('subject-custom').value = prefs.custom;
    wheelDep.setItems(AIRPORTS.map((a) => ({ v: a.code, t: `<b>${a.code}</b> ${esc(a.city)} <small>${esc(a.country)}</small>` })), depCode);
  }

  const wheelDep = makeWheel($('wheel-dep'), '출발 공항', (code) => setDep(code));
  function setDep(code) {
    if (code === depCode) return;
    depCode = loc = code; store.set('loc', loc);
    pickBest(); selKey = depCode + ':' + prefs.minutes; showFar = false;
    renderRoute(); updateScene();
    flyTo(viewFor('route', dockRect()), 800);
  }

  // ---------- 공항 검색: 도시·영어 이름·코드·나라, 한글 초성(ㅇㅊ → 인천)도 됨 ----------
  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const chosung = (str) => [...str].map((ch) => {
    const c = ch.charCodeAt(0) - 0xAC00;
    return c >= 0 && c <= 11171 ? CHO[Math.floor(c / 588)] : ch;
  }).join('');
  const norm = (str) => String(str).toLowerCase().replace(/[\s·().,'-]/g, '');
  const SEARCH = AIRPORTS.map((a) => ({
    a, code: a.code.toLowerCase(), city: norm(a.city), text: norm(a.city + a.en + a.country + a.region),
    cityCho: chosung(norm(a.city)), cho: chosung(norm(a.city + a.country)),
  }));
  // 점수가 낮을수록 먼저: 코드 일치 → 도시 이름이 그 글자로 시작 → 코드가 그 글자로 시작 → 어디든 포함
  function searchAirports(q) {
    const n = norm(q);
    if (!n) return [];
    const cho = /^[ㄱ-ㅎ]+$/.test(n);
    const out = [];
    for (const it of SEARCH) {
      let score = -1;
      if (cho) score = it.cityCho.startsWith(n) ? 1 : it.cho.includes(n) ? 3 : -1;
      else if (it.code === n) score = 0;
      else if (it.city.startsWith(n)) score = 1;
      else if (it.code.startsWith(n)) score = 2;
      else if (it.text.includes(n)) score = 3;
      if (score >= 0) out.push({ a: it.a, score });
    }
    return out.sort((x, y) => x.score - y.score);
  }
  const hasQuery = (el) => !!norm(el.value);

  // 출발지 검색: 글자를 넣으면 휠 대신 결과 목록, 누르면 그 공항으로 바꾸고 서랍을 닫음
  function renderDepResults() {
    const on = hasQuery($('dep-q'));
    $('dep-q-x').hidden = !$('dep-q').value;
    $('wheel-dep').hidden = on;
    $('dep-results').hidden = !on;
    if (!on) { if (openDrawer === 'wd-dep') wheelDep.set(depCode); return; }
    const rs = searchAirports($('dep-q').value).slice(0, 12);
    $('dep-results').innerHTML = rs.length ? rs.map(({ a }) => `<button type="button" class="sr" role="option" data-code="${a.code}">
        <span class="ychip">${a.code}</span><span class="sr-city"><b>${esc(a.city)}</b><small>${esc(a.country)} · ${esc(a.en)}</small></span></button>`).join('')
      : '<p class="sr-empty">찾는 공항이 없어요. 도시 이름, 공항 코드(예: NRT), 나라 이름이나 초성(예: ㅇㅊ)으로 찾아 보세요.</p>';
  }
  function pickDepFromSearch(code) {
    setDep(code);
    closeDrawers();
    toast(`출발지를 ${AP[code].city}(${code})${euro(AP[code].city)} 바꿨어요.`);
  }
  $('dep-q').addEventListener('input', renderDepResults);
  $('dep-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = $('dep-results').querySelector('.sr'); if (first) pickDepFromSearch(first.dataset.code); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('dep-q').value = ''; renderDepResults(); }
  });
  $('dep-q-x').addEventListener('click', () => { $('dep-q').value = ''; renderDepResults(); $('dep-q').focus(); });
  $('dep-results').addEventListener('click', (e) => { const b = e.target.closest('.sr'); if (b) pickDepFromSearch(b.dataset.code); });

  // 도착지 검색: 목록을 검색 결과로 바꿔 보여 줌 (고르는 건 평소처럼 줄을 누름)
  $('dest-q').addEventListener('input', () => { $('dest-q-x').hidden = !$('dest-q').value; renderRoute(); updateScene(); $('cards').scrollTop = 0; });
  $('dest-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = $('cards').querySelector('.dest'); if (first) { selectDest(first.dataset.code); $('dest-q').blur(); } }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('dest-q').value = ''; $('dest-q-x').hidden = true; renderRoute(); updateScene(); }
  });
  $('dest-q-x').addEventListener('click', () => { $('dest-q').value = ''; $('dest-q-x').hidden = true; renderRoute(); updateScene(); $('dest-q').focus(); });
  const wheelAc = makeWheel($('wheel-ac'), '기종', (id) => {
    const ac = ACMAP[id];
    if (ac.miles > totalMiles()) { // 잠긴 기종에서 멈추면 원래 기종으로 되돌림
      toast(`${acShort(id)}은(는) ${fmtNum(ac.miles)}마일부터 탈 수 있어요.`);
      setTimeout(() => wheelAc.set(prefs.aircraft), 350);
      return;
    }
    prefs.aircraft = id; savePrefs();
    setText('ac-name', '✈ ' + acShort(id));
  });
  function fillAircraft() {
    const miles = totalMiles();
    const own = unlocked(miles);
    if (!own.some((a) => a.id === prefs.aircraft)) prefs.aircraft = own[own.length - 1].id;
    wheelAc.setItems(AIRCRAFT.map((a) => ({
      v: a.id,
      t: a.miles <= miles ? esc(acShort(a.id)) : `<span class="locked">🔒 ${esc(acShort(a.id))} <small>${fmtNum(a.miles)}mi</small></span>`,
    })), prefs.aircraft);
    setText('ac-name', '✈ ' + acShort(prefs.aircraft));
    const next = AIRCRAFT.find((a) => a.miles > miles);
    $('ac-next').textContent = next ? `다음 기종 ${acShort(next.id)}까지 ${fmtNum(next.miles - miles)}mi` : '모든 기종을 모았어요!';
  }
  $('od-dep').addEventListener('click', () => toggleDrawer('wd-dep', $('od-dep'), wheelDep, () => depCode));
  $('ac-btn').addEventListener('click', () => toggleDrawer('wd-ac', $('ac-btn'), wheelAc, () => prefs.aircraft));

  // 도착지: 한 줄에 하나씩, 정한 시간과의 차이로 묶어서 보여 줌
  let showFar = false, lastCards = '', lastCardsSearch = false, searchRows = [];
  function destRow(x) {
    const exact = Math.abs(x.diff) <= 5;
    const diff = exact ? '딱 맞아요' : `${x.diff > 0 ? '+' : '−'}${fmtDur(Math.abs(x.diff))}`;
    return `<button type="button" class="dest" role="option" data-code="${x.a.code}" aria-selected="${sel.to === x.a.code}">
      <span class="ychip">${x.a.code}</span>
      <span class="dest-city"><b>${esc(x.a.city)}</b><small>${esc(x.a.country)} · ${fmtKm(x.km)}</small></span>
      <span class="dest-time"><b>${fmtHm(x.min)}</b><small${exact ? ' class="exact"' : ''}>${diff}</small></span>
    </button>`;
  }
  function renderRoute() {
    const key = depCode + ':' + prefs.minutes;
    if (key !== selKey || !selected()) { pickBest(); selKey = key; showFar = false; }
    setText('dep-name', `${depCode} · ${AP[depCode].city}`);
    if (openDrawer === 'wd-dep') wheelDep.set(depCode); // 닫혀 있으면 열 때 맞춤 (닫힌 목록까지 배치 계산하지 않게)
    setText('btn-change-time', fmtHHMM(prefs.minutes));
    fillAircraft();
    const rs = routes();
    const near1 = rs.filter((x) => Math.abs(x.diff) <= 10);
    const near2 = rs.filter((x) => Math.abs(x.diff) > 10 && Math.abs(x.diff) <= 45);
    const far = rs.filter((x) => Math.abs(x.diff) > 45 && Math.abs(x.diff) <= SUGGEST_MAX_DIFF);
    const beyond = rs.length - near1.length - near2.length - far.length; // 3시간 넘게 차이 나서 제안하지 않는 곳
    const noneWithin = !near1.length && !near2.length && !far.length; // 3시간 안에 맞는 곳이 하나도 없음
    if (!near1.length && !near2.length) showFar = true;
    if (far.some((x) => x.a.code === sel.to)) showFar = true;
    // 검색으로 3시간 넘게 차이 나는 곳을 골랐으면 목록에도 그 한 곳은 보이게
    const picked = rs.find((x) => x.a.code === sel.to);
    if (!noneWithin && picked && Math.abs(picked.diff) > SUGGEST_MAX_DIFF && !far.includes(picked)) { far.push(picked); showFar = true; }
    const group = (title, list) => (list.length
      ? `<div class="dest-group"><span>${title}</span><span>${list.length}곳</span></div>${list.map(destRow).join('')}` : '');
    const searching = hasQuery($('dest-q'));
    let html;
    if (searching) {
      // 검색 결과: 이름이 잘 맞는 순서, 같으면 정한 시간에 가까운 순서
      const byCode = new Map(rs.map((x) => [x.a.code, x]));
      const found = searchAirports($('dest-q').value);
      const rows = found.filter((f) => byCode.has(f.a.code))
        .sort((p, q) => p.score - q.score || Math.abs(byCode.get(p.a.code).diff) - Math.abs(byCode.get(q.a.code).diff))
        .map((f) => byCode.get(f.a.code));
      const blocked = found.filter((f) => !byCode.has(f.a.code)).slice(0, 3).map(({ a }) => (a.code === depCode
        ? `<p class="dest-note"><b>${esc(a.city)}(${a.code})</b> · 지금 출발지예요.</p>`
        : `<p class="dest-note"><b>${esc(a.city)}(${a.code})</b> · 출발지에서 ${fmtKm(distanceKm(AP[depCode], a))}밖에 안 돼서 고를 수 없어요.</p>`)).join('');
      searchRows = rows;
      html = rows.length ? group('검색 결과', rows) + blocked
        : blocked || '<p class="sr-empty">찾는 도착지가 없어요. 도시 이름, 공항 코드(예: NRT), 나라 이름이나 초성(예: ㄷㅋ)으로 찾아 보세요.</p>';
    } else {
      html = group('딱 맞는 항공편 · ±10분', near1) + group('조금 차이 나는 항공편 · ±45분', near2);
      if (far.length) {
        html += showFar ? group('그 밖의 항공편 · ±3시간', far)
          : `<button type="button" class="more-btn" id="more-far">그 밖의 항공편 ${far.length}곳 더 보기 (±3시간)</button>`;
      }
      if (noneWithin && rs.length) {
        // 3시간 안에 맞는 곳이 하나도 없으면 시간이 가장 가까운 몇 곳만 보여 줌 (검색으로 고른 곳이 있으면 그것도)
        const few = rs.slice(0, 3);
        if (picked && !few.includes(picked)) few.push(picked);
        html = `<p class="dest-note">정한 시간과 3시간 안으로 맞는 항공편이 없어요. 시간이 가장 가까운 곳을 보여 드려요. 다른 곳은 위 검색창으로 찾을 수 있어요.</p>` + group('시간이 가장 가까운 항공편', few);
      } else if (beyond > 0 && (showFar || !far.length)) {
        html += `<p class="dest-note">시간이 3시간 넘게 차이 나는 ${fmtNum(beyond)}곳은 목록에서 뺐어요. 위 검색창으로 찾을 수 있어요.</p>`;
      }
    }
    if (html !== lastCards) {
      const modeChanged = searching !== lastCardsSearch;
      lastCards = html; lastCardsSearch = searching;
      $('cards').innerHTML = html;
      if (!REDUCED && (!searching || modeChanged)) $('cards').animate([{ opacity: 0.2, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    renderRouteSummary();
  }
  function renderRouteSummary() {
    const x = selected();
    $('btn-go').disabled = !x;
    if (!x) { setText('dest-name', '-'); setText('route-note', ''); return; }
    setText('dest-name', `${x.a.code} · ${x.a.city}`);
    const same = x.diff === 0;
    if (same) sel.mode = 'real';
    $('mode-seg').classList.toggle('is-off', same);
    $('mode-seg').dataset.mode = sel.mode; // 흰 손잡이가 미끄러지듯 이동
    setText('mode-real-t', fmtHHMM(x.min));
    setText('mode-mine-t', fmtHHMM(prefs.minutes));
    $('mode-real').setAttribute('aria-pressed', String(sel.mode === 'real'));
    $('mode-mine').setAttribute('aria-pressed', String(sel.mode === 'mine'));
    setText('mini-from', depCode);
    setText('mini-to', x.a.code);
    setText('mini-meta', `${fmtHHMM(sel.mode === 'real' ? x.min : prefs.minutes)} · ${acShort(prefs.aircraft)}`);
    let note;
    if (sel.mode === 'real') {
      note = same ? '정한 집중 시간과 실제 비행시간이 같아요.'
        : `실제 비행시간 ${fmtHHMM(x.min)} 동안 날아요. 정한 시간보다 ${fmtDur(Math.abs(x.diff))} ${x.diff > 0 ? '길어요' : '짧아요'}.`;
    } else {
      const pct = Math.round((x.min / prefs.minutes - 1) * 100);
      note = Math.abs(pct) < 3 ? '실제와 거의 같은 속도로 날아요.'
        : `정한 시간 ${fmtHHMM(prefs.minutes)}에 맞춰 실제보다 ${fmtNum(Math.abs(pct))}% ${pct > 0 ? '빠르게' : '느리게'} 날아요.`;
    }
    setText('route-note', note);
  }
  function selectDest(code) {
    sel.to = code; sel.mode = 'real';
    $('cards').querySelectorAll('.dest').forEach((c) => c.setAttribute('aria-selected', String(c.dataset.code === code)));
    const card = $('cards').querySelector(`[data-code="${code}"]`);
    if (card) card.scrollIntoView({ block: 'nearest', behavior: REDUCED ? 'auto' : 'smooth' });
    renderRouteSummary();
    updateScene();
    flyTo(viewFor('route', dockRect()), 700);
  }
  // 위쪽 설정 접기·펼치기: 막대를 위로 밀면 요약 한 줄 + 넓은 도착지 목록
  const routePane = document.querySelector('.pane-route');
  function setCompact(on) {
    routePane.classList.toggle('compact', on);
    $('grabber').setAttribute('aria-expanded', String(!on));
    if (on) closeDrawers();
  }
  (() => {
    const g = $('grabber');
    let gd = null;
    g.addEventListener('pointerdown', (e) => { gd = { y: e.clientY, moved: false }; g.setPointerCapture(e.pointerId); g.classList.add('dragging'); });
    g.addEventListener('pointermove', (e) => {
      if (!gd) return;
      const dy = e.clientY - gd.y;
      if (Math.abs(dy) > 24) { gd.moved = true; setCompact(dy < 0); gd.y = e.clientY; }
    });
    const end = () => {
      if (!gd) return;
      if (!gd.moved) setCompact(!routePane.classList.contains('compact')); // 누르기만 해도 바뀜
      gd = null; g.classList.remove('dragging');
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', () => { gd = null; g.classList.remove('dragging'); });
    g.addEventListener('click', (e) => { if (e.detail === 0) setCompact(!routePane.classList.contains('compact')); }); // 키보드
    $('route-mini').addEventListener('click', () => setCompact(false));
    // 목록을 위로 크게 끌어 올리면 자동으로 접힘
    $('cards').addEventListener('scroll', () => { if ($('cards').scrollTop > 120 && !routePane.classList.contains('compact') && !WIDE.matches) setCompact(true); }, { passive: true });
  })();

  $('cards').addEventListener('click', (e) => {
    if (e.target.closest('#more-far')) { const top = $('cards').scrollTop; showFar = true; renderRoute(); $('cards').scrollTop = top; return; }
    const c = e.target.closest('.dest');
    if (c) selectDest(c.dataset.code);
  });
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
    showEl('sheet-backdrop', { opacity: 0 });
    showEl('subject-sheet', { transform: 'translateY(100%)' });
    const cur = document.querySelector(`[data-subject="${prefs.subject}"]`);
    if (cur) cur.focus();
  }
  function closeSheet() {
    hideEl('subject-sheet', { transform: 'translateY(100%)' });
    hideEl('sheet-backdrop', { opacity: 0 });
  }
  $('sheet-backdrop').addEventListener('click', closeSheet);
  $('subjects').addEventListener('click', (e) => {
    const b = e.target.closest('[data-subject]');
    if (!b) return;
    if (b.dataset.subject === '기타') {
      document.querySelectorAll('[data-subject]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      showEl('custom-row');
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
    resetTear();
  }

  // ---------- 탑승권 찢기 ----------
  // ① 절취선을 손가락으로 따라 긋기: 그은 만큼 실제로 찢어지고, 한쪽 끝부터 찢으면 찢긴 쪽이 아래로 처지며 벌어짐.
  //    손을 떼도 찢긴 곳은 그대로 남고, 가로 80%를 넘기면 나머지가 저절로 찢어짐
  // ② 바코드를 아래로 끌기  ③ 탑승하기 버튼(왼쪽부터 빠르게 찢어짐)
  let boarding = false, gesture = null, piece = null;
  const stub = $('stub'), perf = $('perf');
  const passPane = document.querySelector('.pane-pass');
  const TEAR_TILT = 7; // 찢긴 쪽이 처지는 최대 각도(도)
  stub.tabIndex = 0;
  stub.setAttribute('role', 'button');
  stub.setAttribute('aria-label', '탑승권을 찢고 탑승하기');
  // 박스를 원래대로 (잘라 둔 곳·옮긴 그림자 되돌리기)
  function restoreDock(pc) {
    dock.style.clipPath = '';
    dock.style.boxShadow = '';
    if (pc && pc.shade) pc.shade.remove();
  }
  function resetTear() {
    boarding = false; gesture = null;
    if (piece) { piece.wrap.remove(); restoreDock(piece); piece = null; }
    restoreDock(null);
    stub.classList.remove('gone');
    dock.classList.remove('cut');
    perf.classList.remove('torn');
    $('btn-board').disabled = false; $('btn-board').textContent = '탑승하기';
  }
  // 절취선 아래(바코드 쪽)를 떼어 낼 종이 조각으로 복사하고, 박스는 절취선 아래를 잘라 안 보이게 함 (크기는 그대로)
  function makePiece() {
    const pr = perf.getBoundingClientRect(), dr = dock.getBoundingClientRect(), sr = stub.getBoundingClientRect();
    const lineY = Math.round(pr.top + pr.height / 2);
    const w = dr.width, h = Math.max(24, Math.min(dr.bottom, sr.bottom) - lineY);
    const wrap = document.createElement('div');
    wrap.className = 'tear-piece';
    Object.assign(wrap.style, { left: dr.left + 'px', top: lineY + 'px', width: w + 'px', height: h + 'px' });
    const paper = document.createElement('div');
    paper.className = 'tear-paper';
    const copy = stub.cloneNode(true);
    ['id', 'tabindex', 'role', 'aria-label'].forEach((a) => copy.removeAttribute(a));
    copy.className = 'stub stub-copy';
    Object.assign(copy.style, { left: (sr.left - dr.left) + 'px', top: (sr.top - lineY) + 'px', width: sr.width + 'px', height: sr.height + 'px' });
    const dashL = document.createElement('span'), dashR = document.createElement('span');
    dashL.className = dashR.className = 'tear-dash';
    paper.append(copy, dashL, dashR);
    wrap.appendChild(paper);
    document.body.appendChild(wrap);
    // 박스 그림자는 위쪽 조각 모양의 그림자 판으로 옮김 (찢긴 틈에도 위 조각의 그림자가 드리움)
    const shade = document.createElement('div');
    shade.className = 'tear-shade';
    Object.assign(shade.style, { left: dr.left + 'px', top: dr.top + 'px', width: dr.width + 'px', height: (lineY - dr.top) + 'px' });
    document.body.appendChild(shade);
    dock.style.boxShadow = 'none';
    const r = rng(hash(pending ? pending.flightNo + Date.now() : String(Date.now())));
    const n = Math.ceil(w / 4) + 2;
    const pc = {
      wrap, paper, dashL, dashR, shade, w, h, lineY, dockTop: dr.top, dockH: dr.height, dockW: dr.width,
      a: 0, b: 0, dy: 0, free: false, rot: 0, ox: 0,
      jagLo: Array.from({ length: n }, () => r()), jagUp: Array.from({ length: n }, () => r()),
    };
    renderPiece(pc);
    return pc;
  }
  // 찢긴 구간 [a, b]: 두 조각의 가장자리를 종이 결처럼 들쭉날쭉하게 자르고, 한쪽 끝부터 찢겼으면 찢긴 끝을 축으로 처지게 함
  function renderPiece(pc) {
    const w = pc.w, a = clamp(pc.a, 0, w), b = clamp(pc.b, 0, w);
    const torn = b - a;
    const inTear = (x) => torn > 0.5 && x >= a - 1 && x <= b + 1;
    const lo = [], up = [];
    for (let x = 0, i = 0; x <= w + 3; x += 4, i++) {
      const xx = Math.min(x, w);
      lo.push(`${xx}px ${inTear(xx) ? (0.6 + pc.jagLo[i] * 2.6).toFixed(1) : 0}px`);
      up.push(`${xx}px ${inTear(xx) ? (-0.4 - pc.jagUp[i] * 1.8).toFixed(1) : 0}px`);
    }
    pc.paper.style.clipPath = `polygon(${lo.join(',')},${w}px ${pc.h + 60}px,0px ${pc.h + 60}px)`;
    // 위쪽 박스: 절취선에서 잘리고, 찢긴 구간은 위 조각 쪽 결도 들쭉날쭉
    const top = pc.lineY - pc.dockTop;
    const upPts = up.map((s) => { const [x, y] = s.split(' ').map(parseFloat); return `${x}px ${(top + y).toFixed(1)}px`; }).reverse();
    dock.style.clipPath = `polygon(-2px -2px,${pc.dockW + 2}px -2px,${pc.dockW + 2}px ${top}px,${upPts.join(',')},-2px ${top}px)`;
    // 아직 붙어 있는 곳에만 점선이 남음
    const dash = (el, x0, x1) => { el.style.left = x0 + 'px'; el.style.width = Math.max(0, x1 - x0) + 'px'; };
    if (torn > 0.5) { dash(pc.dashL, 20, a); dash(pc.dashR, b, w - 20); } else { dash(pc.dashL, 20, w - 20); dash(pc.dashR, 0, 0); }
    let rot = 0, ox = w / 2;
    if (pc.free) rot = pc.rot;
    else if (a <= w * 0.06 && b < w * 0.97) { ox = b; rot = -TEAR_TILT * torn / w; } // 왼쪽부터 찢김 → 왼쪽이 처짐
    else if (b >= w * 0.94 && a > w * 0.03) { ox = a; rot = TEAR_TILT * torn / w; } // 오른쪽부터 찢김 → 오른쪽이 처짐
    if (!pc.free) { pc.rot = rot; pc.ox = ox; }
    pc.wrap.style.transformOrigin = `${pc.ox}px 0px`;
    pc.wrap.style.transform = `translateY(${pc.dy.toFixed(1)}px) rotate(${pc.rot.toFixed(2)}deg)`;
    pc.wrap.style.setProperty('--lift', clamp(torn / w + pc.dy / 80, 0, 1).toFixed(2));
  }

  // 종이 찢어지는 소리: 찢은 길이만큼 짧은 '지직' 소리 알갱이를 냄
  let ripBuf = null, lastRip = 0, ripDebt = 0;
  function ripSound(px) {
    const c = actx;
    if (!c || c.state !== 'running' || !(px > 0)) return;
    ripDebt += px;
    const now = c.currentTime;
    if (now - lastRip < 0.022 || ripDebt < 2) return;
    lastRip = now;
    if (!ripBuf) {
      ripBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = ripBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.07 ? 1 : 0.16); // 지직거리는 결
    }
    const src = c.createBufferSource();
    src.buffer = ripBuf;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1300 + Math.random() * 2800; bp.Q.value = 0.8;
    const g = c.createGain();
    const amp = clamp(ripDebt / 28, 0.06, 0.55), dur = 0.03 + Math.random() * 0.05;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(amp, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(bp).connect(g).connect(c.destination);
    src.start(now, Math.random() * 0.9, dur + 0.02);
    ripDebt = 0;
  }
  function ripBurst(n) { for (let k = 0; k < n; k++) setTimeout(() => ripSound(30 + Math.random() * 30), k * 24); }

  // 손가락·마우스: 절취선 근처에서 시작하면 긋기, 바코드 쪽에서 시작하면 끌어내리기
  // (찢기 시작하면 박스 아래쪽이 잘려 있어서, 문서 전체에서 받아 위치로 판단함)
  document.addEventListener('pointerdown', (e) => {
    if (step !== 'pass' || !pending || boarding || e.button > 0) return;
    if (e.target.closest && e.target.closest('button, .side-action, .topbar, .zoom')) return;
    const pr = perf.getBoundingClientRect(), sr = stub.getBoundingClientRect(), dr = dock.getBoundingClientRect();
    const lineY = piece ? piece.lineY : pr.top + pr.height / 2;
    const bottom = piece ? piece.lineY + piece.h : Math.min(sr.bottom, dr.bottom);
    if (e.clientX < dr.left - 12 || e.clientX > dr.right + 12) return;
    if (Math.abs(e.clientY - lineY) <= 30) {
      gesture = { kind: 'trace', lineY, left: dr.left, width: dr.width, min: e.clientX, max: e.clientX, x: e.clientX };
      if (piece && piece.b - piece.a > 0.5) { // 이미 찢긴 곳에 이어서 찢기
        gesture.min = Math.min(gesture.min, dr.left + piece.a);
        gesture.max = Math.max(gesture.max, dr.left + piece.b);
      }
    } else if (e.clientY > lineY + 30 && e.clientY <= bottom) {
      gesture = { kind: 'pull', y: e.clientY, dy: 0 };
    } else {
      return;
    }
    e.preventDefault();
    ensureAudio(); // 찢는 소리를 내려고 이때 오디오를 깨움
    try { passPane.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
  });
  document.addEventListener('pointermove', (e) => {
    if (!gesture || boarding) return;
    if (gesture.kind === 'trace') {
      if (Math.abs(e.clientY - gesture.lineY) > 80) { gesture = null; return; } // 선에서 너무 벗어나면 멈춤 (찢긴 곳은 남음)
      const before = gesture.max - gesture.min;
      gesture.min = Math.min(gesture.min, e.clientX);
      gesture.max = Math.max(gesture.max, e.clientX);
      const grow = gesture.max - gesture.min - before;
      if (!piece && gesture.max - gesture.min < 3) return;
      if (!piece) piece = makePiece();
      piece.a = clamp(gesture.min - gesture.left, 0, gesture.width);
      piece.b = clamp(gesture.max - gesture.left, 0, gesture.width);
      renderPiece(piece);
      ripSound(grow);
      if ((piece.b - piece.a) / piece.w >= 0.8) { gesture = null; tear(); }
      return;
    }
    const dy = Math.max(0, e.clientY - gesture.y);
    if (!piece && dy > 4) { piece = makePiece(); piece.a = 0; piece.b = piece.w; ripBurst(8); }
    if (!piece) return;
    if (!piece.free) { piece.free = true; piece.ox = piece.w / 2; piece.a = 0; piece.b = piece.w; }
    piece.wrap.classList.add('dragging');
    piece.dy = dy; piece.rot = -dy / 18;
    renderPiece(piece);
  });
  const endGesture = () => {
    const g = gesture;
    gesture = null;
    if (!g || boarding) return;
    if (g.kind === 'trace') return; // 손을 떼도 찢긴 곳은 그대로 (이어서 찢을 수 있음)
    if (g.kind === 'pull' && piece && piece.dy > 60) { tear(); return; }
    if (piece && piece.free) untear();
  };
  document.addEventListener('pointerup', endGesture);
  document.addEventListener('pointercancel', endGesture);
  // 끌어내리다 만 조각은 제자리로 붙음
  function untear() {
    const pc = piece;
    if (!pc) return;
    pc.wrap.classList.remove('dragging');
    const done = () => { if (piece === pc) { pc.wrap.remove(); restoreDock(pc); piece = null; } };
    if (REDUCED) { done(); return; }
    pc.wrap.animate([{ transform: pc.wrap.style.transform }, { transform: 'none' }], { duration: 220, easing: 'ease-out' }).finished.then(done, done);
  }
  stub.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tear(); } });
  $('btn-board').addEventListener('click', tear);

  function tear() {
    if (!pending || boarding) return;
    boarding = true;
    gesture = null;
    ensureAudio(); // 사용자 동작 시점에 오디오 잠금 해제
    askNotify(); // 비행 중 알림을 쓸 수 있게 (처음 한 번만 물어봄)
    $('btn-board').disabled = true;
    $('btn-board').textContent = '탑승 중…';
    const pc = piece || (piece = makePiece());
    pc.wrap.classList.remove('dragging');
    if (REDUCED) { pc.a = 0; pc.b = pc.w; fall(pc); return; }
    // 남은 부분이 끝까지 찢어짐: 버튼으로 찢으면 왼쪽부터 조금 천천히, 긋다 80%를 넘겼으면 빠르게
    if (pc.b - pc.a < 1) { pc.a = 0; pc.b = 0; }
    const a0 = pc.a, b0 = pc.b;
    const dur = b0 - a0 < 1 ? 560 : 200;
    const t0 = performance.now();
    let prevLen = b0 - a0;
    const stepRip = (now) => {
      const t = clamp((now - t0) / dur, 0, 1), e = t * t * (3 - 2 * t);
      pc.a = a0 * (1 - e); pc.b = b0 + (pc.w - b0) * e;
      renderPiece(pc);
      const len = pc.b - pc.a;
      ripSound(len - prevLen); prevLen = len;
      if (t < 1) requestAnimationFrame(stepRip); else fall(pc);
    };
    requestAnimationFrame(stepRip);
  }
  // 다 찢어지면 조각은 떨어지고, 남은 탑승권은 절취선에서 곧은 직선으로 끝남 (아래 꼭짓점 두 개)
  function fall(pc) {
    stub.classList.add('gone');
    perf.classList.add('torn');
    dock.classList.add('cut');
    restoreDock(pc);
    const cleanup = () => { pc.wrap.remove(); if (piece === pc) piece = null; };
    if (REDUCED) { cleanup(); setTimeout(board, 400); return; }
    const dir = pc.rot > 0 ? 1 : -1;
    const from = pc.wrap.style.transform || 'none';
    pc.wrap.style.setProperty('--lift', '1');
    pc.wrap.animate([
      { transform: from, opacity: 1 },
      { transform: `translate(${-dir * 10}px, ${pc.dy + 46}px) rotate(${pc.rot + dir * 5}deg)`, opacity: 1, offset: 0.3 },
      { transform: `translate(${-dir * 70}px, ${pc.dy + 460}px) rotate(${pc.rot + dir * 24}deg)`, opacity: 0 },
    ], { duration: 1400, easing: 'cubic-bezier(.45,0,.75,.5)', fill: 'forwards' }).finished.then(cleanup, cleanup);
    setTimeout(board, 1700); // 떨어지는 모습을 충분히 보여 준 뒤 출발
  }
  function board() {
    const f = pending;
    if (!f) return;
    f.startAt = Date.now();
    f.endAt = f.startAt + f.minutes * 60000;
    f.pausedAt = 0; f.pausedMs = 0; f.marks = {};
    f.phase = -1;
    flight = f; pending = null;
    store.set('flight', flight);
    stopBreak();
    go('flight', false, true);
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
  // 기내 소음: sounds/cabin.mp3(또는 .ogg/.m4a/.wav) 녹음이 있으면 그걸 끊김 없이 반복, 없으면 합성한 엔진 소리
  let cabinBuf = null, cabinTried = false;
  async function loadCabin(c) {
    if (cabinTried) return cabinBuf;
    cabinTried = true;
    for (const f of ['sounds/cabin.mp3', 'sounds/cabin.ogg', 'sounds/cabin.m4a', 'sounds/cabin.wav']) {
      try {
        const r = await fetch(f);
        if (!r.ok) continue;
        cabinBuf = await c.decodeAudioData(await r.arrayBuffer());
        return cabinBuf;
      } catch (e) { /* 다음 형식 시도 */ }
    }
    return null;
  }
  async function startNoise() {
    const c = ensureAudio();
    if (!c || noiseSrc) return false;
    const real = await loadCabin(c);
    if (noiseSrc) return true;
    if (real) {
      noiseSrc = c.createBufferSource();
      noiseSrc.buffer = real; noiseSrc.loop = true;
      noiseGain = c.createGain(); noiseGain.gain.value = 0;
      noiseSrc.connect(noiseGain).connect(c.destination);
      noiseSrc.start();
      noiseGain.gain.linearRampToValueAtTime(0.7, c.currentTime + 2);
      return true;
    }
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
  // 기내 차임: 실제 기내 방송처럼 높은음→낮은음 두 번 울리는 종소리 (배음 + 짧은 울림)
  let reverb = null;
  function cabinReverb(c) {
    if (reverb) return reverb;
    const len = Math.floor(c.sampleRate * 0.9);
    const ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    reverb = c.createConvolver();
    reverb.buffer = ir;
    const wet = c.createGain(); wet.gain.value = 0.25;
    reverb.connect(wet).connect(c.destination);
    return reverb;
  }
  function chime() {
    const c = ensureAudio();
    if (!c) return;
    const rv = cabinReverb(c);
    [[1318.5, 0], [1046.5, 0.62]].forEach(([freq, at]) => {
      const t = c.currentTime + 0.05 + at;
      const out = c.createGain();
      out.gain.setValueAtTime(0.0001, t);
      out.gain.exponentialRampToValueAtTime(0.22, t + 0.006);
      out.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
      out.connect(lp); lp.connect(c.destination); lp.connect(rv);
      [[1, 1], [2.01, 0.28], [3.02, 0.12], [4.2, 0.05]].forEach(([mul, amp]) => { // 종소리 배음
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = freq * mul;
        g.gain.setValueAtTime(amp, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2 / mul);
        o.connect(g).connect(out);
        o.start(t); o.stop(t + 2.3);
      });
    });
  }

  // 기내 방송 음성: 한국어 방송 뒤에 영어 방송. 기장은 낮고 차분하게, 승무원은 밝게
  const HAS_VOICE = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  let voices = [];
  const loadVoices = () => { try { voices = speechSynthesis.getVoices() || []; } catch (e) { voices = []; } };
  if (HAS_VOICE) {
    loadVoices();
    if (speechSynthesis.addEventListener) speechSynthesis.addEventListener('voiceschanged', loadVoices);
  }
  function pickVoice(lang, prefer) {
    const list = voices.filter((v) => (v.lang || '').toLowerCase().replace('_', '-').startsWith(lang));
    const score = (v) => (/natural|neural|online|premium|enhanced/i.test(v.name) ? 4 : 0)
      + (/google/i.test(v.name) ? 3 : 0) + (prefer && prefer.test(v.name) ? 2 : 0);
    return list.sort((a, b) => score(b) - score(a))[0] || null;
  }
  function duck(on) { // 방송하는 동안 엔진 소음을 낮춤
    if (noiseGain && actx) noiseGain.gain.setTargetAtTime(on ? 0.12 : (cabinBuf ? 0.7 : 0.4), actx.currentTime, 0.4);
  }
  // 방송 음성을 읽음. 읽기 시작했으면 true, 끝나면 onDone
  let paToken = 0;
  function speak(ann, onDone) {
    if (!HAS_VOICE || !prefs.voice || !ann) return false;
    try {
      const captain = ann.role === 'captain';
      const make = (text, lang, voice) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang;
        if (voice) u.voice = voice;
        u.rate = captain ? 0.92 : 0.98;
        u.pitch = captain ? 0.8 : 1.12;
        u.volume = 1;
        return u;
      };
      // 영어 방송만: 문장마다 끊어 읽어서 실제 방송처럼 약간씩 쉼
      const voice = pickVoice('en', captain ? /Guy|Daniel|Arthur|male|UK/i : /Jenny|Aria|Samantha|Libby|female|US/i);
      const parts = ann.en.split(/(?<=[.!?])\s+/).filter(Boolean);
      const us = parts.map((t) => make(t, voice && voice.lang ? voice.lang : 'en-US', voice));
      if (!us.length) return false;
      us[0].onstart = () => duck(true);
      const last = us[us.length - 1];
      last.onend = () => onDone && onDone();
      last.onerror = () => onDone && onDone();
      const token = paToken;
      setTimeout(() => { if (token === paToken) us.forEach((u) => speechSynthesis.speak(u)); }, 1700); // 차임이 끝난 뒤
      return true;
    } catch (e) { return false; }
  }

  // 방송 순서 기다리기: 앞 방송(차임 + 음성)이 끝나야 다음 방송을 시작함 (짧은 비행에서 방송이 끊기지 않게)
  const paQueue = [];
  let paBusy = false, paTimer = 0;
  function announce(ann) {
    if (!ann) return;
    paQueue.push(ann);
    if (!paBusy) nextPA();
  }
  function nextPA() {
    clearTimeout(paTimer);
    const ann = paQueue.shift();
    if (!ann) { paBusy = false; return; }
    paBusy = true;
    setPA(ann, Date.now()); // 화면 문구도 그 방송이 나올 때 바뀜
    chime();
    let done = false;
    const token = paToken; // 취소(clearPA)된 뒤에 늦게 오는 끝 신호는 무시
    const finish = () => {
      if (done || token !== paToken) return;
      done = true; duck(false);
      paTimer = setTimeout(nextPA, 700); // 방송 사이 잠깐 쉼
    };
    if (!speak(ann, finish)) { paTimer = setTimeout(finish, 2600); return; } // 음성이 꺼져 있으면 차임 길이만큼만 기다림
    // 끝 신호가 오지 않는 브라우저 대비: 글자 수로 길이를 어림해서 그 뒤에는 넘어감
    paTimer = setTimeout(finish, 1700 + ann.en.length * 90 + 4000);
  }
  function clearPA() { // 일시정지·음성 끄기·회항: 남은 방송을 모두 취소
    paQueue.length = 0; paBusy = false; paToken++;
    clearTimeout(paTimer);
    if (HAS_VOICE) { try { speechSynthesis.cancel(); } catch (e) { /* 무시 */ } }
    duck(false);
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
  // 일시정지한 시간은 빼고 셈: 멈춘 동안은 진행률·남은 시간이 그대로
  const durMs = (f) => f.minutes * 60000;
  const elapsedMs = (f, now) => clamp((f.pausedAt || now) - f.startAt - (f.pausedMs || 0), 0, durMs(f));
  const progressOf = (f, now) => elapsedMs(f, now) / durMs(f);
  const halfDone = (f, now) => elapsedMs(f, now) >= durMs(f) / 2; // 마일리지는 정한 시간의 절반이 지난 뒤부터

  // 실제 항공사 기내 방송 말투 (한국어 + 영어)
  function hmEn(min) {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    const hs = h ? `${h} hour${h > 1 ? 's' : ''}` : '';
    const ms = m ? `${m} minute${m > 1 ? 's' : ''}` : '';
    return [hs, ms].filter(Boolean).join(' and ') || 'less than a minute';
  }
  function announcement(f, idx, p) {
    const a = AP[f.to], city = a.city, cityEn = a.en || a.code;
    const fn = f.flightNo.replace('FA ', '');
    const hour = new Date().getHours();
    const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    switch (idx) {
      case 0: return {
        role: 'crew',
        ko: `손님 여러분, 안녕하십니까. 오늘도 포커스 에어를 이용해 주셔서 감사합니다. 이 비행기는 ${city}까지 가는 포커스 에어 ${fn}편입니다. 목적지까지 예정 비행시간은 ${fmtDur(f.minutes)}이며, 오늘 집중하실 과목은 ${f.subject}입니다. 출발 전 휴대전화는 비행기 모드로 전환해 주시기 바랍니다.`,
        en: `Good ${part}, ladies and gentlemen. Welcome aboard Focus Air flight ${fn} to ${cityEn}. Our flight time today will be ${hmEn(f.minutes)}. Please switch your mobile phone to flight mode.`,
      };
      case 1: return {
        role: 'crew',
        ko: `손님 여러분, 우리 비행기는 곧 이륙하겠습니다. 좌석벨트를 매 주시고, 지금부터 ${f.subject}에 집중해 주시기 바랍니다.`,
        en: 'Ladies and gentlemen, we are now ready for take-off. Please make sure your seatbelt is securely fastened.',
      };
      case 2: {
        const prof = profileOf(f);
        const alt = Math.round(prof.alt(p) / 1000) * 1000;
        const spd = Math.round(prof.speed(p) / 10) * 10;
        const remain = Math.max(1, Math.round((1 - p) * f.minutes));
        return {
          role: 'captain',
          ko: `손님 여러분, 안녕하십니까. 기장입니다. 우리 비행기는 현재 ${fmtNum(alt)}피트 상공을 시속 ${fmtNum(spd)}킬로미터로 순항하고 있습니다. ${city}까지 남은 비행시간은 약 ${fmtDur(remain)}입니다. 목적지까지 편안하게 집중하시기 바랍니다.`,
          en: `Ladies and gentlemen, this is your captain speaking. We are now cruising at ${fmtNum(alt)} feet. Our remaining flight time to ${cityEn} is about ${hmEn(remain)}. Enjoy your focus time.`,
        };
      }
      case 3: return {
        role: 'crew',
        ko: `손님 여러분, 우리 비행기는 ${city} 공항 도착을 위해 강하를 시작했습니다. 지금까지 공부한 내용을 차분히 정리해 주시기 바랍니다.`,
        en: `Ladies and gentlemen, we have started our descent into ${cityEn}. Please take a moment to review what you have studied.`,
      };
      case 5: return {
        role: 'crew',
        ko: `손님 여러분, 우리 비행기는 ${city} 공항에 도착했습니다. ${f.subject} 집중 비행을 끝까지 마치신 것을 축하드립니다. 오늘도 포커스 에어를 이용해 주셔서 감사합니다.`,
        en: `Ladies and gentlemen, welcome to ${cityEn}. Congratulations on completing your focus flight. Thank you for flying Focus Air.`,
      };
      default: return {
        role: 'crew',
        ko: '손님 여러분, 우리 비행기는 곧 착륙하겠습니다. 좌석 등받이와 테이블을 제자리로 해 주시고, 좌석벨트를 매 주시기 바랍니다.',
        en: 'Ladies and gentlemen, we will be landing shortly. Please return your seat back and tray table to their upright position.',
      };
    }
  }
  function setPA(ann, time) { setText('pa-text', ann.en); setText('pa-ko', ann.ko); setText('pa-time', fmtHM(time)); }
  // 남은 시간을 짧게: 40초 / 12분 / 1시간 5분
  function fmtLeft(min) {
    const s = Math.max(0, Math.round(min * 60));
    if (s < 60) return `${s}초`;
    const m = Math.ceil(s / 60), h = Math.floor(m / 60);
    return h ? `${h}시간${m % 60 ? ` ${m % 60}분` : ''}` : `${m}분`;
  }
  // 단계 표시: 단계마다 막대가 지난 만큼 차오르고, 지금 단계에는 다음 단계까지 남은 시간이 나옴
  function renderPhases(f, p) {
    const ol = $('phases');
    if (ol.children.length !== PHASES.length) {
      ol.innerHTML = PHASES.map((ph) => `<li class="phase"><span class="ph-bar"><i></i></span><b>${ph.en}</b><span class="ph-ko">${ph.ko}</span></li>`).join('');
    }
    const prof = profileOf(f), B = prof.bounds, idx = prof.phase(p);
    [...ol.children].forEach((li, i) => {
      const fill = i < idx ? 1 : i > idx ? 0 : clamp((p - B[i]) / (B[i + 1] - B[i]), 0, 1);
      li.querySelector('i').style.transform = `scaleX(${fill.toFixed(4)})`;
      li.classList.toggle('is-done', i < idx);
      li.classList.toggle('is-now', i === idx);
      if (i === idx) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      const txt = i !== idx ? PHASES[i].ko : f.pausedAt ? '일시정지' : `${PHASES[i].ko} · ${fmtLeftShort((B[i + 1] - p) * f.minutes)}`;
      const ko = li.querySelector('.ph-ko');
      if (ko.textContent !== txt) ko.textContent = txt;
    });
    return idx;
  }

  let lastText = 0, lastTitle = '';
  const flightPane = document.querySelector('.pane-flight');
  function renderFlightStatic() {
    const f = flight;
    if (!f) return;
    $('f-flight').textContent = f.flightNo;
    $('f-route').textContent = `${f.from} → ${f.to}`;
    $('m-route').textContent = `${f.from} → ${f.to}`;
    $('f-subject').textContent = f.subject;
    $('f-subject').style.background = subjectColor(SUBJECTS.some((s) => s.n === f.subject) ? f.subject : '기타');
    $('abort-confirm').hidden = true;
    flightPane.classList.remove('confirming');
    $('btn-voice').setAttribute('aria-pressed', String(prefs.voice));
    renderNotifyBtn();
    flightPane.classList.toggle('mini', !!prefs.flightMini);
    dock.classList.toggle('mini', !!prefs.flightMini);
    renderPause();
    const p = progressOf(f, Date.now());
    renderPhases(f, p);
    fitFlightPane();
    // 새로고침 뒤에는 지난 방송을 다시 울리지 않고 문구만 보여 줌
    if (f.phase >= 0) setPA(announcement(f, f.phase, p), Date.now());
    lastText = 0;
    updateTexts(f, p, Date.now());
  }

  function setUnit(id, num, unit) {
    const html = `${num}<span class="u">${unit}</span>`;
    if ($(id).innerHTML !== html) $(id).innerHTML = html;
  }
  // 단계 막대용 짧은 남은 시간: 40초 / 12분 / 6:19
  function fmtLeftShort(min) {
    const s = Math.max(0, Math.round(min * 60));
    if (s < 60) return `${s}초`;
    const m = Math.ceil(s / 60);
    return m < 60 ? `${m}분` : `${Math.floor(m / 60)}:${pad(m % 60)}`;
  }
  function updateTexts(f, p, now) {
    const prof = profileOf(f);
    const s = prof.frac(p);
    const clock = fmtClock((durMs(f) - elapsedMs(f, now)) / 1000);
    const spd = prof.speed(p);
    const before = prof.speed(p - 4 / (f.minutes * 60)); // 4초 전과 비교
    const flown = f.km * s;
    const idx = prof.phase(p);
    const paused = !!f.pausedAt;
    $('f-remain').textContent = clock;
    $('m-remain').textContent = clock;
    $('f-remain-label').textContent = paused ? '일시정지 중' : 'Time remaining';
    $('f-dist').textContent = fmtNum(f.km - flown) + ' km';
    $('m-dist').textContent = `${fmtNum(f.km - flown)} km 남음`;
    $('m-phase').textContent = paused ? '일시정지' : `${PHASES[idx].en} · ${PHASES[idx].ko}`;
    $('f-bar').style.width = (p * 100).toFixed(2) + '%';
    $('m-bar').style.width = (p * 100).toFixed(2) + '%';
    // 단위는 작게: 좁은 화면에서도 숫자가 잘리지 않게
    setUnit('t-alt', fmtNum(Math.round(prof.alt(p) / 10) * 10), 'ft');
    setUnit('t-spd', fmtNum(spd), 'km/h');
    $('t-trend').textContent = paused ? '' : spd - before > 0.3 ? '▲ 가속' : before - spd > 0.3 ? '▼ 감속' : '';
    $('t-eta').textContent = paused ? '일시정지' : fmtHM(f.endAt);
    // 마일리지: 정한 시간의 절반이 지나야 쌓이기 시작
    const miles = halfDone(f, now)
      ? `${fmtNum(milesFor(elapsedMs(f, now)))}<span class="u">mi</span><small>적립 중</small>`
      : `0<span class="u">mi</span><small>${fmtLeft((durMs(f) / 2 - elapsedMs(f, now)) / 60000)} 뒤부터</small>`;
    if ($('t-miles').innerHTML !== miles) $('t-miles').innerHTML = miles;
    const title = `${paused ? '⏸ ' : ''}${clock} · ${f.from}→${f.to}`;
    if (title !== lastTitle) { document.title = title; lastTitle = title; }
  }

  // 여정 중 알림: 화면을 보고 있으면 위쪽 알림 띠, 다른 앱·탭에 있으면 기기 알림
  function alertUser(title, body) {
    if (document.hidden) sysNotify(title, body);
    else if (step === 'flight') toast(`${title} — ${body}`);
  }
  function phaseMsg(f, idx, p) {
    const left = fmtLeft((1 - p) * f.minutes), city = AP[f.to].city;
    return [
      '탑승구에서 출발을 기다려요.',
      `이륙해요. 지금부터 ${f.subject}에 집중!`,
      `순항 고도에 올라왔어요. ${city}까지 ${left} 남았어요.`,
      `${city}${euro(city)} 하강을 시작했어요. ${left} 남았어요.`,
      '곧 착륙해요. 마무리해 볼까요?',
    ][idx];
  }
  function milestones(f, now) {
    const m = f.marks || (f.marks = {});
    let changed = false;
    if (!m.half && halfDone(f, now)) {
      m.half = changed = true;
      alertUser('절반 지났어요', '지금부터 마일리지가 쌓여요. 이대로 끝까지 가 봐요!');
    }
    if (!m.five && f.minutes >= 20 && durMs(f) - elapsedMs(f, now) <= 5 * 60000) {
      m.five = changed = true;
      alertUser('착륙 5분 전', `${AP[f.to].city} 도착까지 5분 남았어요.`);
    }
    if (changed) store.set('flight', f);
  }

  function tick() {
    const f = flight;
    if (!f) return;
    const now = Date.now();
    const p = progressOf(f, now);
    if (p >= 1) { land(false); return; }
    const idx = profileOf(f).phase(p);
    if (idx !== f.phase) {
      const first = f.phase < 0;
      f.phase = idx;
      store.set('flight', f);
      const ann = announcement(f, idx, p);
      announce(ann); // 앞 방송이 끝난 뒤에 차례로
      if (!first) alertUser(`${PHASES[idx].en} · ${PHASES[idx].ko}`, phaseMsg(f, idx, p));
      if (step === 'flight') renderPhases(f, p);
    }
    milestones(f, now);
    if (step !== 'flight') return;
    if (now - lastText >= 1000) {
      lastText = now; updateTexts(f, p, now); renderPhases(f, p);
      if (flightPane.scrollHeight > flightPane.clientHeight + 1) fitFlightPane(); // 방송 문구가 바뀌어 넘치면 다시 맞춤
    }
    kick(); // 비행기·지도는 frame()에서 부드럽게 그림
  }
  let flightTimer = 0;
  function startFlightLoop() { if (!flightTimer) flightTimer = setInterval(tick, 200); tick(); }
  function stopFlightLoop() { clearInterval(flightTimer); flightTimer = 0; }
  // 다른 화면이거나 탭이 백그라운드여도 착륙은 확인
  setInterval(() => { if (flight && !flightTimer) tick(); }, 1000);

  // 비행 창이 화면에 다 들어가게: 넘치면 덜 중요한 것부터 숨김 (스크롤 없음)
  function fitFlightPane() {
    const levels = ['tight', 'tighter', 'tightest', 'squeeze'];
    flightPane.classList.remove(...levels);
    if (flightPane.hidden || flightPane.classList.contains('mini')) return;
    for (const c of levels) {
      if (flightPane.scrollHeight <= flightPane.clientHeight + 1) return;
      flightPane.classList.add(c);
    }
  }
  window.addEventListener('resize', () => { if (step === 'flight') fitFlightPane(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (step === 'flight') fitFlightPane(); }); // 글꼴이 늦게 오면 글자가 커지므로 다시 맞춤

  // ---------- 일시정지 ----------
  function setPaused(on) {
    const f = flight;
    if (!f) return;
    const now = Date.now();
    if (on && !f.pausedAt) {
      f.pausedAt = now;
      clearPA();
      if (noiseGain && actx) noiseGain.gain.setTargetAtTime(0, actx.currentTime, 0.3);
      toast('일시정지했어요. 남은 시간과 비행기가 그대로 멈춰 있어요.');
    } else if (!on && f.pausedAt) {
      f.pausedMs = (f.pausedMs || 0) + (now - f.pausedAt);
      f.pausedAt = 0;
      f.endAt = f.startAt + f.pausedMs + durMs(f); // 멈춘 만큼 도착이 늦어짐
      if (noiseSrc) duck(false);
      toast(`다시 출발! 도착 예정 ${fmtHM(f.endAt)}`);
    } else return;
    store.set('flight', f);
    renderPause();
    lastText = 0;
    tick();
    kick();
  }
  function renderPause() {
    const paused = !!(flight && flight.pausedAt);
    flightPane.classList.toggle('paused', paused);
    document.body.classList.toggle('is-paused', paused);
    $('btn-pause').setAttribute('aria-pressed', String(paused));
    setText('btn-pause-t', paused ? '다시 시작' : '일시정지');
    $('btn-pause-mini').setAttribute('aria-pressed', String(paused));
    $('btn-pause-mini').setAttribute('aria-label', paused ? '다시 시작' : '일시정지');
  }
  $('btn-pause').addEventListener('click', () => setPaused(!(flight && flight.pausedAt)));
  $('btn-pause-mini').addEventListener('click', () => setPaused(!(flight && flight.pausedAt)));

  // ---------- 비행 창 줄이기: 필요한 정보(남은 시간·거리·단계·진행 막대)만 ----------
  function morphDock(change, dur) {
    const first = dock.getBoundingClientRect();
    change();
    const last = dock.getBoundingClientRect();
    lastDock = last;
    if (!REDUCED) {
      dock.getAnimations().forEach((a) => a.cancel());
      const box = (r) => ({ left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', right: 'auto', bottom: 'auto' });
      dock.animate([box(first), box(last)], { duration: dur, easing: 'cubic-bezier(.2,.8,.2,1)' });
      const pane = PANES.find((p) => !p.hidden);
      if (pane) pane.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur * 0.8, delay: dur * 0.2, easing: 'ease-out', fill: 'backwards' });
      morphUntil = performance.now() + dur + 40;
    }
    if (step === 'flight' && following) flyTo(viewFor('flight', last), dur + 200);
  }
  function setFlightMini(on) {
    prefs.flightMini = on; savePrefs();
    const apply = () => { flightPane.classList.toggle('mini', on); dock.classList.toggle('mini', on); fitFlightPane(); };
    if (step !== 'flight') { apply(); return; }
    morphDock(apply, 480);
    (on ? $('btn-expand') : $('btn-collapse')).focus({ preventScroll: true });
  }
  $('btn-collapse').addEventListener('click', () => setFlightMini(true));
  $('btn-expand').addEventListener('click', () => setFlightMini(false));

  // ---------- 기기 알림 (GitHub Pages 같은 https 주소에서) ----------
  const CAN_NOTIFY = 'Notification' in window;
  let swReg = null;
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
    try { navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }, () => {}); } catch (e) { /* 미리보기 등 */ }
  }
  const notifyOn = () => CAN_NOTIFY && prefs.notify && Notification.permission === 'granted';
  function renderNotifyBtn() { $('btn-notify').setAttribute('aria-pressed', String(notifyOn())); }
  function askNotify() { // 탑승할 때 처음 한 번만 물어봄
    if (!CAN_NOTIFY || !prefs.notify || Notification.permission !== 'default') return;
    try {
      const r = Notification.requestPermission(renderNotifyBtn);
      if (r && r.then) r.then(renderNotifyBtn, () => {});
    } catch (e) { /* 무시 */ }
  }
  async function sysNotify(title, body) {
    if (!notifyOn()) return;
    const opt = { body, tag: 'focusair-flight', renotify: true, lang: 'ko' };
    try {
      if (swReg && swReg.showNotification) { await swReg.showNotification(title, opt); return; }
      new Notification(title, opt);
    } catch (e) { /* 이 브라우저에서는 알림을 못 띄움 */ }
  }
  function clearNotify() {
    if (swReg && swReg.getNotifications) swReg.getNotifications({ tag: 'focusair-flight' }).then((l) => l.forEach((n) => n.close()), () => {});
  }
  if (!CAN_NOTIFY) $('btn-notify').hidden = true;
  $('btn-notify').addEventListener('click', async () => {
    if (!CAN_NOTIFY) return;
    if (Notification.permission === 'denied') { toast('브라우저 설정에서 이 사이트의 알림을 허용해 주세요.'); return; }
    if (Notification.permission === 'default') {
      prefs.notify = true; savePrefs();
      try { await Notification.requestPermission(); } catch (e) { /* 무시 */ }
      renderNotifyBtn();
      if (notifyOn()) toast('알림을 켰어요. 다른 앱에 있을 때 단계가 바뀌거나 도착하면 알려 드려요.');
      return;
    }
    prefs.notify = !prefs.notify; savePrefs();
    renderNotifyBtn();
    toast(prefs.notify ? '알림을 켰어요.' : '알림을 껐어요.');
  });
  // 비행 중에 다른 앱으로 가거나 화면을 끄면 "비행 중" 알림, 돌아오면 지움
  document.addEventListener('visibilitychange', () => {
    if (!flight) return;
    if (document.hidden) {
      if (!flight.pausedAt) sysNotify('✈ 비행 중이에요', `${flight.from} → ${flight.to} · 남은 시간 ${fmtClock((durMs(flight) - elapsedMs(flight, Date.now())) / 1000)}. 돌아오면 이어서 날아요.`);
    } else {
      clearNotify();
    }
  });

  $('btn-noise').addEventListener('click', () => {
    if (noiseSrc) { stopNoise(); return; }
    $('btn-noise').setAttribute('aria-pressed', 'true');
    startNoise().then((ok) => {
      if (!ok) { $('btn-noise').setAttribute('aria-pressed', 'false'); toast('이 브라우저에서는 소리를 낼 수 없어요.'); }
      else if (flight && flight.pausedAt && noiseGain && actx) noiseGain.gain.setTargetAtTime(0, actx.currentTime, 0.3);
    });
  });
  $('btn-voice').addEventListener('click', () => {
    prefs.voice = !prefs.voice; savePrefs();
    $('btn-voice').setAttribute('aria-pressed', String(prefs.voice));
    clearPA();
    if (prefs.voice && flight && !flight.pausedAt) announce(announcement(flight, Math.max(0, flight.phase), progressOf(flight, Date.now())));
  });
  $('btn-wake').addEventListener('click', () => {
    if (wakeWanted) { releaseWake(); return; }
    wakeWanted = true;
    requestWake();
  });
  $('btn-abort').addEventListener('click', () => {
    if (!flight) return;
    const now = Date.now();
    const min = Math.floor(elapsedMs(flight, now) / 60000);
    const miles = halfDone(flight, now)
      ? `정한 시간의 절반을 넘겼으니 집중한 시간만큼 마일리지(${fmtNum(milesFor(elapsedMs(flight, now)))} mi)는 받아요.`
      : `정한 시간의 절반(${fmtDur(Math.ceil(flight.minutes / 2))})을 넘기지 않아 마일리지는 없어요.`;
    $('abort-text').textContent = min >= 1
      ? `정말 비행을 중단할까요? 지금까지 집중한 ${fmtDur(min)}은 로그북에 '회항'으로 남고, 착륙 성공으로는 세지 않아요. ${miles}`
      : '정말 비행을 중단할까요? 1분이 지나지 않아 기록은 남지 않아요.';
    flightPane.classList.add('confirming'); // 확인 창이 들어갈 자리를 방송 칸에서 빌림
    showEl('abort-confirm');
    fitFlightPane();
  });
  $('abort-cancel').addEventListener('click', () => {
    hideEl('abort-confirm').then(() => { flightPane.classList.remove('confirming'); fitFlightPane(); });
  });
  $('abort-ok').addEventListener('click', () => land(true));

  // ---------- 5. 도착 / 회항 ----------
  function land(diverted) {
    const f = flight;
    if (!f) return;
    const el = elapsedMs(f, Date.now());
    const now = f.pausedAt || Math.min(Date.now(), f.endAt); // 착륙(또는 회항) 시각
    const focusedMin = Math.round(el / 60000); // 일시정지한 시간은 빼고 셈
    flight = null;
    document.body.classList.remove('is-paused');
    clearNotify();
    store.del('flight');
    stopFlightLoop();
    stopNoise();
    releaseWake();
    if (diverted) clearPA(); // 착륙이면 하던 방송을 끝까지 듣고 도착 방송이 이어짐
    document.title = BASE_TITLE; lastTitle = '';

    if (diverted && focusedMin < 1) {
      toast('비행을 취소했어요. 기록은 남지 않았어요.');
      go('home');
      return;
    }
    const p = el / durMs(f);
    const kmFlown = diverted ? Math.round(f.km * profileOf(f).frac(p)) : f.km;
    const earn = !diverted || el >= durMs(f) / 2; // 마일리지는 정한 시간의 절반을 넘겨야 받음
    const milesBefore = totalMiles();
    const entry = {
      id: f.startAt, date: f.startAt, landedAt: now, flightNo: f.flightNo,
      from: f.from, to: diverted ? f.from : f.to, plannedTo: f.to,
      subject: f.subject, aircraft: f.aircraft, minutes: f.minutes, focusedMin,
      km: kmFlown, miles: earn ? milesFor(el) : 0,
      status: diverted ? 'diverted' : 'arrived',
    };
    log.unshift(entry);
    store.set('log', log);
    const milesAfter = totalMiles();
    const newAc = AIRCRAFT.filter((a) => a.miles > milesBefore && a.miles <= milesAfter).pop();
    if (newAc) { prefs.aircraft = newAc.id; savePrefs(); }
    if (!diverted) {
      loc = depCode = f.to; store.set('loc', loc);
      announce(announcement(f, 5, 1));
      if (document.hidden) sysNotify(`${AP[f.to].city} 도착! 착륙 성공 ✈`, `${f.subject} ${fmtDur(focusedMin)} 비행을 끝까지 마쳤어요. +${fmtNum(entry.miles)} mi`);
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
      $('a-sub').textContent = e.miles > 0
        ? `${e.subject} 비행을 중간에 멈췄어요. 집중한 ${fmtDur(e.focusedMin)}과 그 시간만큼의 마일은 기록에 남았어요.`
        : `${e.subject} 비행을 중간에 멈췄어요. 집중한 ${fmtDur(e.focusedMin)}은 기록에 남았지만, 정한 시간의 절반을 넘기지 않아 마일리지는 없어요.`;
    } else {
      $('a-title').textContent = `${dest.city}에 도착했어요`;
      $('a-sub').textContent = `${e.subject} ${fmtDur(e.focusedMin)} 비행을 끝까지 마쳤어요. 착륙 성공!`;
    }
    $('a-min').textContent = fmtDur(e.focusedMin);
    $('a-km').textContent = fmtKm(e.km);
    $('a-miles').textContent = '+' + fmtNum(e.miles);
    $('a-streak').textContent = streaks().current + '일';
    $('a-unlock').hidden = true;
    if (newAc) setTimeout(() => showEl('a-unlock', { opacity: 0, transform: 'scale(0.9)' }), 700);
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
  $('btn-reset').addEventListener('click', () => { hideEl('btn-reset').then(() => showEl('reset-confirm')); });
  $('reset-cancel').addEventListener('click', () => { hideEl('reset-confirm').then(() => showEl('btn-reset')); });
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
  setAttrib();
  startTiles();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(kick);
  if (flight) {
    if (!flight.marks) flight.marks = { half: halfDone(flight, Date.now()), five: durMs(flight) - elapsedMs(flight, Date.now()) <= 5 * 60000 };
    if (progressOf(flight, Date.now()) >= 1) { go('home', true); land(false); }
    else go('flight', true);
  } else {
    go('home', true);
  }
})();
