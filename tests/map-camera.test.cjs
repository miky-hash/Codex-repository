// Run: node --test tests/map-camera.test.cjs
// Exercise the existing IIFE's camera functions without exposing debug APIs in the app.
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = resolve(__dirname, '../flight-focus');
const source = readFileSync(process.env.APP_SOURCE || resolve(root, 'app.js'), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `Missing function ${name}`);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}

function harness() {
  const ctx = vm.createContext({ console });
  for (const file of ['d3-array.min.js', 'd3-geo.min.js']) {
    vm.runInContext(readFileSync(resolve(root, 'vendor', file), 'utf8'), ctx);
  }
  vm.runInContext(`
    let wall = 1700000000000;
    const Date = { now: () => wall };
    const performance = { timeOrigin: wall, now: () => wall - 1700000000000 };
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const lonlat = a => [a.lon, a.lat];
    const profileCache = new Map();
    const AP = { ICN: {lon:126.45,lat:37.46}, NRT: {lon:140.39,lat:35.77},
      LAX: {lon:-118.41,lat:33.94}, HEL: {lon:24.96,lat:60.32} };
    let flight = {from:'ICN',to:'NRT',minutes:135,km:1258,cruise:830,seed:42,
      startAt:wall - 3600000,pausedAt:0,pausedMs:0};
    const durMs = f => f.minutes * 60000;
    const elapsedMs = (f, now) => clamp((f.pausedAt || now) - f.startAt - f.pausedMs, 0, durMs(f));
    const progressOf = (f, now) => elapsedMs(f, now) / durMs(f);
    let depCode = 'ICN', step = 'flight', following = true, tween = null, raf = 0;
    let camMoving = false, gdrag = null, pinch = null, zoomUntil = 0;
    let flightBase = 1, zoomMul = 1000, HAS_GEO = true, globeGL = null;
    let tileMode = true, draws = 0, cameraUpdates = 0, scheduled = 0;
    const view = {}, scene = {};
    const slotFor = () => ({cx:800,cy:400,r:1200,area:600});
    const flightMinZoom = () => 0.15, maxZoom = () => 60000;
    // Simulate a busy layout calculation between plane and camera updates.
    const dockRect = () => { wall += 12; return {}; };
    const tilesOn = () => tileMode;
    const syncMap = () => { cameraUpdates++; };
    const draw = () => { draws++; };
    const kick = () => { scheduled++; };
    const planePxPerSec = () => flight.pausedAt ? 0 : 100;
    ${['rng', 'profileOf', 'viewFor', 'flightGeometry', 'frame'].map(functionSource).join('\n')}
    function sample(time) {
      wall = performance.timeOrigin + time;
      frame(time);
      return {plane:[...scene.plane],camera:[view.lon,view.lat],zoom:view.zoom,
        draws,cameraUpdates,scheduled,alt:scene.altFrac};
    }
  `, ctx);
  return code => vm.runInContext(code, ctx);
}

test('tracking camera and plane share a frame timestamp despite slow layout', () => {
  for (const destination of ['NRT', 'LAX', 'HEL']) {
    const run = harness();
    run(`flight.to = '${destination}';`);
    for (let i = 0; i < 20; i++) {
      const { plane, camera } = run(`sample(${i * 16.6667})`);
      assert.ok(Math.abs(plane[0] - camera[0]) < 1e-12, `${destination}: longitude drift`);
      assert.ok(Math.abs(plane[1] - camera[1]) < 1e-12, `${destination}: latitude drift`);
    }
  }
});

test('paused flight stays fixed while rendering timestamps advance', () => {
  const run = harness();
  run('flight.pausedAt = wall;');
  const first = run('sample(0)');
  const later = run('sample(60000)');
  assert.deepEqual(later.plane, first.plane);
  assert.deepEqual(later.camera, first.camera);
  assert.equal(later.alt, first.alt);
});

test('manual camera stays put while flight continues', () => {
  const run = harness();
  run('sample(0); following = false; Object.assign(view, {lon:10, lat:20});');
  const first = run('sample(1000)');
  const later = run('sample(2000)');
  assert.deepEqual(Array.from(later.camera), [10, 20]);
  assert.notDeepEqual(later.plane, first.plane);
});

test('tile overlays wait for map rendering; builtin globe still draws directly', () => {
  const run = harness();
  const online = run('sample(0)');
  assert.equal(online.cameraUpdates, 1);
  assert.equal(online.draws, 0);
  const offline = run('tileMode = false; sample(16)');
  assert.equal(offline.draws, 1);
});

test('wheel zoom remains moving between events and settles after the input ends', () => {
  const run = harness();
  run('following = false; zoomUntil = 160; sample(80);');
  assert.equal(run('camMoving'), true);
  run('sample(180);');
  assert.equal(run('camMoving'), false);
});
