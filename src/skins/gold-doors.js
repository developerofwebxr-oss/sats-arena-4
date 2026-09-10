import * as THREE from 'three';

/**
 * gold-doors.js — the Gold Arena's 42 target panels, turned into openable doors.
 *
 * STEP 1 of "Satoshi pops out of a door, +42". This file is the doors and their
 * animation ONLY: no face, no scoring, no spawn logic. Those are P42, and the
 * API at the bottom is shaped for them.
 *
 * ── What the asset actually gives us ────────────────────────────────────────
 * The GLB is merged BY MATERIAL, not per panel — there is no "Panel_04_1" mesh
 * to grab. But two things in the export make this easy anyway:
 *
 *   1. GameplayAnchors ships 42 empties named Target_<section>_<row>, three per
 *      wall section across 14 sections (bays 08 and 16 are the two gates, so
 *      they have no panels). Each anchor sits at the centre of a panel, and its
 *      local +Z points INTO the arena. That is the door frame, handed to us.
 *
 *   2. Architecture_7 — material "Panel" — is EXACTLY 1,848 triangles, and
 *      1,848 / 42 = 44. That mesh is precisely the 42 panels and nothing else.
 *
 * So a door leaf is not modelled or approximated: the 44 triangles of one real
 * panel are lifted out of Architecture_7 into anchor-local space and become the
 * leaf geometry. The original merged mesh is then hidden and all 42 leaves are
 * drawn as ONE InstancedMesh using the SAME geometry and the SAME material
 * instance. A closed door is therefore not "close to" the old panel — it is the
 * old panel's triangles, in the old panel's place, with the old material.
 *
 * ── Why hinged, not sliding ─────────────────────────────────────────────────
 * The panels sit in a classical arcade — arched bays, pilasters, stone and
 * bronze. A slide reads industrial: it implies a track, a pocket for the leaf to
 * disappear into, and machinery this architecture does not have. A hinged swing
 * is what a shuttered opening in a colonnade does, it needs no hidden pocket,
 * and the leaf swinging INTO the room announces itself from across the arena,
 * which is exactly what a thing about to pop out of the wall should do.
 *
 * Hinge is the leaf's left edge, axis vertical, opening 105 degrees into the
 * arena. The instance matrix is
 *     anchor.matrixWorld * T(hinge) * Ry(theta) * T(-hinge)
 * so the geometry itself never moves in its own space and one shared buffer
 * serves all 42.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 * Leaves:      1 draw call, 42 instances x 44 tris. Net NEW triangles: 0 — the
 *              same 1,848 that Architecture_7 was already drawing.
 * Void planes: 1 draw call, 42 quads = 84 triangles.
 * Edge glow:   1 draw call, 0 triangles (line segments).
 * Per frame:   only doors actually in motion write a matrix; a scene with no
 *              moving door does no work beyond an early-out.
 *
 * ── Scoping ─────────────────────────────────────────────────────────────────
 * Everything is parented to the ARENA ROOT, which is Gold-only, is marked
 * userData.keepAlive, and is re-parented into the "skin:gold-arena" group on
 * each switch. So: Classic cannot see any of it, the P30 teardown detaches it
 * with the arena instead of disposing it (and clears its skinId, so the leak
 * assertion stays clean), and armode.js's environment.visible = false hides the
 * doors along with the arena in AR passthrough. No second visibility writer.
 */

// ── Tuning ───────────────────────────────────────────────────────────────────
const OPEN_ANGLE   = THREE.MathUtils.degToRad(105);
const OPEN_SECONDS  = 0.55;   // deliberate, not instant
const CLOSE_SECONDS = 0.45;   // closing a little brisker reads as sprung
const GLOW_COLOUR   = new THREE.Color(0xffb347);
const GLOW_HELD     = 0.22;   // faint steady rim while a door is held open
const VOID_INSET    = 0.005;  // keep the black plane just inside the leaf's edge

