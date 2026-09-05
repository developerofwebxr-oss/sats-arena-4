import * as THREE from 'three';

/**
 * appearance.js — reversible re-colouring of objects a skin does NOT own.
 *
 * The gun and the coins are spawned and owned by weapon.js / targets.js, which
 * are confirmed systems. A skin must not re-parent or rebuild them, so instead
 * it recolours them — reversibly.
 *
 * CLONE-AND-SWAP, NOT MUTATE. We never write into the shipped materials. We
 * clone each material, tint the clone, and point the mesh at it; restoring puts
 * the original material object back and disposes the clone. That means:
 *   - the ship-default materials are never corrupted, so "restore" is exact;
 *   - two skins can never compound each other's tint;
 *   - any other system that save/restores a material (weapon.js's fairness grey)
 *     operates on whatever material is currently assigned and stays internally
 *     consistent.
 *
 * KNOWN EDGE (flagged, not silently ignored): if the left gun is fairness-greyed
 * at the moment of a skin switch, weapon.js's grey bookkeeping still points at
 * the pre-swap material objects, so the grey TINT may be lost until the fairness
 * state next toggles. The gun stays functionally disabled either way — the gate
 * is notifyControllerFire(), not the colour — so this is cosmetic only.
 */

// root Object3D → array of { mesh, original } so restore is exact.
const _applied = new Map();

/**
 * Multiply `tint` into every material under `root`, reversibly.
 * Calling it twice on the same root is a no-op on the second call.
 */
export function applyTint(root, tint) {
  if (!root || tint == null || _applied.has(root)) return;

  const records = [];
  const cloneCache = new Map(); // share one clone per source material

  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const original = o.material;
    const mats = Array.isArray(original) ? original : [original];

    const tinted = mats.map((m) => {
      if (cloneCache.has(m)) return cloneCache.get(m);
      const c = m.clone();
      if (c.color) c.color.multiply(new THREE.Color(tint));
      c.needsUpdate = true;
      cloneCache.set(m, c);
      return c;
    });

    o.material = Array.isArray(original) ? tinted : tinted[0];
    records.push({ mesh: o, original });
  });

  _applied.set(root, records);
}

/** Put the original materials back and dispose the clones. Exact inverse. */
export function restoreTint(root) {
  const records = _applied.get(root);
  if (!records) return;

  for (const { mesh, original } of records) {
    const current = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mesh.material = original;
    // Dispose only the clones we made, never the originals.
    const originals = new Set(Array.isArray(original) ? original : [original]);
    for (const m of current) if (!originals.has(m)) m.dispose();
  }
  _applied.delete(root);
}

/** True if this root currently carries a skin tint. */
export function isTinted(root) { return _applied.has(root); }

/** Restore everything — used by the manager before building a new skin. */
export function restoreAllTints() {
  for (const root of [..._applied.keys()]) restoreTint(root);
}
