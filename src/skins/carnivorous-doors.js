import * as THREE from 'three';

/**
 * carnivorous-doors.js — the Conservatory's 12 maws, made openable.
 *
 * Same contract as gold-doors.js (P41), because P42b's door-target system and
 * P47's Snapper consume the API, not the asset: listDoors / openDoor /
 * closeDoor / isOpen / isMoving / openness / onOpened / onClosed / getDoorPose /
 * serializeState / applyState / closeAll / update / group / stats.
 *
 * ── WHAT THE ASSET GIVES US, AND WHAT IT DOES NOT ───────────────────────────
 * Twelve nodes Door_00…Door_11, each four primitives:
 *
 *   Tunnel  384 tris   the throat receding into the wall
 *   Void     64 tris   an unlit black cap at the far end of the throat
 *   Flesh  4092 tris   the red lip ring around the mouth
 *   Bark   3336 tris   the trunk surround
 *
 * There is NO leaf, shutter or membrane anywhere in the model: every maw is a
 * permanently open hole. Gold could lift its 42 real panels out of the merged
 * mesh and hinge them; here there is nothing to hinge, so the closure has to be
 * BUILT — and building it is the whole design decision of this file.
 *
 * ── WHY AN IRIS, NOT A HINGED LEAF ──────────────────────────────────────────
 * A hinge implies a manufactured panel on hardware. These are wet lipped mouths
 * in a living trunk: what closes one is a sphincter. So each maw gets N blades
 * that meet at the centre when shut and RETRACT INTO THE LIP to open — the hole
 * dilates rather than a door swinging aside. It also solves the practical
 * problem a swing would create: there is no room for a leaf to swing into, and
 * a leaf standing proud of the wall would clip the trunks either side.
 *
 * The blade is one triangle whose BASE MIDPOINT IS ITS ORIGIN and whose apex
 * points inward at unit distance, so opening is a single scale on local X:
 *
 *     x-scale 1 → apex at the aperture centre  (shut: N blades tile a disc)
 *     x-scale 0 → apex at the rim              (open: collapsed into the lip)
 *
 * Nothing translates, so the blades cannot drift out from under the lip, and at
 * t=1 they are geometrically degenerate — invisible without needing a fade.
 * Neighbours overlap by BLADE_OVERLAP so no gap opens mid-dilation; the overlap
 * would be coplanar, so blades are staggered a few millimetres in depth, which
 * is also what real iris blades do.
 *
 * ── COST ────────────────────────────────────────────────────────────────────
 * Blades: 1 draw call, 12 x 9 instances x 2 tris = 216 triangles.
 * Rims:   1 draw call, 12 instanced quads (24 tris) carrying a painted glow,
 *         unlit and additive, tinted per door by openness so a dilating maw
 *         lights its own lip.
 * Per frame: doors not in motion cost one early-out.
 *
 * ── SCOPING ─────────────────────────────────────────────────────────────────
 * Everything is parented to the ARENA ROOT (not the skin group), exactly as
 * gold-doors is: the root is Carnivorous-only, is marked keepAlive, is
 * re-parented on each skin switch, and armode hides it with `environment` in
 * passthrough. One visibility writer, and the P30 leak assertion still governs.
 *
 * Matrices are built in ROOT-LOCAL space (rootInverse * door.matrixWorld, cached
 * once) rather than from world matrices per frame, so the instances stay correct
 * wherever the root is parented.
 */

// ── Tuning ───────────────────────────────────────────────────────────────────
const BLADES        = 9;      // odd, so no blade edge lines up with another
const BLADE_OVERLAP = 1.34;   // >1: neighbours overlap, no gap while dilating
const BLADE_STAGGER = 0.004;  // metres of depth per blade — layered, not coplanar
const APERTURE_PAD  = 1.05;   // blades reach slightly past the hole, under the lip
const MEMBRANE_SINK = 0.32;   // metres INTO the throat: the lip and a band of dark
                              // throat still read around a shut maw, so it looks
                              // like a closed mouth rather than a plate over a hole
const SWIRL         = 0.20;   // radians of twist across a full dilation
const TIP_WIDTH     = 1.0;    // parallel-sided: the only width that cannot gap

const OPEN_SECONDS  = 0.85;   // slower than gold's swing: this is muscle, not a hinge
const CLOSE_SECONDS = 1.25;   // and it closes slower still — reluctant
const RIM_HELD      = 0.30;   // steady rim glow while a maw is held open
const RIM_PEAK      = 0.62;   // mid-dilation: light spilling from the throat

// Wet red, taken from the asset's own Flesh/Glow materials.
const MEMBRANE_COLOUR = 0x2b0605;
const MEMBRANE_GLOW   = 0x1a0302;
const RIM_COLOUR      = new THREE.Color(0xff3a12);

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);