/**
 * WHERE THE BLACK PLANE GOES, and why it is not simply "behind the leaf".
 *
 * The panel is a STACK, not a single plate. Measured in anchor-local space
 * (larger z = nearer the player):
 *     Amber  bullseye        -0.33
 *     Gold   border/ring/studs  -0.37 .. -0.25
 *     Panel  dark field        -0.46 .. -0.38   <- the leaf
 *     Bronze backing plate     -0.63 .. -0.45
 *
 * The first attempt put the void plane behind the leaf, at -0.48 — which is
 * inside the BRONZE backing plate, so it was buried and an open door revealed a
 * lit bronze plate instead of darkness.
 *
 * It goes at the leaf's own MID-DEPTH instead. That is in front of the bronze
 * backing (so the backing is hidden), and behind the leaf's front face (so a
 * closed door is unchanged — the leaf is an opaque slab and you only ever see
 * its front). The gold border and ring stay in front of it, still on the wall,
 * which is right: a frame does not swing with the door it frames.
 */
const VOID_DEPTH_FRAC = 0.5;  // 0 = leaf's back face, 1 = its front face

/** Deliberate ease — slow to start, slow to land, quick through the middle. */
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Build the doors into an already-loaded Gold Arena root.
 * Idempotent: calling it twice returns the same API rather than doubling up.
 * @param {THREE.Object3D} arenaRoot the loaded GLB root (userData.keepAlive)
 * @returns {object|null} the door API, or null if the asset is not as expected
 */
