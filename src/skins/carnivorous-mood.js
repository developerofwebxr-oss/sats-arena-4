import * as THREE from 'three';
import { buildCarnivorousCeiling } from './carnivorous-ceiling.js';

/**
 * carnivorous-mood.js — the lighting that makes the Conservatory frightening.
 *
 * Read against the interior references: near-black trunks, wet red lips around
 * every maw, coral petals overhead, thin gold sap veins, and light that arrives
 * from a few directions only. Nothing in those images is evenly lit. The whole
 * job here is to keep that and still leave the game playable.
 *
 * ── THE CONSTRAINT THAT SHAPES EVERYTHING ───────────────────────────────────
 * A player has to see a small gold coin against a dark red wall and hit it. So
 * this is not "make it dark", it is CONTRAST: the walls fall away, and the
 * middle of the room — where the coins fly — keeps a warm pool the coins read
 * against. Low-key, not low-light.
 *
 * ── WHY SO FEW LIGHTS ───────────────────────────────────────────────────────
 * Every dynamic light multiplies the fragment cost across 565k triangles of
 * foliage, on a mobile GPU, in stereo. So most of the mood is NOT lights:
 *
 *   1. EMISSIVE, which is free. The asset already ships Glow, Sap, CoralPetal
 *      and RosePetal as emissive materials; their strengths are authored for a
 *      brightly lit preview. Pushed up here, the maw rims, the sap veins and
 *      the petals light THEMSELVES, which is exactly the look of the refs and
 *      costs one uniform.
 *   2. FOG, one exponential-free linear fog in a blood-black, which does the
 *      "the far side of the arena is a threat you cannot quite see" work that
 *      would otherwise need lights aimed at nothing.
 *   3. FIVE actual lights: a hemisphere floor, one canopy key, two flickering
 *      embers, and a lantern at the player. That is the whole rig.
 *
 * The GLB's own PreviewLights (five points, up to 125 candela) are DISABLED on
 * load: they are the exporter's render lighting, they are not scoped to the
 * skin group, and they are the reason an untouched load looks flat.
 *
 * ── SCOPING ─────────────────────────────────────────────────────────────────
 * Every light here is created under the SKIN GROUP, so the P30 teardown removes
 * them with the skin and Classic cannot inherit a single one. The fog, the
 * background and the base sun/ambient are NOT ours to add — they are scene-level
 * — so they go through atmosphere.js, which owns them, ranks skin over boot, and
 * suppresses for AR instead of overwriting. See that file for why.
 */

// ── Palette, sampled from the interior references ────────────────────────────
const FOG_COLOUR     = 0x0a0305;   // blood-black
const SKY_FILL       = 0x3a1013;   // what little bounces off the canopy
const GROUND_FILL    = 0x0a0403;   // the floor gives almost nothing back
const KEY_COLOUR     = 0xff5326;   // the canopy shaft: hot orange-red
const EMBER_COLOUR   = 0xff6a24;   // flickering accents up in the boughs
const LANTERN_COLOUR = 0xffa070;   // the player's own pool of readable light

// ── Rig ──────────────────────────────────────────────────────────────────────
const FOG_NEAR = 7;
const FOG_FAR  = 34;    // the enclosure is 31 m across: the far wall is nearly gone
const KEY_Y    = 10.5;  // just under the canopy at 12.6 m

// Emissive multipliers applied to the asset's own materials. Authored values
// (0.14–2.0) were lit for a bright preview; these are what makes the maws and
// veins read as the light SOURCES in a dark room.
const EMISSIVE_BOOST = {
  Glow: 3.4,          // the maw rims and throat glow
  Sap: 3.0,           // gold veins running up the trunks
  CoralPetal: 2.2,    // canopy petals, seen from below
  RosePetal: 2.2,
};

/**
 * @param {THREE.Object3D} group  the skin group — everything is parented here
 * @param {THREE.Object3D} arenaRoot  the loaded GLB, for its materials
 */
