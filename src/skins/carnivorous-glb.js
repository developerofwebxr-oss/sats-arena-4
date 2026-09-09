import * as THREE from 'three';
import { preferGlbArena, validateFromInside, warmGpu, buildEquirectShell } from './arena-glb.js';
import { buildCarnivorousDoors } from './carnivorous-doors.js';
import { buildCarnivorousMood } from './carnivorous-mood.js';
import carnGlbUrl from '../assets/sats-arena-carnivorous-v2.glb?url';
import carnPanoUrl from '../assets/carnivorous-360-equirectangular.jpg?url';

/**
 * carnivorous-glb.js — the Carnivorous Conservatory, skin #3.
 *
 * ENVIRONMENT ONLY. The maws open and close and the room is lit; nothing lives
 * in the holes yet. The Snapper is P47, and it will find this file already
 * handing it the same door API the Gold Arena hands P42b.
 *
 * ── WHAT THE ASSET IS ───────────────────────────────────────────────────────
 * sats-arena-carnivorous-v2.glb: a sealed 31 x 31 m enclosure, 12.6 m to the
 * canopy, twelve maws at 30 degree spacing on a 13 m radius, and a full set of
 * gameplay anchors (PlayerOrigin, Spawn/Entry/CoinSpawn per station). 565,136
 * triangles across 70 primitives and 14 materials — four of them emissive,
 * which is most of this skin's light.
 *
 * NO INTEGRATION NOTES SHIPPED WITH IT. The Gold pack carried a README with the
 * scale/orientation contract; the Carnivorous source pack is TRUNCATED (no
 * end-of-central-directory record) and contains only the v1 GLB and four PNGs.
 * So the contract below was MEASURED from the asset rather than read:
 *
 *   units      metres. Floor at y=0, canopy at y=12.62, maw apertures 3.6 m
 *              wide and 3.6 m tall with their sills at y=0.08 — a 1.6 m eye
 *              sits a little under the middle of a maw, as it should.
 *   orientation +Y up, -Z forward. Station 00 is on -Z and they run clockwise;
 *              CoinSpawn heights (1.65 m) match the existing coin play space.
 *   origin     PlayerOrigin is at (0,0,0) — the model is already centred on the
 *              player, so it needs no transform of any kind.
 *
 * All three are asserted at load (see the hard checks below), so a re-export
 * that breaks one of them falls back rather than shipping a broken room.
 *
 * ── GLB FIRST, PANORAMA ONLY ON REAL FAILURE ────────────────────────────────
 * Identical policy to the Gold Arena, and for the identical reason: UNKNOWN IS
 * NOT WEAK. Safari does not implement deviceMemory, so a "treat unknown as
 * weak" gate demotes every iPhone — which is the regression P36 fixed. Phones
 * get the GLB. The panorama is for a genuine load/validation failure or a
 * device that MEASURES as weak (<=2 GB or <=2 cores).
 *
 * ── THE SEAL CHECK IS NOT A PER-LOAD COST ───────────────────────────────────
 * P39's lesson, carried over: validateFromInside is 4096 rays against an
 * un-accelerated shell and it owned the main thread for 18.7 s. It runs in dev
 * or with ?validate, never on a player's load, and even then time-sliced.
 * ?validate=0 opts out in dev.
 */

// ── Validation policy ────────────────────────────────────────────────────────
const CARN_VALIDATE = (() => {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('validate') === '0') return false;
    return import.meta.env.DEV || q.has('validate');
  } catch { return false; }
})();

// MEASURED against this exact asset with validateFromInside: 4096 rays from the
// 1.65 m eye point, 0 escaped, nearest hit 1.65 m (the floor underfoot), furthest
// 16.61 m (the canopy across the room). It took 42 s of sliced wall clock, which
// is precisely why it does not run on a player's load — the result is fixed for
// a fixed asset. Reported in production so the seal state is STATED, not silently
// skipped, and ?validate re-derives it whenever the asset changes.
const SEAL_QA_RESULT = {
  rays: 4096, misses: 0, missRatio: 0, sealed: true,
  minDistanceM: 1.65, maxDistanceM: 16.611,
  source: 'QA (validated in-engine, ?validate to re-run)',
};