export function buildGoldDoors(arenaRoot) {
  if (!arenaRoot) return null;
  if (arenaRoot.userData.goldDoors) return arenaRoot.userData.goldDoors;

  arenaRoot.updateMatrixWorld(true);

  // ── 1. The anchors ────────────────────────────────────────────────────────
  const anchors = [];
  arenaRoot.traverse((o) => {
    if (/^Target_\d+_\d+$/.test(o.name || '')) anchors.push(o);
  });
  anchors.sort((a, b) => a.name.localeCompare(b.name));
  if (!anchors.length) {
    console.warn('[doors] no Target_* anchors in the arena — doors not built');
    return null;
  }

  // ── 2. The panel mesh, and one panel's triangles ──────────────────────────
  const panelMesh = findPanelMesh(arenaRoot);
  if (!panelMesh) {
    console.warn('[doors] could not find the "Panel" mesh — doors not built');
    return null;
  }

  const leaf = extractLeafGeometry(panelMesh, anchors[0]);
  if (!leaf) {
    console.warn('[doors] could not extract a leaf from the panel mesh — doors not built');
    return null;
  }
  const { geometry: leafGeo, box: leafBox } = leaf;

  // The originals are now drawn by the InstancedMesh instead. Hiding rather than
  // deleting keeps this reversible and leaves the GLB's buffers untouched, which
  // matters because the arena root is cached and re-parented, never re-parsed.
  panelMesh.visible = false;

  const group = new THREE.Group();
  group.name = 'GoldArenaDoors';
  arenaRoot.add(group);

  // ── 3. Leaves: one instanced draw call for all 42 ─────────────────────────
  const leaves = new THREE.InstancedMesh(leafGeo, panelMesh.material, anchors.length);
  leaves.name = 'DoorLeaves';
  leaves.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // An InstancedMesh's bounds come from the source geometry, not the instances,
  // so the default cull test is meaningless here.
  leaves.frustumCulled = false;
  group.add(leaves);

  // Hinge on the leaf's left edge (local -X), axis vertical, at the leaf's
  // mid-depth so the leaf pivots in its own plane rather than about its face.
  const hinge = new THREE.Vector3(leafBox.min.x, 0, (leafBox.min.z + leafBox.max.z) / 2);

  // ── 4. Void planes: what an open door reveals ─────────────────────────────
  // One merged geometry, 42 quads, drawn as a single unlit black surface. It sits
  // just behind the leaf and slightly inside its outline, so a CLOSED door hides
  // it completely — the arena is unchanged until something opens.
  const voidGeo = buildVoidPlanes(anchors, leafBox);
  const voids = new THREE.Mesh(voidGeo, new THREE.MeshBasicMaterial({
    color: 0x000000,
    // fog:false so a door on the far side of the arena reveals the same absolute
    // black as one next to you — scene.fog would otherwise lift the far ones
    // toward the background and they would stop reading as openings.
    fog: false,
    side: THREE.FrontSide,
  }));
  voids.name = 'DoorVoids';
  voids.frustumCulled = false;
  group.add(voids);

  // ── 5. Edge glow: light spilling from the opening while it moves ──────────
  // One LineSegments for all 42 frames, zero triangles. Per-vertex colour, so a
  // single shared material still gives per-door intensity; doors that are shut
  // are written black, which is invisible under additive blending.
  const glow = buildGlowFrames(anchors, leafBox);
  glow.name = 'DoorGlow';
  glow.frustumCulled = false;
  group.add(glow);
  const glowColours = glow.geometry.attributes.color;
  const GLOW_VERTS_PER_DOOR = glowColours.count / anchors.length;

  // ── 6. State ──────────────────────────────────────────────────────────────
  /** @type {Array<{id:string,index:number,anchor:THREE.Object3D,t:number,target:number,moving:boolean}>} */
  const doors = anchors.map((anchor, index) => ({
    id: anchor.name, index, anchor, t: 0, target: 0, moving: false,
  }));
  const byId = new Map(doors.map((d) => [d.id, d]));

  const openedCbs = [];
  const closedCbs = [];
  const _m = new THREE.Matrix4();
  const _rot = new THREE.Matrix4();
  const _toHinge = new THREE.Matrix4();
  const _fromHinge = new THREE.Matrix4();
  _toHinge.makeTranslation(-hinge.x, -hinge.y, -hinge.z);
  _fromHinge.makeTranslation(hinge.x, hinge.y, hinge.z);

  function writeMatrix(d) {
    // Negative angle so the free edge sweeps toward local +Z, i.e. into the arena.
    const theta = -OPEN_ANGLE * easeInOutCubic(d.t);
    _rot.makeRotationY(theta);
    _m.copy(d.anchor.matrixWorld)
      .multiply(_fromHinge)
      .multiply(_rot)
      .multiply(_toHinge);
    leaves.setMatrixAt(d.index, _m);
  }

  function writeGlow(d) {
    // Brightest mid-swing (that is when light would spill), settling to a faint
    // steady rim while the door is held open.
    const moving = Math.sin(Math.PI * d.t);
    const level = Math.max(moving * 0.9, d.target === 1 && !d.moving ? GLOW_HELD : 0)
                * (d.t > 0.001 ? 1 : 0);
    const base = d.index * GLOW_VERTS_PER_DOOR;
    for (let i = 0; i < GLOW_VERTS_PER_DOOR; i++) {
      glowColours.setXYZ(base + i, GLOW_COLOUR.r * level, GLOW_COLOUR.g * level, GLOW_COLOUR.b * level);
    }
  }

  // Closed is the boot state, and it must match the untouched arena exactly.
  for (const d of doors) { writeMatrix(d); writeGlow(d); }
  leaves.instanceMatrix.needsUpdate = true;
  glowColours.needsUpdate = true;

  // ── 7. Animation ──────────────────────────────────────────────────────────
  let movingCount = 0;
  function update(dt) {
    if (!movingCount) return;          // nothing in motion — genuinely free
    let matrixDirty = false, glowDirty = false;
    for (const d of doors) {
      if (!d.moving) continue;
      const secs = d.target > d.t ? OPEN_SECONDS : CLOSE_SECONDS;
      const step = dt / secs;
      if (d.target > d.t) d.t = Math.min(1, d.t + step);
      else                d.t = Math.max(0, d.t - step);
      writeMatrix(d); writeGlow(d);
      matrixDirty = glowDirty = true;
      if (d.t === d.target) {
        d.moving = false; movingCount--;
        writeGlow(d);                   // settle to the held-open rim, or to off
        (d.target === 1 ? openedCbs : closedCbs).forEach((cb) => {
          try { cb(d.id); } catch (e) { console.warn('[doors] callback', e); }
        });
      }
    }
    if (matrixDirty) leaves.instanceMatrix.needsUpdate = true;
    if (glowDirty) glowColours.needsUpdate = true;
  }

  function set(id, target, { emit = true } = {}) {
    const d = byId.get(id);
    if (!d) return false;
    if (d.target === target && !d.moving) {
      // Already settled where we were asked to go. Still tell the caller the
      // state is what it wanted — a host resync must be idempotent.
      return true;
    }
    d.target = target;
    if (!d.moving) { d.moving = true; movingCount++; }
    if (!emit) { /* callbacks still fire on arrival; `emit` is reserved for P42's wire layer */ }
    return true;
  }

  // ── 8. Public API — shaped for P42 ────────────────────────────────────────
  const api = {
    /** Every door id, in a stable order. Ids come from the asset's own anchors. */
    listDoors: () => doors.map((d) => d.id),
    count: doors.length,

    openDoor:  (id) => set(id, 1),
    closeDoor: (id) => set(id, 0),
    toggleDoor: (id) => set(id, byId.get(id)?.target === 1 ? 0 : 1),
    /** true once the door has finished opening; a door mid-swing is not open. */
    isOpen:   (id) => { const d = byId.get(id); return !!d && d.t === 1; },
    isMoving: (id) => !!byId.get(id)?.moving,
    /** 0 = shut, 1 = fully open, in between = mid-swing. */
    openness: (id) => byId.get(id)?.t ?? 0,

    onOpened: (cb) => { openedCbs.push(cb); return () => openedCbs.splice(openedCbs.indexOf(cb), 1); },
    onClosed: (cb) => { closedCbs.push(cb); return () => closedCbs.splice(closedCbs.indexOf(cb), 1); },

    /**
     * WHERE a door is, in world space. P42 needs this to place the face and to
     * aim it out of the opening; it is deliberately not the anchor object, so
     * nothing downstream can re-parent or mutate the GLB's own nodes.
     * @returns {{position:THREE.Vector3, quaternion:THREE.Quaternion}|null}
     */
    getDoorPose: (id) => {
      const d = byId.get(id);
      if (!d) return null;
      d.anchor.updateMatrixWorld(true);
      return {
        position: d.anchor.getWorldPosition(new THREE.Vector3()),
        quaternion: d.anchor.getWorldQuaternion(new THREE.Quaternion()),
      };
    },

    // ── Host-authoritative hooks (P42) ──────────────────────────────────────
    // The host decides which door opens and broadcasts it; a peer applies the
    // host's state verbatim. applyState is the peer side: it is idempotent, it
    // accepts a full snapshot so a late joiner converges in one message, and it
    // drives the SAME animation path as a local open so both players see the
    // same swing rather than a teleporting door.
    /** @returns {Record<string, 0|1>} every door's TARGET state, for the wire. */
    serializeState: () => Object.fromEntries(doors.map((d) => [d.id, d.target])),
    /** @param {Record<string, 0|1>} state */
    applyState: (state) => {
      if (!state) return;
      for (const [id, target] of Object.entries(state)) set(id, target ? 1 : 0, { emit: false });
    },
    /** Close everything — for a match reset, or leaving a session. */
    closeAll: () => { for (const d of doors) set(d.id, 0); },

    update,
    group,
    /** Reported so a perf regression in this feature is attributable. */
    stats: {
      doors: doors.length,
      leafTriangles: leafGeo.index
        ? leafGeo.index.count / 3
        : leafGeo.attributes.position.count / 3,
      addedTriangles: voidGeo.index
        ? voidGeo.index.count / 3
        : voidGeo.attributes.position.count / 3,
      drawCalls: 3,
      leafSize: [
        +(leafBox.max.x - leafBox.min.x).toFixed(3),
        +(leafBox.max.y - leafBox.min.y).toFixed(3),
        +(leafBox.max.z - leafBox.min.z).toFixed(3),
      ],
      mechanism: `hinge (left edge, ${Math.round(THREE.MathUtils.radToDeg(OPEN_ANGLE))}deg into the arena)`,
    },
  };

  arenaRoot.userData.goldDoors = api;
  console.log(`[doors] ${doors.length} gold-arena doors built — ` +
    `${api.stats.leafTriangles} tris/leaf in 1 instanced draw call, ` +
    `+${api.stats.addedTriangles} tris for the void planes`);
  return api;
}

