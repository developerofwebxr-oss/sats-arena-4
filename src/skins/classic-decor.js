import * as THREE from 'three';
import { createTextSprite } from '../vrui.js';

/**
 * classic-decor.js — neon skyline, living void and Sats Arena / ₿ branding for
 * the CLASSIC skin. Purely cosmetic.
 *
 * THE VOID STAYS BLACK. scene.background and scene.fog are NOT touched — the
 * sky/fog ownership question is still parked (armode.js restores both on XR
 * sessionend, so a skin-owned background would be silently reverted). Everything
 * here is added INTO the black instead.
 *
 * ...which runs straight into a constraint: scene.fog is Fog(0x050508, 10, 40),
 * so anything past 40 units is faded to the background and invisible. Rather
 * than touch the fog, every material here sets `fog: false` — a MATERIAL flag,
 * not a scene one. Distant neon then reads at full brightness against black,
 * which is exactly the night-city look, and the fog still does its job on the
 * arena itself.
 *
 * NO BLOOM. UnrealBloomPass would be the usual way to make neon glow, but a
 * post-processing composer fights the WebXR render path and this is a
 * cosmetic-only change. Glow comes from additive blending on unlit materials
 * instead — the cheap route, and it degrades identically in every mode.
 *
 * Everything is parented into the caller's group, which is the P30
 * "skin:classic" named group, so the leak assertion still governs it and Gold
 * Arena is unaffected. That group is a child of `environment`, which armode.js
 * hides wholesale in passthrough — so this decor is AR-suppressed for free,
 * with no second visibility writer.
 *
 * Budget: the skyline is EDGES ONLY (zero triangles), merged into ONE
 * LineSegments via vertex colours; particles are three capped Points layers.
 */

// Classic's existing neon palette — scene.js radar, hud.js, vrui.js. Nothing new.
const CYAN    = new THREE.Color(0x00e5ff);
const MAGENTA = new THREE.Color(0xb14bff);
const ORANGE  = new THREE.Color(0xf7931a);
const GOLD    = new THREE.Color(0xf7931a);

// The arena boundary is radius 10 / height 6 (arena.js). The skyline sits far
// beyond it so it reads as a horizon, not another wall — and tall enough to
// clear the 6-unit walls from the player's eye at 1.6.
// Distances chosen from the projected angle, not by eye: at r=115 a 30-unit
// tower subtends ~15deg, which reads as a skyline. The first pass sat at r=52,
// where the same tower subtends ~27deg and was clipped by the top of the frame —
// it read as boxes crowding the player rather than a city on the horizon.
// Tuned against the actual camera: pitch -0.2rad with a 60deg FOV leaves roughly
// -41deg..+19deg visible, so tower tops must stay under ~19deg of elevation or
// they get clipped by the top of the frame. Ring radius is then chosen for
// DENSITY — circumference/count/width has to fill the horizon or it reads as
// scattered boxes rather than a city (the r=115/28 pass left obvious gaps).
//   near: 2*pi*78/30  => one every ~16u at ~10u wide  => ~62% fill
// Widths kept narrow relative to height: an edges-only box that is wide AND tall
// reads as a floating frame rather than a tower, because its long top edge cuts
// across the sky with nothing to anchor it.
const NEAR_RING = { radius:  78, count: 30, hMin:  8, hMax: 22, wMin: 5, wMax: 11, dim: 0.85 };
const FAR_RING  = { radius: 118, count: 24, hMin: 16, hMax: 32, wMin: 7, wMax: 13, dim: 0.45 };

const PARTICLE_LAYERS = [
  { count: 240, size: 0.16, alpha: 0.40 },  // dust
  { count: 110, size: 0.28, alpha: 0.58 },  // mid motes
  { count: 50,  size: 0.46, alpha: 0.80 },  // the few bright ones
];
const PARTICLE_INNER = 16;   // keep clear of the play space
const PARTICLE_OUTER = 70;
const PARTICLE_TOP   = 40;

const STREAM_COUNT = 10;     // falling "data-stream" lines
const GLYPH_COUNT  = 7;      // drifting holographic ₿

/**
 * Build the Classic skin's decor into `group`.
 * @returns {{ update(dt:number, elapsed:number):void, stats:object }}
 */