const MIN_SPAN_M    = 12;
const MAX_SPAN_M    = 60;
// 565k triangles is 4x the Gold Arena, and that is not slack: it is 12 trees,
// a full canopy and 105k triangles of flowers, and decimating an artist's
// foliage to hit a number the hardware does not care about would be the wrong
// trade. The budget is what THIS class of asset costs, and the frame cost is
// reported at load so a regression is attributable rather than assumed.
const MAX_TRIANGLES = 700000;
const MAX_APERTURE_SILL_Y = 1.2;  // a maw whose sill is above this is not a doorway

let _state = { status: 'idle', source: null, root: null, shell: null, diagnostics: null };
let _promise = null;
const _readyCbs = [];

let _doors = null;
let _mood = null;

export function getCarnivorousState()  { return _state; }
export function isCarnivorousReady()   { return _state.status === 'ready'; }
export function getCarnivorousDoors()  { return _doors; }
export function onCarnivorousReady(cb) { _readyCbs.push(cb); if (isCarnivorousReady()) cb(_state); }

/** Idempotent. Starts (or returns) the load. */
export function loadCarnivorous() {
  if (_promise) return _promise;
  _state.status = 'loading';
  _promise = _load().then((s) => {
    _state = s;
    _readyCbs.forEach((cb) => { try { cb(_state); } catch (e) { console.warn('[carn] ready cb', e); } });
    return _state;
  });
  return _promise;
}
export function whenCarnivorousReady() { return loadCarnivorous(); }

async function _load() {
  const t0 = performance.now();

  if (!preferGlbArena()) {
    console.log('[carn] device measures as weak → 360 panorama');
    return buildPanorama({ reason: 'measured low-capability device (<=2GB RAM or <=2 cores)' });
  }

  try {
    const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/loaders/DRACOLoader.js'),
    ]);
    const loader = new GLTFLoader();
    // Draco + WebP: 16.05 MB -> 2.37 MB. Same self-hosted decoder the gun and
    // the Gold Arena already use, so it is warm in cache by the time anyone
    // picks this skin.
    const draco = new DRACOLoader();
    draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    draco.preload();
    loader.setDRACOLoader(draco);

    const gltf = await loader.loadAsync(carnGlbUrl);
    const root = gltf.scene;
    root.name = 'SatsArena_Carnivorous_v2';

    const shell = root.getObjectByName('Environment_Carnivorous') || root;
    const diag  = inspect(root, shell);
    diag.loadMs = Math.round(performance.now() - t0);

    const seal = CARN_VALIDATE ? await validateFromInside(shell) : { ...SEAL_QA_RESULT, skipped: true };
    diag.seal  = seal;
    const span = Math.max(diag.sizeMetres.x, diag.sizeMetres.z);

    // ── The hard checks: the measured contract, asserted ──────────────────
    const failures = [];
    if (seal.missRatio > 0.005)         failures.push(`not sealed (${(seal.missRatio * 100).toFixed(2)}% of rays escaped)`);
    if (span < MIN_SPAN_M || span > MAX_SPAN_M) failures.push(`scale out of range (${span.toFixed(1)} m span)`);
    if (diag.triangles > MAX_TRIANGLES) failures.push(`over triangle budget (${diag.triangles})`);
    if (Math.abs(diag.floorY) > 0.25) failures.push(`floor is not at y=0 (${diag.floorY})`);
    if (!diag.maws)                     failures.push('no Door_NN maws — nothing for P47 to come out of');
    if (diag.mawSillY > MAX_APERTURE_SILL_Y) failures.push(`maws sit too high (sill y=${diag.mawSillY})`);
    diag.failures = failures;

    if (failures.length) {
      console.warn('[carn] GLB failed hard checks → panorama fallback: ' + failures.join('; '));
      return buildPanorama({ reason: failures.join('; '), glbDiagnostics: diag });
    }

    prepareForRuntime(root);
    root.userData.keepAlive = true;   // the seam detaches rather than disposes this

    _doors = buildCarnivorousDoors(root);
    diag.doors = _doors?.stats || null;
    exposeDoorDevTools(_doors);
    diag.warmMs = await warmGpu(root, 'Carnivorous GLB');

    console.log(`[carn] GLB accepted — ${diag.triangles} tris, ` +
      `${diag.sizeMetres.x}x${diag.sizeMetres.z} m, ${diag.maws} maws, ` +
      `seal ${seal.misses}/${seal.rays} misses${seal.skipped ? ' (QA-recorded; ?validate to re-run)' : ' (re-run in-engine)'}`);
    return { status: 'ready', source: 'glb', root, shell, diagnostics: diag };
  } catch (err) {
    console.warn('[carn] GLB load failed → panorama fallback', err);
    return buildPanorama({ reason: `GLB load error: ${err?.message || err}` });
  }
}