// ── Asset spelunking ─────────────────────────────────────────────────────────

/** The merged mesh whose material is the target panel. */
function findPanelMesh(root) {
  let found = null;
  root.traverse((o) => {
    if (found || !o.isMesh) return;
    const m = [].concat(o.material)[0];
    if (m?.name === 'Panel') found = o;
  });
  return found;
}

/**
 * Lift ONE panel's triangles out of the merged mesh and express them in that
 * anchor's local frame, so the result can be instanced at every other anchor.
 *
 * Selection is by triangle centroid inside a generous box around the anchor.
 * The box is deliberately larger than a panel (the panels are ~1.3 x 1.0 and the
 * nearest neighbour is ~1.9 away vertically) so it cannot clip the panel, and
 * comfortably smaller than the gap to the next one so it cannot swallow two.
 */
function extractLeafGeometry(panelMesh, anchor) {
  panelMesh.updateMatrixWorld(true);
  anchor.updateMatrixWorld(true);
  const toLocal = anchor.matrixWorld.clone().invert().multiply(panelMesh.matrixWorld);

  const pos = panelMesh.geometry.attributes.position;
  const nrm = panelMesh.geometry.attributes.normal;
  const uv  = panelMesh.geometry.attributes.uv;
  const idx = panelMesh.geometry.index;
  const triCount = (idx ? idx.count : pos.count) / 3;

  // Normals must rotate but not translate.
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(toLocal);

  const HALF = new THREE.Vector3(1.0, 0.85, 0.6);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const outP = [], outN = [], outU = [];
  const box = new THREE.Box3();

  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx.getX(t * 3)     : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0).applyMatrix4(toLocal);
    b.fromBufferAttribute(pos, i1).applyMatrix4(toLocal);
    c.fromBufferAttribute(pos, i2).applyMatrix4(toLocal);
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    if (Math.abs(centroid.x) > HALF.x || Math.abs(centroid.y) > HALF.y ||
        Math.abs(centroid.z) > HALF.z) continue;

    for (const [v, i] of [[a, i0], [b, i1], [c, i2]]) {
      outP.push(v.x, v.y, v.z);
      box.expandByPoint(v);
      if (nrm) {
        const n = new THREE.Vector3().fromBufferAttribute(nrm, i)
          .applyMatrix3(normalMatrix).normalize();
        outN.push(n.x, n.y, n.z);
      }
      if (uv) outU.push(uv.getX(i), uv.getY(i));
    }
  }

  if (!outP.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(outP, 3));
  if (outN.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(outN, 3));
  if (outU.length) geo.setAttribute('uv', new THREE.Float32BufferAttribute(outU, 2));
  geo.computeBoundingSphere();
  return { geometry: geo, box };
}

