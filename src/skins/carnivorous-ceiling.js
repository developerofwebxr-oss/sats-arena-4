import * as THREE from 'three';

/**
 * carnivorous-ceiling.js — the things overhead that are waiting for you.
 *
 * PURELY ATMOSPHERIC. No targets spawn here, nothing is shootable, nothing
 * scores. Their whole job is to make standing still in the middle of the room
 * feel like a bad idea.
 *
 * ── WHY THESE ARE BUILT AND NOT LIFTED FROM THE GLB ─────────────────────────
 * The arena already has 105,560 triangles of flowers in the canopy, and the
 * obvious move is to animate those. It does not work: `Flowers` is ONE mesh of
 * five merged primitives with every bloom baked into shared buffers, so there
 * is no per-flower node to rotate and no per-petal anything. Animating them
 * would mean splitting the artist's mesh apart by connected component at load
 * and rebuilding it as instances — expensive, fragile against a re-export, and
 * it would still leave the petals as rigid lumps because they have no hinge.
 *
 * So these are new, and they are cheap: ONE InstancedMesh of petals for every
 * bloom in the room, in one draw call, matching the asset's own palette so they
 * read as more of the same plant rather than as a bolted-on prop.
 *
 * ── THE HINGE ───────────────────────────────────────────────────────────────
 * A petal's geometry has its BASE AT THE ORIGIN and its tip along -Y, so the
 * whole animation is one rotation about the petal's own base:
 *
 *     clench  petals nearly vertical, tips gathered under the centre  (0.30 rad)
 *     bloom   petals swung down and out, throat open to the floor     (1.42 rad)
 *
 * Nothing translates and nothing scales, so a bloom cannot drift off its stem,
 * and the two extremes are a single lerp apart.
 *
 * ── THE RHYTHM, AND WHY IT IS NOT A SINE ────────────────────────────────────
 * A pure sine is a machine breathing. These use a slow base cycle per flower
 * (8–15 s, each its own period AND its own phase, so no two are ever in step)
 * with a second, much slower wobble beaten against it — the openness wanders,
 * pauses near the extremes, and never quite repeats. Every flower also gets a
 * HOLD at the top of its clench: the pause before something opens again is what
 * makes it read as deliberate rather than mechanical.
 *
 * ── WHY THEY DO NOT GET IN THE WAY ──────────────────────────────────────────
 * The maw band a player aims at tops out at 3.72 m and coins fly around 1.65 m.
 * The lowest point any petal reaches is COMPUTED at build time (a petal hangs
 * lowest when the bloom is clenched) and reported in the stats; it stays clear
 * of that band with room to spare. Nothing here is between the player and any
 * wall, and the blooms face DOWN, so from a 1.6 m eye they are silhouettes
 * overhead — there when you look up, out of the way when you are shooting.
 *
 * ── COST ───────────────────────────────────────────────────────────────────
 * Three draw calls: petals, throats, stalks. Stalk matrices are written once —
 * only the petals and the throat colours are touched per frame, and that is 48
 * matrices and 8 colours for the whole room.
 *
 * ── SCOPING ─────────────────────────────────────────────────────────────────
 * Parented into the SKIN GROUP (not the arena root), like the mood rig: the P30
 * teardown removes it with the skin, Classic and Gold can never inherit it, and
 * armode's `environment.visible = false` takes it down with everything else in
 * passthrough.
 */

// ── The bed ──────────────────────────────────────────────────────────────────
// Placed by hand rather than on a ring: a ring reads as a light fitting.
//
// HEIGHT IS THE WHOLE PLACEMENT PROBLEM. The first pass hung these at 7.5-9 m,
// which is INSIDE the asset's own canopy (Foliage 5.33-10.84 m, Flowers
// 5.19-12.54 m) — they were camouflaged against 105k triangles of coral bloom
// and read as more foliage. They now hang BELOW that layer, in the open air
// between the canopy and the player, where they are the only thing up there and
// are silhouetted against the lit canopy behind them.
//
// The floor of that band is set by the game, not by taste: the maw band a
// player aims at tops out at 3.72 m, so nothing may hang below ~4.5 m.
// [x, y, z, scale, periodSeconds, phase]
const BLOOMS = [
  [ -3.4, 6.35,  -2.6, 2.00, 11.5, 0.00 ],
  [  2.9, 6.15,  -4.1, 1.70,  9.2, 2.31 ],
  [  5.1, 6.60,   1.8, 2.20, 13.8, 4.02 ],
  [ -1.2, 6.05,   4.6, 1.85, 10.1, 1.14 ],
  [ -5.8, 6.20,   2.2, 2.05, 14.6, 3.47 ],
  [  0.6, 6.90,   0.4, 1.55, 12.4, 5.19 ],
  [  4.2, 6.10,   5.4, 1.75,  8.6, 0.72 ],
  [ -4.6, 6.75,  -5.9, 2.10, 15.0, 2.86 ],
];

const PETALS = 6;
const PETAL_LEN = 0.92;
const PETAL_WIDE = 0.40;
// Each bloom hangs from the canopy on a stalk, so it reads as GROWN from up
// there rather than floating. Cheap: a 3-sided open cylinder, 6 triangles.
const CANOPY_Y = 9.4;