/**
 * @param {THREE.Object3D} arenaRoot the loaded Carnivorous GLB scene
 * @returns {object|null} the door API, or null if the asset has no maws
 */
export function buildCarnivorousDoors(arenaRoot) {
  if (!arenaRoot) return null;
  arenaRoot.updateMatrixWorld(true);

  const doorNodes = [];
  arenaRoot.traverse((o) => { if (/^Door_\d+$/.test(o.name || '')) doorNodes.push(o); });
  if (!doorNodes.length) {
    console.warn('[carn-doors] no Door_NN nodes in the arena — doors disabled');
    return null;
  }
  doorNodes.sort((a, b) => a.name.localeCompare(b.name));

  const rootInv = new THREE.Matrix4().copy(arenaRoot.matrixWorld).invert();

  // ── 1. Measure each maw from its own geometry ─────────────────────────────
  // The aperture is the Void cap (the hole's true cross-section); the mouth
  // PLANE is the Flesh lip. Together they give centre, size and facing without
  // a single hard-coded number — a re-export with different maws still works.
  const frames = [];
  for (const node of doorNodes) {
    const voidBox  = boxOfMaterial(node, 'Void', rootInv);
    const fleshBox = boxOfMaterial(node, 'Flesh', rootInv);
    if (!voidBox || !fleshBox) {
      console.warn(`[carn-doors] ${node.name}: no Void/Flesh primitive — skipped`);
      continue;
    }
    const back  = voidBox.getCenter(new THREE.Vector3());
    const mouth = fleshBox.getCenter(new THREE.Vector3());

    // Inward normal: from the back of the throat toward the mouth, flattened —
    // these maws are vertical, so any pitch in the measurement is noise.
    const inward = new THREE.Vector3(mouth.x - back.x, 0, mouth.z - back.z);
    if (inward.lengthSq() < 1e-6) inward.set(-mouth.x, 0, -mouth.z); // fallback: face the middle
    inward.normalize();

    const size = voidBox.getSize(new THREE.Vector3());
    const rx = 0.5 * Math.max(size.x, size.z) * APERTURE_PAD;  // half-width across the hole
    const ry = 0.5 * size.y * APERTURE_PAD;                    // half-height

    // Sit the membrane just inside the throat so the lip laps over its edge.
    const centre = mouth.clone().addScaledVector(inward, -MEMBRANE_SINK);

    // +Z faces INTO the arena, matching gold's Target_ anchors, so P42b's
    // getDoorPose contract is identical across skins.
    //
    // Matrix4.lookAt(eye, target, up) uses the CAMERA convention: the result's
    // -Z looks at `target`. So the eye goes at `inward` and the target at the
    // origin — that way +Z ends up along `inward`. Passing them the intuitive
    // way round gives a maw that faces the wall it is cut into.
    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(inward, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)));

    frames.push({
      id: node.name, node, centre, inward, rx, ry,
      // The plane the blades live in, with the aperture's own ellipse baked in.
      matrix: new THREE.Matrix4().compose(centre, q, new THREE.Vector3(rx, ry, 1)),
      // The rim glow belongs at the MOUTH, not down at the membrane: sunk with
      // the blades it is occluded by the lip and only a crescent of it shows.
      rimMatrix: new THREE.Matrix4().compose(
        mouth.clone().addScaledVector(inward, 0.16), q, new THREE.Vector3(rx, ry, 1)),
      quaternion: q,
    });
  }
  if (!frames.length) return null;

  // ── 2. Blade geometry: a parallel-sided blade, rim to centre ─────────────
  // The obvious shape is a wedge with its point at the centre, and it is wrong
  // twice over. Nine points open a nine-pointed STAR, which reads as clockwork
  // rather than muscle; and any blade that NARROWS toward the centre loses its
  // overlap with its neighbours on the way in, so black spikes appear between
  // them mid-dilation. Both are the same mistake — coverage at radius r needs
  // half-width r*tan(pi/N), so a blade of CONSTANT half-width tan(pi/N)*overlap
  // covers every radius from the rim inward and can never gap. The aperture
  // edge is then the row of blunt tips: a rounded nine-sided hole.
  const half = (Math.PI / BLADES) * BLADE_OVERLAP;
  const w0 = Math.tan(half);         // half-width at the rim
  const w1 = w0 * TIP_WIDTH;         // half-width at the tip
  const bladeGeo = new THREE.BufferGeometry();
  bladeGeo.setAttribute('position', new THREE.Float32BufferAttribute([
     0,  w0, 0,   0, -w0, 0,  -1, -w1, 0,     // base -> tip, first triangle
     0,  w0, 0,  -1, -w1, 0,  -1,  w1, 0,     // and the second
  ], 3));
  bladeGeo.setAttribute('normal', new THREE.Float32BufferAttribute(
    new Array(6).fill([0, 0, 1]).flat(), 3));
  bladeGeo.computeBoundingSphere();

  const membraneMat = new THREE.MeshStandardMaterial({
    color: MEMBRANE_COLOUR,
    emissive: MEMBRANE_GLOW,
    roughness: 0.42,
    metalness: 0.0,
    side: THREE.DoubleSide,   // seen from inside the throat during the dilation
  });
  membraneMat.name = 'CarnivorousMembrane';

  const blades = new THREE.InstancedMesh(bladeGeo, membraneMat, frames.length * BLADES);
  blades.name = 'CarnivorousDoorBlades';
  blades.frustumCulled = false;      // one object spanning the whole arena
  blades.castShadow = blades.receiveShadow = false;

  // ── 3. Rim glow: one unlit annulus per maw, tinted by openness ────────────
  // A QUAD WITH A SOFT TEXTURE, not a hard annulus. Two things went wrong with
  // the obvious ring: at the lip's own radius the lip torus swallowed most of
  // it and left a crescent, and a flat-shaded band of full-strength colour
  // reads as plastic rather than as light. This is a painted falloff, sat a
  // little proud of the mouth so nothing occludes it.
  const rimGeo = new THREE.PlaneGeometry(2.5, 2.5);
  const rims = new THREE.InstancedMesh(rimGeo, new THREE.MeshBasicMaterial({
    color: 0xffffff,                 // instanceColor supplies the actual level
    map: makeRimGlowTexture(),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,                      // a glow the fog must not swallow
    side: THREE.DoubleSide,
  }), frames.length);
  rims.name = 'CarnivorousDoorRims';
  rims.frustumCulled = false;
  rims.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(frames.length * 3), 3);

  // ── 4. State ──────────────────────────────────────────────────────────────
  const doors = frames.map((f, index) => ({ ...f, index, t: 0, target: 0, moving: false }));
  const byId = new Map(doors.map((d) => [d.id, d]));
  const openedCbs = [];
  const closedCbs = [];

  const _m = new THREE.Matrix4();
  const _blade = new THREE.Matrix4();
  const _spin = new THREE.Matrix4();
  const _scale = new THREE.Matrix4();
  const _depth = new THREE.Matrix4();
  // Puts the blade's BASE on the rim (local radius 1) with its apex reaching the
  // aperture centre. Without this the base sits at the centre and the blades
  // fan outward from a point — which tiles nothing and leaves a nine-pointed
  // star of open hole around the rim.
  const _toRim = new THREE.Matrix4().makeTranslation(1, 0, 0);

  function writeBlades(d) {
    const e = easeInOutCubic(d.t);
    for (let b = 0; b < BLADES; b++) {
      const angle = (b / BLADES) * Math.PI * 2 + SWIRL * e;
      _spin.makeRotationZ(angle);
      // The dilation itself: scaling about the base walks the apex from the
      // aperture centre out to the rim, and the blade narrows as it goes.
      _scale.makeScale(1 - e, 1 - 0.35 * e, 1);
      _depth.makeTranslation(0, 0, b * BLADE_STAGGER);
      _blade.copy(d.matrix).multiply(_depth).multiply(_spin).multiply(_toRim).multiply(_scale);
      blades.setMatrixAt(d.index * BLADES + b, _blade);
    }
  }

  function writeRim(d) {
    // Brightest mid-dilation — that is when the throat would spill light —
    // settling to a steady ember while the maw is held open.
    const moving = Math.sin(Math.PI * d.t);
    const level = Math.max(moving * RIM_PEAK, d.target === 1 && !d.moving ? RIM_HELD : 0);
    rims.setColorAt(d.index, _tmpCol.copy(RIM_COLOUR).multiplyScalar(level));
  }
  const _tmpCol = new THREE.Color();

  for (const d of doors) {
    _m.copy(d.rimMatrix);
    rims.setMatrixAt(d.index, _m);
    writeBlades(d);
    writeRim(d);
  }
  blades.instanceMatrix.needsUpdate = true;
  rims.instanceMatrix.needsUpdate = true;
  rims.instanceColor.needsUpdate = true;

  const group = new THREE.Group();
  group.name = 'CarnivorousDoors';
  group.add(blades, rims);
  arenaRoot.add(group);

  // ── 5. Animation ──────────────────────────────────────────────────────────
  let movingCount = 0;
  function update(dt) {
    if (!movingCount) return;
    for (const d of doors) {
      if (!d.moving) continue;
      const secs = d.target > d.t ? OPEN_SECONDS : CLOSE_SECONDS;
      const step = dt / secs;
      d.t = d.target > d.t ? Math.min(1, d.t + step) : Math.max(0, d.t - step);
      writeBlades(d);
      writeRim(d);
      if (d.t === d.target) {
        d.moving = false; movingCount--;
        writeRim(d);                    // settle to the held ember, or to nothing
        (d.target === 1 ? openedCbs : closedCbs).forEach((cb) => {
          try { cb(d.id); } catch (e) { console.warn('[carn-doors] callback', e); }
        });
      }
    }
    blades.instanceMatrix.needsUpdate = true;
    rims.instanceColor.needsUpdate = true;
  }

  function set(id, target, { emit = true } = {}) {
    const d = byId.get(id);
    if (!d) return false;
    if (d.target === target && !d.moving) return true;   // idempotent, for host resync
    d.target = target;
    if (!d.moving) { d.moving = true; movingCount++; }
    void emit;                                           // reserved for the wire layer
    return true;
  }

  // ── 6. Public API — identical in shape to gold-doors ──────────────────────
  const api = {
    listDoors: () => doors.map((d) => d.id),
    count: doors.length,

    openDoor:  (id) => set(id, 1),
    closeDoor: (id) => set(id, 0),
    toggleDoor: (id) => set(id, byId.get(id)?.target === 1 ? 0 : 1),

    isOpen:   (id) => { const d = byId.get(id); return !!d && d.t === 1; },
    isMoving: (id) => !!byId.get(id)?.moving,
    openness: (id) => byId.get(id)?.t ?? 0,

    onOpened: (cb) => { openedCbs.push(cb); return () => openedCbs.splice(openedCbs.indexOf(cb), 1); },
    onClosed: (cb) => { closedCbs.push(cb); return () => closedCbs.splice(closedCbs.indexOf(cb), 1); },

    /**
     * Where a thing emerging from this maw should stand, in WORLD space, with
     * +Z pointing into the arena — the same contract gold's anchors give, so
     * P42b/P47 need no per-skin branch.
     */
    getDoorPose: (id) => {
      const d = byId.get(id);
      if (!d) return null;
      arenaRoot.updateMatrixWorld(true);
      return {
        position: d.centre.clone().applyMatrix4(arenaRoot.matrixWorld),
        quaternion: new THREE.Quaternion()
          .setFromRotationMatrix(arenaRoot.matrixWorld).multiply(d.quaternion),
      };
    },

    serializeState: () => Object.fromEntries(doors.map((d) => [d.id, d.target])),
    applyState: (state) => {
      if (!state) return;
      for (const [id, target] of Object.entries(state)) set(id, target ? 1 : 0, { emit: false });
    },
    closeAll: () => { for (const d of doors) set(d.id, 0); },

    update,
    group,
    stats: {
      doors: doors.length,
      blades: BLADES,
      addedTriangles: doors.length * BLADES * 2 + doors.length * 2,
      drawCalls: 2,
      apertureMetres: [
        +(doors[0].rx * 2).toFixed(2),
        +(doors[0].ry * 2).toFixed(2),
      ],
      mechanism: `iris (${BLADES} blades retracting into the lip, ` +
        `${OPEN_SECONDS}s open / ${CLOSE_SECONDS}s close)`,
    },
  };

  arenaRoot.userData.carnivorousDoors = api;
  console.log(`[carn-doors] ${doors.length} maws armed — ${BLADES}-blade iris, ` +
    `${api.stats.addedTriangles} added tris in ${api.stats.drawCalls} draw calls, ` +
    `aperture ${api.stats.apertureMetres[0]}x${api.stats.apertureMetres[1]} m`);
  return api;
}

/**
 * A soft ring of light, painted once: transparent at the centre so the open
 * throat stays black, brightest just inside the aperture edge, faded to nothing
 * before the quad's own edge so there is no visible boundary.
 */
function makeRimGlowTexture() {
  const SIZE = 128;
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2);
  g.addColorStop(0.00, 'rgba(255,255,255,0)');
  g.addColorStop(0.58, 'rgba(255,255,255,0)');
  g.addColorStop(0.76, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.86, 'rgba(255,255,255,0.45)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Bounding box of the parts of `node` drawn with a given material, in the
 * arena root's own space. Material NAME is the handle the asset gives us —
 * the primitives arrive as unnamed children, but their materials keep the names
 * the model was authored with.
 */
function boxOfMaterial(node, materialName, rootInv) {
  const box = new THREE.Box3();
  let found = false;
  node.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (!mats.some((m) => m?.name === materialName)) return;
    o.updateWorldMatrix(true, false);
    const b = new THREE.Box3().setFromBufferAttribute(o.geometry.attributes.position);
    b.applyMatrix4(new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld));
    box.union(b);
    found = true;
  });
  return found ? box : null;
}