export function buildClassicDecor(group) {
  const decor = new THREE.Group();
  decor.name = 'ClassicNeonDecor';
  group.add(decor);

  const stats = { buildings: 0, lineVertices: 0, points: 0, sprites: 0, triangles: 0, drawCalls: 0 };

  // ── 1. NEON SKYLINE ─────────────────────────────────────────────────────────
  // Boxes as EDGE LINES only. All buildings from both rings go into ONE
  // BufferGeometry with per-vertex colours, so the whole skyline is a single
  // draw call and zero triangles. Colour carries both the neon hue and the
  // depth cue (the far ring is dimmed rather than fogged).
  const pos = [];
  const col = [];
  const _c = new THREE.Color();

  function addBuilding(cx, cz, w, h, d, colour, dim) {
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const z0 = cz - d / 2, z1 = cz + d / 2;
    const y0 = 0,          y1 = h;
    // 12 edges of a box
    const E = [
      [x0,y0,z0, x1,y0,z0], [x1,y0,z0, x1,y0,z1], [x1,y0,z1, x0,y0,z1], [x0,y0,z1, x0,y0,z0],
      [x0,y1,z0, x1,y1,z0], [x1,y1,z0, x1,y1,z1], [x1,y1,z1, x0,y1,z1], [x0,y1,z1, x0,y1,z0],
      [x0,y0,z0, x0,y1,z0], [x1,y0,z0, x1,y1,z0], [x1,y0,z1, x1,y1,z1], [x0,y0,z1, x0,y1,z1],
    ];
    _c.copy(colour).multiplyScalar(dim);
    for (const e of E) {
      pos.push(e[0], e[1], e[2], e[3], e[4], e[5]);
      // Vertical edges fade toward the base so towers feel grounded in the dark.
      col.push(_c.r, _c.g, _c.b, _c.r, _c.g, _c.b);
    }
    stats.buildings++;
  }

  const rand = mulberry32(0x5A75); // deterministic: the skyline is the same every load
  for (const ring of [NEAR_RING, FAR_RING]) {
    const dim = ring.dim;  // depth cue without fog — the far ring reads recessed
    for (let i = 0; i < ring.count; i++) {
      // Jitter the angle so it never reads as a regular fence.
      const a = (i / ring.count) * Math.PI * 2 + (rand() - 0.5) * 0.16;
      const r = ring.radius * (0.9 + rand() * 0.22);
      const h = ring.hMin + rand() * (ring.hMax - ring.hMin);
      const w = ring.wMin + rand() * (ring.wMax - ring.wMin);
      const d = ring.wMin + rand() * (ring.wMax - ring.wMin);
      // Mostly cyan, magenta accents, the occasional bitcoin-orange landmark.
      // Orange is the rarest — a bitcoin-gold landmark, not a third of the city.
      const roll = rand();
      const colour = roll > 0.93 ? ORANGE : roll > 0.66 ? MAGENTA : CYAN;
      addBuilding(Math.sin(a) * r, Math.cos(a) * r, w, h, d, colour, dim);
    }
  }

  const skyGeo = new THREE.BufferGeometry();
  skyGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  skyGeo.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
  const skyline = new THREE.LineSegments(skyGeo, new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,  // stands in for bloom
    depthWrite: false,
    fog: false,                        // <- past fog.far without touching scene.fog
  }));
  skyline.name = 'NeonSkyline';
  skyline.frustumCulled = false;
  decor.add(skyline);
  stats.lineVertices += pos.length / 3;
  stats.drawCalls++;

  // ── 2. LIVING VOID ──────────────────────────────────────────────────────────
  // Round points (a radial-alpha sprite — the default square Points look is the
  // giveaway of an unfinished scene). Three capped layers give size variety
  // without a custom shader; per-point colour gives brightness variety.
  const dotTex = makeDotTexture();
  const particleGroups = [];

  for (const layer of PARTICLE_LAYERS) {
    const p = [], c = [];
    for (let i = 0; i < layer.count; i++) {
      // Shell between INNER and OUTER so nothing spawns in the player's face.
      const a  = rand() * Math.PI * 2;
      const rr = PARTICLE_INNER + rand() * (PARTICLE_OUTER - PARTICLE_INNER);
      const y  = 1 + rand() * PARTICLE_TOP;
      p.push(Math.sin(a) * rr, y, Math.cos(a) * rr);
      // Mostly cool, a few warm — varied brightness so it never looks uniform.
      const t = rand();
      _c.copy(t > 0.9 ? GOLD : t > 0.68 ? MAGENTA : CYAN).multiplyScalar(0.45 + rand() * 0.55);
      c.push(_c.r, _c.g, _c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('color',    new THREE.Float32BufferAttribute(c, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({
      size: layer.size,
      map: dotTex,
      vertexColors: true,
      transparent: true,
      opacity: layer.alpha,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
      fog: false,
    }));
    pts.frustumCulled = false;
    decor.add(pts);
    particleGroups.push(pts);
    stats.points += layer.count;
    stats.drawCalls++;
  }

  // Falling "data streams" — one LineSegments, positions nudged per frame.
  const streamPos = new Float32Array(STREAM_COUNT * 6);
  const streamMeta = [];
  for (let i = 0; i < STREAM_COUNT; i++) {
    const a = rand() * Math.PI * 2;
    const r = 18 + rand() * 34;
    streamMeta.push({
      x: Math.sin(a) * r, z: Math.cos(a) * r,
      y: 6 + rand() * PARTICLE_TOP,
      len: 1.6 + rand() * 3.4,
      speed: 2.2 + rand() * 4.5,
    });
  }
  const streamGeo = new THREE.BufferGeometry();
  streamGeo.setAttribute('position', new THREE.BufferAttribute(streamPos, 3));
  const streams = new THREE.LineSegments(streamGeo, new THREE.LineBasicMaterial({
    color: 0x9fe8ff, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  streams.name = 'DataStreams';
  streams.frustumCulled = false;
  decor.add(streams);
  stats.lineVertices += STREAM_COUNT * 2;
  stats.drawCalls++;

  // ── 3. SATS ARENA + ₿ BRANDING ──────────────────────────────────────────────
  // Signage, not a monolith: one readable wordmark on the horizon, two small ₿
  // signs out in the skyline, and a few holographic ₿ drifting in the void.
  // Canvas-texture sprites (the project's existing 3D-text approach) — no
  // TextGeometry anywhere.
  const sign = createTextSprite(42, '#00e5ff');
  sign.setText('SATS ARENA');
  sign.mesh.name = 'SkylineSign';
  // Elevation kept under the ~19deg clip so the wordmark is actually on screen.
  sign.mesh.position.set(0, 15, -(FAR_RING.radius * 0.80));
  sign.mesh.material.transparent = true;
  sign.mesh.material.opacity = 0.95;
  sign.mesh.material.blending = THREE.AdditiveBlending;
  sign.mesh.material.depthWrite = false;
  sign.mesh.material.fog = false;
  sign.mesh.frustumCulled = false;
  decor.add(sign.mesh);
  stats.sprites++; stats.triangles += 2; stats.drawCalls++;

  // Building-mounted ₿ marks + drifting holographic glyphs. Sprites, so they
  // stay legible from any angle (the skill's billboarding rule) without any
  // per-frame lookAt work.
  const glyphTex = makeGlyphTexture('₿', '#f7931a');
  const glyphMat = new THREE.SpriteMaterial({
    map: glyphTex, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, opacity: 0.85,
  });

  // two on the skyline
  [[-52, 14, -66], [63, 11, 47]].forEach((p, i) => {
    const s = new THREE.Sprite(glyphMat);
    s.name = `SkylineGlyph${i}`;
    s.position.set(p[0], p[1], p[2]);
    s.scale.setScalar(9);
    s.frustumCulled = false;
    decor.add(s);
    stats.sprites++; stats.triangles += 2; stats.drawCalls++;
  });

  // drifting in the void
  const glyphs = [];
  for (let i = 0; i < GLYPH_COUNT; i++) {
    const a = rand() * Math.PI * 2;
    const r = 16 + rand() * 26;
    const s = new THREE.Sprite(glyphMat.clone());
    s.material.opacity = 0.16 + rand() * 0.20;   // faint — texture of the place
    s.position.set(Math.sin(a) * r, 4 + rand() * 20, Math.cos(a) * r);
    s.scale.setScalar(1.6 + rand() * 2.2);
    s.frustumCulled = false;
    decor.add(s);
    glyphs.push({ sprite: s, phase: rand() * Math.PI * 2, bob: 0.4 + rand() * 0.8 });
    stats.sprites++; stats.triangles += 2; stats.drawCalls++;
  }

  // ── Animation ───────────────────────────────────────────────────────────────
  // Cheap by construction: the particle drift is a slow rotation of whole Points
  // objects (no per-vertex CPU work); only the 10 stream segments and 7 glyphs
  // touch data per frame.
  function update(dt, elapsed) {
    for (let i = 0; i < particleGroups.length; i++) {
      // Layered speeds so the field has parallax rather than moving as one lump.
      particleGroups[i].rotation.y += dt * (0.006 + i * 0.004);
    }
    for (let i = 0; i < STREAM_COUNT; i++) {
      const m = streamMeta[i];
      m.y -= dt * m.speed;
      if (m.y < 1) m.y = PARTICLE_TOP + rand() * 8;   // wrap to the top
      const o = i * 6;
      streamPos[o + 0] = m.x; streamPos[o + 1] = m.y;         streamPos[o + 2] = m.z;
      streamPos[o + 3] = m.x; streamPos[o + 4] = m.y - m.len; streamPos[o + 5] = m.z;
    }
    streamGeo.attributes.position.needsUpdate = true;

    for (const g of glyphs) {
      g.sprite.position.y += Math.sin(elapsed * 0.5 + g.phase) * dt * g.bob;
    }
  }

  return { update, stats };
}

// ── Textures ─────────────────────────────────────────────────────────────────

/** Radial-alpha dot so Points render ROUND, not as default squares. */
function makeDotTexture() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

/** Glowing glyph on transparent — same canvas-text treatment as the rest. */
function makeGlyphTexture(ch, colour) {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.font = `bold ${Math.round(S * 0.72)}px monospace`;
  x.shadowColor = colour;
  x.shadowBlur = 26;
  x.fillStyle = colour;
  x.fillText(ch, S / 2, S / 2 + S * 0.02);
  x.fillText(ch, S / 2, S / 2 + S * 0.02); // twice = hotter core
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

/** Small deterministic PRNG so the skyline is identical on every load. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