const CLENCHED = 0.30;   // radians from vertical — tips gathered, throat shut
const BLOOMED  = 1.42;   // swung down and out, throat open to the floor
const HOLD     = 0.34;   // fraction of each cycle spent shut before it reopens

// The asset's own palette: Flesh/CoralPetal red outside, hotter inside, with the
// Glow material's colour on the throat so it matches the maws below.
// Darker on the outside than the asset's coral blooms and hotter in the throat:
// against a canopy that is already bright red, a bloom that matches it vanishes.
// These have to read as silhouettes with a light inside them.
const PETAL_COLOUR   = 0x3d0a09;
const PETAL_EMISSIVE = 0x59120a;
const STALK_COLOUR   = 0x2a0806;
const THROAT_COLOUR  = 0xff5a20;

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * @param {THREE.Object3D} group  the SKIN group — everything is parented here
 */
export function buildCarnivorousCeiling(group) {
  const root = new THREE.Group();
  root.name = 'CarnivorousCeiling';
  group.add(root);

  // ── Petal geometry: base at the origin, tip down -Y ───────────────────────
  // Four triangles: a tapered blade with a slight cup, which is enough shape to
  // catch the light differently as it swings and to not read as a flat card.
  const w = PETAL_WIDE / 2;
  const petalGeo = new THREE.BufferGeometry();
  petalGeo.setAttribute('position', new THREE.Float32BufferAttribute([
    // outer face, base -> waist -> tip
    -w, 0, 0,   w, 0, 0,   -w * 0.86, -PETAL_LEN * 0.55, 0.10,
     w, 0, 0,   w * 0.86, -PETAL_LEN * 0.55, 0.10,  -w * 0.86, -PETAL_LEN * 0.55, 0.10,
    -w * 0.86, -PETAL_LEN * 0.55, 0.10,   w * 0.86, -PETAL_LEN * 0.55, 0.10,  0, -PETAL_LEN, 0.03,
    // a small tongue back under the waist, so the petal has thickness in profile
    -w * 0.5, 0, 0,   w * 0.5, 0, 0,   0, -PETAL_LEN * 0.42, -0.07,
  ], 3));
  petalGeo.computeVertexNormals();
  petalGeo.computeBoundingSphere();

  const petalMat = new THREE.MeshStandardMaterial({
    color: PETAL_COLOUR,
    emissive: PETAL_EMISSIVE,
    emissiveIntensity: 2.2,
    roughness: 0.46,
    metalness: 0.0,
    side: THREE.DoubleSide,   // seen from underneath as often as from above
  });
  petalMat.name = 'CarnivorousBloomPetal';

  // ── Stalks: one per bloom, canopy down to the flower ─────────────────────
  const stalkMat = new THREE.MeshStandardMaterial({
    color: STALK_COLOUR, roughness: 0.6, metalness: 0, side: THREE.DoubleSide,
  });
  stalkMat.name = 'CarnivorousBloomStalk';
  const stalkGeo = new THREE.CylinderGeometry(0.05, 0.09, 1, 3, 1, true);
  stalkGeo.translate(0, 0.5, 0);      // base at the origin, growing up to the canopy
  const stalks = new THREE.InstancedMesh(stalkGeo, stalkMat, BLOOMS.length);
  stalks.name = 'CarnivorousBloomStalks';
  stalks.frustumCulled = false;
  stalks.castShadow = stalks.receiveShadow = false;
  root.add(stalks);

  const petals = new THREE.InstancedMesh(petalGeo, petalMat, BLOOMS.length * PETALS);
  petals.name = 'CarnivorousBloomPetals';
  petals.frustumCulled = false;      // one object spanning the whole canopy
  petals.castShadow = petals.receiveShadow = false;
  root.add(petals);

  // ── Throats: one unlit disc per bloom, brightening as it opens ────────────
  // Additive and tiny. It is what makes an opening flower look like it is lit
  // from inside — the same trick the maws use, and it ties the two together.
  const throatGeo = new THREE.CircleGeometry(0.42, 14);
  const throats = new THREE.InstancedMesh(throatGeo, new THREE.MeshBasicMaterial({
    color: 0xffffff,                 // instanceColor carries the level
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  }), BLOOMS.length);
  throats.name = 'CarnivorousBloomThroats';
  throats.frustumCulled = false;
  throats.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(BLOOMS.length * 3), 3);
  root.add(throats);

  // ── Per-bloom state ──────────────────────────────────────────────────────
  const blooms = BLOOMS.map(([x, y, z, scale, period, phase], i) => ({
    index: i,
    origin: new THREE.Vector3(x, y, z),
    scale,
    period,
    phase,
    // A second, much slower beat per flower. Deliberately not a divisor of the
    // period, so the pair never lines up and the motion never repeats exactly.
    wobble: 0.31 + (i % 5) * 0.047,
    // Each bloom is turned a little so no two present the same silhouette.
    yaw: (i * 2.399) % (Math.PI * 2),
  }));

  const _m = new THREE.Matrix4();
  const _petal = new THREE.Matrix4();
  const _spin = new THREE.Matrix4();
  const _tilt = new THREE.Matrix4();
  const _place = new THREE.Matrix4();
  const _scale = new THREE.Matrix4();
  const _col = new THREE.Color();
  const _throatCol = new THREE.Color(THROAT_COLOUR);

  /**
   * 0 = clenched, 1 = fully bloomed.
   *
   * The HOLD is why this is not a sine: the cycle spends its first third shut,
   * then opens and closes over the rest, so the room is mostly still and the
   * movement arrives when you are not watching for it.
   */
  function openness(b, t) {
    const cycle = ((t / b.period) + b.phase) % 1;
    if (cycle < HOLD) return 0;
    const k = (cycle - HOLD) / (1 - HOLD);              // 0..1 across the open phase
    const base = Math.sin(k * Math.PI);                 // out and back
    const drift = 0.5 + 0.5 * Math.sin(t * b.wobble + b.phase * 3.1);
    return Math.max(0, Math.min(1, base * (0.72 + 0.28 * drift)));
  }

  function write(b, open) {
    const angle = lerp(CLENCHED, BLOOMED, open);
    _place.makeTranslation(b.origin.x, b.origin.y, b.origin.z);
    _scale.makeScale(b.scale, b.scale, b.scale);
    for (let p = 0; p < PETALS; p++) {
      // Spin around the stem, then swing the petal out about its own base.
      _spin.makeRotationY(b.yaw + (p / PETALS) * Math.PI * 2);
      _tilt.makeRotationX(angle);
      _petal.copy(_place).multiply(_scale).multiply(_spin).multiply(_tilt);
      petals.setMatrixAt(b.index * PETALS + p, _petal);
    }
    // The throat faces straight down at the player and brightens with the bloom.
    _m.copy(_place).multiply(_scale).multiply(_tilt.makeRotationX(-Math.PI / 2));
    throats.setMatrixAt(b.index, _m);
    // Additive, so this goes well past 1: an open throat should be the
    // brightest thing overhead, and it is what separates these from the 105k
    // triangles of the asset's own (static, unlit-from-within) coral blooms.
    throats.setColorAt(b.index, _col.copy(_throatCol).multiplyScalar(0.06 + 1.45 * open));
  }

  // Stalks never move, so they are written once.
  {
    const _s = new THREE.Matrix4();
    const _len = new THREE.Matrix4();
    for (const b of blooms) {
      const len = Math.max(0.4, CANOPY_Y - b.origin.y);
      _len.makeScale(b.scale, len, b.scale);
      _s.makeTranslation(b.origin.x, b.origin.y, b.origin.z).multiply(_len);
      stalks.setMatrixAt(b.index, _s);
    }
    stalks.instanceMatrix.needsUpdate = true;
  }

  for (const b of blooms) write(b, openness(b, 0));
  petals.instanceMatrix.needsUpdate = true;
  throats.instanceMatrix.needsUpdate = true;
  throats.instanceColor.needsUpdate = true;

  let elapsed = 0;
  function update(dt) {
    elapsed += dt;
    for (const b of blooms) write(b, openness(b, elapsed));
    petals.instanceMatrix.needsUpdate = true;
    throats.instanceMatrix.needsUpdate = true;
    throats.instanceColor.needsUpdate = true;
  }

  // The lowest point ANY petal reaches, computed rather than eyeballed: a petal
  // hangs lowest when the bloom is CLENCHED, at stem height minus its own length
  // times the bloom's scale, times the cosine of the clench angle. The maw band
  // a player aims at tops out at 3.72 m, and this has to stay clear of it.
  const lowestPetalY = Math.min(...blooms.map(
    (b) => b.origin.y - PETAL_LEN * b.scale * Math.cos(CLENCHED)));

  const triangles = BLOOMS.length * (PETALS * 4 + throatGeo.index.count / 3 + 6);
  const stats = {
    blooms: BLOOMS.length,
    petalsEach: PETALS,
    triangles,
    drawCalls: 3,
    cycleSeconds: [Math.min(...BLOOMS.map((b) => b[4])), Math.max(...BLOOMS.map((b) => b[4]))],
    holdFraction: HOLD,
    heightRange: [Math.min(...BLOOMS.map((b) => b[1])), Math.max(...BLOOMS.map((b) => b[1]))],
    lowestPetalY: +lowestPetalY.toFixed(2),
    source: 'procedural — the GLB canopy is one merged mesh with no per-bloom node',
  };
  console.log(`[carn-ceiling] ${stats.blooms} blooms, lowest petal ${stats.lowestPetalY} m — ` +
    `${stats.triangles} tris in ${stats.drawCalls} draw calls, ` +
    `${stats.cycleSeconds[0]}-${stats.cycleSeconds[1]}s cycles, none in step`);

  return {
    update,
    group: root,
    stats,
    /** Test surface: what every bloom is doing right now. */
    debug: () => blooms.map((b) => +openness(b, elapsed).toFixed(3)),
  };
}
