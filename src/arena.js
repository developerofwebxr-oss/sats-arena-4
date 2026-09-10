import * as THREE from 'three';

/**
 * buildArena(scene, opts) — adds purely decorative arena geometry.
 *
 * Four walls: each is a dark panel + a glowing neon edge outline, plus a cyan
 * accent ring at the top of the walls.
 * Using MeshBasicMaterial and LineBasicMaterial — zero lighting cost.
 *
 * ── Nothing here is load-bearing ────────────────────────────────────────────
 * "Decorative" is literal, and it is worth stating because P50 hides parts of
 * it: this module exports buildArena and nothing else, and the only importer is
 * skins/registry.js. The LOGICAL play bounds live somewhere else entirely —
 * coin spawn is SPAWN_MODES (rMin/rMax) in targets.js, and movement.js has no
 * positional clamp at all. Neither reads anything from this file, so hiding
 * geometry here cannot move a spawn or a limit.
 *
 * ── Per-skin visibility (P50) ───────────────────────────────────────────────
 * From inside the arena, the wall outlines' TOP edges and the accent ring are
 * the thin orange and cyan lines that cross overhead — very visible in a
 * headset, where you actually look up. Classic turns both off for a cleaner
 * void. They are two separate options rather than one, because they are two
 * different objects and the owner may want either back on its own.
 *
 * Defaults are the ORIGINAL look, so any future caller that omits opts gets
 * exactly what shipped; only the skin that opts out changes.
 *
 * @param {THREE.Object3D} scene   parent to build into (a skin group)
 * @param {object} [opts]
 * @param {boolean} [opts.showWallEdges=true]    the neon wall outlines
 * @param {boolean} [opts.showCeilingRing=true]  the cyan ring at wall height
 */
export function buildArena(scene, { showWallEdges = true, showCeilingRing = true } = {}) {
  const WALL_WIDTH  = 20;
  const WALL_HEIGHT = 6;
  const RADIUS      = 10; // half-distance from centre to wall face

  // Neon Bitcoin-orange for the edge glow; dark fill for the panel itself.
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xf7931a });
  const panelMat = new THREE.MeshBasicMaterial({
    color: 0x0a0a14,
    side: THREE.FrontSide,
    transparent: true,
    opacity: 0.55,
  });

  // Four cardinal directions: angle in radians, then we rotate each wall to face centre.
  const wallAngles = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];

  wallAngles.forEach((angle) => {
    // ── Panel ──────────────────────────────────────────────────────────────
    const geo   = new THREE.PlaneGeometry(WALL_WIDTH, WALL_HEIGHT);
    const panel = new THREE.Mesh(geo, panelMat);

    // Position at radius, then rotate to face inward.
    panel.position.set(
      Math.sin(angle) * RADIUS,
      WALL_HEIGHT / 2,            // raise so bottom sits on the floor
      Math.cos(angle) * RADIUS,
    );
    panel.rotation.y = angle;
    panel.name = 'ArenaWallPanel';
    scene.add(panel);

    // ── Glowing edge outline ───────────────────────────────────────────────
    // EdgesGeometry extracts only the border edges — 1 draw call per wall.
    // The PANEL always stays: it is what gives the play space a floor-to-wall
    // boundary you can read. Only the outline is optional.
    if (showWallEdges) {
      const edges    = new THREE.EdgesGeometry(geo);
      const outline  = new THREE.LineSegments(edges, edgeMat);
      outline.name = 'ArenaWallEdge';

      // Copy the same transform as the panel so the outline sits exactly on it.
      outline.position.copy(panel.position);
      outline.rotation.copy(panel.rotation);
      scene.add(outline);
    }
  });

  // ── Ceiling accent ring ────────────────────────────────────────────────────
  // A simple ring at the top of the walls gives a "dome" feel without geometry cost.
  if (!showCeilingRing) return;
  const ringGeo = new THREE.RingGeometry(RADIUS - 0.05, RADIUS + 0.05, 32);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x00e5ff, // cyan — part of the new secondary neon palette
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.3,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.name = 'ArenaCeilingRing';
  ring.rotation.x = -Math.PI / 2; // lay flat
  ring.position.y = WALL_HEIGHT;
  scene.add(ring);
}