function inspect(root, shell) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(shell);
  const size = box.getSize(new THREE.Vector3());

  let triangles = 0, meshes = 0, maws = 0, mawSillY = Infinity;
  const materials = new Set();
  root.traverse((o) => {
    if (/^Door_\d+$/.test(o.name || '')) {
      maws++;
      const b = new THREE.Box3().setFromObject(o);
      mawSillY = Math.min(mawSillY, b.min.y);
    }
    if (!o.isMesh || !o.geometry) return;
    meshes++;
    const g = o.geometry;
    triangles += g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) materials.add(m.name || m.uuid);
  });

  // The FLOOR node, not the shell's lowest point: root-work and tree bases dip
  // ~0.36 m below the floor plane by design, so a whole-shell minimum would
  // report the arena as mis-scaled when it is exactly right.
  const floorNode = root.getObjectByName('Floor');
  const floorY = floorNode
    ? new THREE.Box3().setFromObject(floorNode).min.y
    : box.min.y;

  return {
    triangles: Math.round(triangles),
    meshes,
    materials: materials.size,
    maws,
    mawSillY: Number.isFinite(mawSillY) ? +mawSillY.toFixed(2) : null,
    sizeMetres: { x: +size.x.toFixed(2), y: +size.y.toFixed(2), z: +size.z.toFixed(2) },
    floorY: +floorY.toFixed(3),
    lowestPointY: +box.min.y.toFixed(3),
    ceilingY: +box.max.y.toFixed(3),
    hasPlayerOrigin: !!root.getObjectByName('PlayerOrigin'),
    coinAnchors: (() => { let n = 0; root.traverse((o) => { if (o.name?.startsWith('CoinSpawn_')) n++; }); return n; })(),
  };
}

function prepareForRuntime(root) {
  // ── KHR_materials_transmission is OFF, and it is worth saying why ─────────
  // Two petal materials ship transmission 0.20 / 0.22 with thickness 0. In
  // three, ANY transmissive material makes the renderer draw the WHOLE SCENE a
  // second time into a transmission target: measured here, 105 draw calls and
  // 1,112,652 triangles per frame with it, 54 calls and 557,286 without. That
  // is double the frame cost, on a mobile GPU, in stereo — bought for a
  // barely-perceptible translucency on petals that are already emissive and
  // seen from ten metres below in a dark room. Not a trade worth making.
  const seen = new Set();
  let dropped = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || seen.has(m.uuid) || !(m.transmission > 0)) continue;
      seen.add(m.uuid);
      m.transmission = 0;
      m.needsUpdate = true;
      dropped++;
    }
  });
  if (dropped) console.log(`[carn] transmission disabled on ${dropped} materials — halves the frame (no second scene pass)`);

  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;   // no shadow maps configured; keep it cheap on Quest
    o.frustumCulled = true;
  });
  root.updateMatrixWorld(true);
}

