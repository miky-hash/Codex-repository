// Run from the repository root: node --test tests/performance.test.cjs
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = resolve(__dirname, '../flight-focus');
const source = readFileSync(resolve(root, 'app.js'), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `Missing function ${name}`);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
function geometry() {
  const ctx = vm.createContext({});
  for (const file of ['d3-array.min.js', 'd3-geo.min.js']) {
    vm.runInContext(readFileSync(resolve(root, 'vendor', file), 'utf8'), ctx);
  }
  vm.runInContext(`
    const referenceInterpolate = d3.geoInterpolate;
    let interpolations = 0;
    d3.geoInterpolate = (...args) => {
      const interpolate = referenceInterpolate(...args);
      return t => { interpolations++; return interpolate(t); };
    };
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const lonlat = a => [a.lon, a.lat];
    const AP = { ICN:{lon:126.45,lat:37.46}, LAX:{lon:-118.41,lat:33.94},
      HEL:{lon:24.96,lat:60.32}, NRT:{lon:140.39,lat:35.77} };
    let flight = {from:'ICN',to:'LAX'}, flightPath = null;
    const HAS_GEO = true, scene = {};
    const progressOf = (f, now) => now;
    const profileOf = () => ({frac:p=>p, alt:()=>37000});
    const tilesOn = () => true, projectVisible = ll => ll;
    let drawn = [];
    const ctx = {beginPath:()=>{drawn=[]},moveTo:(...p)=>drawn.push(p),lineTo:(...p)=>drawn.push(p)};
    ${['flightPathOf', 'flightGeometry', 'geoLine'].map(functionSource).join('\n')}
  `, ctx);
  return code => vm.runInContext(code, ctx);
}

test('flight path is reused and rebuilt when either airport changes', () => {
  const run = geometry();
  assert.equal(run('flightPathOf(flight) === flightPathOf(flight)'), true);
  run('const old = flightPath; flight.to = "HEL";');
  assert.equal(run('flightPathOf(flight) === old'), false);
  run('const next = flightPath; flight.from = "NRT";');
  assert.equal(run('flightPathOf(flight) === next'), false);
});

test('cached route preserves endpoints and great-circle geometry across the date line', () => {
  const run = geometry();
  for (const destination of ['LAX', 'HEL', 'NRT']) {
    run(`flight.to = '${destination}';`);
    for (const p of [0, 0.001, 0.3, 0.999, 1]) {
      const result = run(`(() => {
        flightGeometry(${p});
        geoLine(scene.done); const before = drawn.slice();
        geoLine(scene.todo); const after = drawn.slice();
        return {before, after, pos:scene.plane, A:flightPath.A, B:flightPath.B,
          expected:referenceInterpolate(flightPath.A,flightPath.B)(${p}),
          maxGap:Math.max(...before.slice(1).map((x,i)=>d3.geoDistance(x,before[i])),
            ...after.slice(1).map((x,i)=>d3.geoDistance(x,after[i])))};
      })()`);
      assert.deepEqual(result.before[0], result.A);
      assert.deepEqual(result.before.at(-1), result.pos);
      assert.deepEqual(result.after[0], result.pos);
      assert.deepEqual(result.after.at(-1), result.B);
      assert.deepEqual(result.pos, result.expected);
      assert.ok(result.maxGap <= 0.004001);
    }
  }
});

test('300 flight frames interpolate only the plane and heading after warmup', () => {
  const run = geometry();
  run('flightGeometry(0); interpolations = 0;');
  run('for(let i=0;i<300;i++){flightGeometry(i/300);geoLine(scene.done);geoLine(scene.todo);}');
  assert.equal(run('interpolations'), 600);
});

test('overlapping cabin audio requests share one fetch and decode', async () => {
  let fetches = 0, decodes = 0;
  const ctx = vm.createContext({ fetch: async () => {
    fetches++;
    return {ok:true, arrayBuffer:async()=>new ArrayBuffer(8)};
  }});
  vm.runInContext(`let cabinBuf = null, cabinLoad = null; ${functionSource('loadCabin')}`, ctx);
  const load = vm.runInContext('loadCabin', ctx);
  const audio = { decodeAudioData:async()=>{ decodes++; return {duration:25.9}; } };
  const a = load(audio), b = load(audio);
  assert.equal(a, b);
  assert.equal((await a).duration, 25.9);
  await load(audio);
  assert.equal(fetches, 1);
  assert.equal(decodes, 1);
});