/** One merged black quad per door, just behind and just inside each leaf. */
function buildVoidPlanes(anchors, leafBox) {
  const hw = (leafBox.max.x - leafBox.min.x) / 2 - VOID_INSET;
  const hh = (leafBox.max.y - leafBox.min.y) / 2 - VOID_INSET;
  const cx = (leafBox.max.x + leafBox.min.x) / 2;
  const cy = (leafBox.max.y + leafBox.min.y) / 2;
  const z  = leafBox.min.z + (leafBox.max.z - leafBox.min.z) * VOID_DEPTH_FRAC;

  const pos = [];
  const v = new THREE.Vector3();
  for (const anchor of anchors) {
    anchor.updateMatrixWorld(true);
    const corners = [
      [cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh],
    ].map(([x, y]) => v.set(x, y, z).applyMatrix4(anchor.matrixWorld).clone());
    // Wound so the face normal points into the arena, along the anchor's local
    // +Z. The other winding culls the plane from the only side anyone can see it
    // from, which looks exactly like the plane not existing — verified by
    // measuring the face normal against the inward direction, not by eye.
    for (const i of [0, 1, 2, 0, 2, 3]) pos.push(corners[i].x, corners[i].y, corners[i].z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** One merged rectangular outline per door, at the opening's plane. */
function buildGlowFrames(anchors, leafBox) {
  const hw = (leafBox.max.x - leafBox.min.x) / 2 + 0.012;
  const hh = (leafBox.max.y - leafBox.min.y) / 2 + 0.012;
  const cx = (leafBox.max.x + leafBox.min.x) / 2;
  const cy = (leafBox.max.y + leafBox.min.y) / 2;
  const z  = leafBox.min.z + (leafBox.max.z - leafBox.min.z) * VOID_DEPTH_FRAC;

  const pos = [], col = [];
  const v = new THREE.Vector3();
  for (const anchor of anchors) {
    anchor.updateMatrixWorld(true);
    const c = [
      [cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh],
    ].map(([x, y]) => v.set(x, y, z).applyMatrix4(anchor.matrixWorld).clone());
    for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0]]) {
      pos.push(c[i].x, c[i].y, c[i].z, c[j].x, c[j].y, c[j].z);
      col.push(0, 0, 0, 0, 0, 0);   // starts dark = invisible under additive
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
}