export function buildCarnivorousMood(group, arenaRoot) {
  const lights = new THREE.Group();
  lights.name = 'CarnivorousMood';
  group.add(lights);

  // ── 1. Floor fill ─────────────────────────────────────────────────────────
  // Not an AmbientLight: a hemisphere keeps the underside of every bough dark
  // while the tops catch a little, which is most of what "not flat" means for
  // free. Deliberately weak — it exists so nothing is pure black.
  const fill = new THREE.HemisphereLight(SKY_FILL, GROUND_FILL, 0.55);
  fill.name = 'CarnMoodFill';
  lights.add(fill);

  // ── 2. The key: one shaft down through the canopy ─────────────────────────
  // This is the readability light. A wide, soft spot centred on the play space
  // puts a warm pool on the floor and on anything flying through the middle,
  // and leaves the walls to the emissive. Steep angle so the maw band stays in
  // shadow and the lips are the brightest thing on the wall.
  const key = new THREE.SpotLight(KEY_COLOUR, 220, 30, 0.95, 0.92, 1.5);
  key.name = 'CarnMoodKey';
  key.position.set(0, KEY_Y, 0);
  key.target.position.set(0, 0, 0);
  lights.add(key, key.target);

  // ── 3. Two embers in the boughs, flickering ───────────────────────────────
  // Placed off-centre and asymmetric on purpose: symmetry reads as decoration,
  // asymmetry reads as something burning where you are not looking.
  const embers = [
    makeEmber(-7.6, 7.2, -5.2, 34, 0.9),
    makeEmber(6.9, 6.4, 6.1, 26, 1.37),
  ];
  for (const e of embers) lights.add(e.light);

  // ── 4. The lantern ────────────────────────────────────────────────────────
  // A small warm light at the player's own position. It is the difference
  // between "atmospheric" and "I cannot see the coin I am aiming at": coins
  // spawn around head height in the middle of the room, and this is what they
  // are lit by. Short range so it never reaches the walls and flattens them.
  const lantern = new THREE.PointLight(LANTERN_COLOUR, 26, 11, 1.8);
  lantern.name = 'CarnMoodLantern';
  lantern.position.set(0, 2.1, 0);
  lights.add(lantern);

  // ── 5. The things overhead ────────────────────────────────────────────────
  // Blooms in the canopy that open and clench above the player. Atmosphere
  // only — nothing spawns from them and nothing is shootable. Parented into the
  // same skin group, so they leave with the skin and go dark in passthrough.
  const ceiling = buildCarnivorousCeiling(group);

  // ── 6. Make the asset light itself ────────────────────────────────────────
  const boosted = boostEmissive(arenaRoot);
  const disabled = disablePreviewLights(arenaRoot);

  let elapsed = 0;
  function update(dt) {
    elapsed += dt;
    ceiling.update(dt);
    for (const e of embers) {
      // Two detuned sines plus a slow sag. Not random(): a per-frame random is
      // a strobe, and the eye reads strobing as a bug rather than as fire.
      const f = 0.62
        + 0.26 * Math.sin(elapsed * e.rate * 6.1 + e.phase)
        + 0.14 * Math.sin(elapsed * e.rate * 13.7 + e.phase * 2.3)
        + 0.10 * Math.sin(elapsed * e.rate * 2.3);
      e.light.intensity = e.base * Math.max(0.18, f);
    }
  }

  return {
    update,
    group: lights,
    /** What this skin asks atmosphere.js to paint while it is active. */
    atmosphere: {
      background: new THREE.Color(FOG_COLOUR),
      fog: new THREE.Fog(FOG_COLOUR, FOG_NEAR, FOG_FAR),
      // The boot sun is white, from above-left, at full strength — it would
      // flatten every trunk in the room. Nearly off; the rig above replaces it.
      sunScale: 0.12,
      ambientScale: 0.35,
    },
    ceiling,
    stats: {
      ceiling: ceiling.stats,
      lights: lights.children.filter((o) => o.isLight).length,
      flickering: embers.length,
      emissiveBoosted: boosted,
      previewLightsDisabled: disabled,
      fog: `linear ${FOG_NEAR}-${FOG_FAR} m`,
    },
  };
}

function makeEmber(x, y, z, base, rate) {
  const light = new THREE.PointLight(EMBER_COLOUR, base, 16, 1.7);
  light.name = 'CarnMoodEmber';
  light.position.set(x, y, z);
  return { light, base, rate, phase: x + z };
}

/** Push the asset's own emissive materials up so they read as sources. */
function boostEmissive(root) {
  const seen = new Set();
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || seen.has(m.uuid)) continue;
      seen.add(m.uuid);
      const boost = EMISSIVE_BOOST[m.name];
      if (!boost || !m.emissive) continue;
      m.emissiveIntensity = (m.emissiveIntensity ?? 1) * boost;
      m.needsUpdate = true;
      n++;
    }
  });
  return n;
}

/**
 * The GLB ships five PreviewLights — the exporter's render rig. They are not
 * ours (they live under the arena root, not the skin group), they are far
 * brighter than anything here, and left on they flood the room. Disabled rather
 * than deleted so a re-export still round-trips and the node names stay.
 *
 * SCOPED TO THE PREVIEW RIG, and it has to be. This used to sweep every light
 * under the arena root, and the door-target's own light is mounted there too —
 * so every time the skin was re-attached, this walked over and zeroed the light
 * that exists to make the Snapper visible. It disables the exporter's node and
 * nothing else; if a future export drops that node, the fallback still refuses
 * to touch anything a target brought with it.
 */
function disablePreviewLights(root) {
  const rig = root.getObjectByName('PreviewLights');
  let n = 0;
  (rig || root).traverse((o) => {
    if (!o.isLight) return;
    if (!rig && ownedByATarget(o)) return;
    o.intensity = 0;
    o.visible = false;
    n++;
  });
  return n;
}

/** Is this light part of a door-target's mount rather than the arena itself? */
function ownedByATarget(light) {
  for (let p = light; p; p = p.parent) {
    if (typeof p.name === 'string' && p.name.startsWith('DoorTarget:')) return true;
  }
  return false;
}