// ── Panorama fallback ────────────────────────────────────────────────────────
/**
 * A 2048x1024 equirectangular render of this same room. The shell itself comes
 * from arena-glb.js so the P38 fixes (UVMapping, inverted geometry, fog:false)
 * are not re-derived here. No nadir disc: unlike the Gold Arena's flat marble,
 * this floor is dark red root-work whose nadir row reads as floor already, and
 * a Bitcoin mark underfoot would be the wrong furniture in this room.
 */
function buildPanorama(info) {
  const root = new THREE.Group();
  root.name = 'SatsArena_Carnivorous_Panorama';
  root.add(buildEquirectShell(carnPanoUrl, { name: 'CarnivorousPanoramaShell' }));
  root.userData.keepAlive = true;
  warmGpu(root, 'carnivorous panorama');
  return {
    status: 'ready',
    source: 'panorama',
    root,
    shell: root,
    diagnostics: { ...info, panorama: { radius: 40, nadirCover: false } },
  };
}

// ── Skin group attachment ────────────────────────────────────────────────────

/** Attach the loaded arena into a skin group. Synchronous once ready. */
export function attachCarnivorousInto(group) {
  if (!_state.root) return false;
  group.add(_state.root);           // re-parents from any previous skin group
  _mood = buildCarnivorousMood(group, _state.root);
  return true;
}

/** The mood rig is rebuilt per attach, so it is torn down with the skin group. */
export function getCarnivorousMood() { return _mood; }
export function onCarnivorousTeardown() { _mood = null; }

/** Ticked by the skin while it is the active one. */
export function updateCarnivorous(dt) {
  _doors?.update(dt);
  _mood?.update(dt);
}

// ── ?dev tools ───────────────────────────────────────────────────────────────
function isDev() {
  try { return import.meta.env.DEV || new URLSearchParams(location.search).has('dev'); }
  catch { return false; }
}

// Exposed at IMPORT time, not after loading, so a headless check has something
// to pull the trigger with. It also has to exist before the load, because a
// check that reaches for this module with a dynamic import() gets a SECOND
// instance under Vite dev — with its own state, its own copy of the GLB, and a
// door API driving a root that is not the one in the scene. Everything here is
// the app's own instance, and that is the point.
if (isDev()) {
  window.__carn = {
    load: () => loadCarnivorous(),
    isReady: () => isCarnivorousReady(),
    state: () => getCarnivorousState(),
    update: (dt) => updateCarnivorous(dt),
    doors: () => _doors,
    mood: () => _mood,
  };
}

/**
 * The same handles the Gold Arena exposes, so the door trigger is one habit
 * across skins:
 *   window.__carnDoors               the full API
 *   window.__carnDoors.openRandom()  dilate a random shut maw
 *   press O / C                      open / close a random maw
 */
function exposeDoorDevTools(doors) {
  if (!doors) return;
  if (!isDev()) return;

  const pick = (wantOpen) => {
    const ids = doors.listDoors().filter((id) => (doors.openness(id) === 1) === wantOpen);
    return ids.length ? ids[Math.floor(Math.random() * ids.length)] : null;
  };
  doors.openRandom  = () => { const id = pick(false); if (id) doors.openDoor(id);  return id; };
  doors.closeRandom = () => { const id = pick(true);  if (id) doors.closeDoor(id); return id; };

  window.__carnDoors = doors;
  window.addEventListener('keydown', (e) => {
    // Only while Carnivorous is the skin actually on screen — otherwise O and C
    // would drive two arenas at once from one key press.
    if (!doors.group.parent) return;
    if (e.key === 'o' || e.key === 'O') console.log('[carn-doors] open',  doors.openRandom());
    if (e.key === 'c' || e.key === 'C') console.log('[carn-doors] close', doors.closeRandom());
  });
  console.log(`[carn-doors] ?dev tools ready — window.__carnDoors, or press O / C (${doors.count} maws)`);
}
