import * as THREE from 'three';

/**
 * classic-decor.js — the CLASSIC skin's horizon: a COLOSSEUM OF LIGHT.
 * Purely cosmetic.
 *
 * ── What this replaced, and why ──────────────────────────────────────────────
 * The first pass built the horizon from wireframe BOXES — edges-only cuboids in
 * two rings — plus a flat "SATS ARENA" sprite hanging in the play space and
 * seven loose ₿ glyphs drifting around. It was cheap and it read cheap: a box
 * outline is the shape you get when you have not decided on a shape, and a
 * sprite floating at mid-distance reads as UI that escaped the HUD, not as
 * architecture. The verdict was "ugly", and the fix is not narrower boxes.
 *
 * So the concept changed rather than its parameters. You stand at the centre of
 * a circular arena; the horizon should say you are inside something built to be
 * watched in. That is a colosseum — a ring of tall, slender, arched portals,
 * each a hairline neon rim with light spilling from somewhere beyond it.
 *
 * THE SIGNATURE is the arch pair: a SHARP rim and, set just inside it, a SOFT
 * inner gradient that is nearly nothing at the base and blooms at the crown. Two
 * elements, drawn separately on purpose. A single glowing shape reads as a lit
 * object; a sharp edge around a soft interior reads as an OPENING with light
 * behind it. That difference is the whole idea, and it is why the arches are
 * built as real curved ribbons — sampled leg-arc-leg profiles offset along their
 * own normals — instead of anything box-derived.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * Restraint is the brief. Bitcoin orange appears in exactly two roles: the three
 * landmark gates and the single horizon mark. There are three ₿ keystones, on
 * those three gates only, so the glyph means "this is a gate" rather than
 * decorating everything. The loose floating ₿ are gone entirely.
 *
 * ── Inherited constraints (all still true) ──────────────────────────────────
 * THE VOID STAYS BLACK. scene.background and scene.fog are NOT touched — that
 * ownership question is still parked (armode.js restores both on XR sessionend,
 * so a skin-owned background would be silently reverted). Everything here is
 * added INTO the black.
 *
 * ...which runs into scene.fog = Fog(0x050508, 10, 40): anything past 40 units
 * fades to the background. Rather than touch the fog, every material here sets
 * `fog: false` — a MATERIAL flag, not a scene one.
 *
 * NO BLOOM. UnrealBloomPass fights the WebXR render path, and this is a
 * cosmetic-only change. Glow is additive blending on unlit materials, which
 * degrades identically in every mode.
 *
 * Everything is parented into the caller's group, which is the P30
 * "skin:classic" named group, so the leak assertion governs it and Gold Arena is
 * unaffected. That group is a child of `environment`, which armode.js hides
 * wholesale in passthrough — so this decor is AR-suppressed for free, with no
 * second visibility writer.
 *
 * Budget: every arch rim in the scene is ONE merged BufferGeometry (one draw
 * call), every arch glow is a second, and both are flat ribbons of a few
 * thousand triangles. Counts are reported in `stats`.
 */

// Classic's existing neon palette — scene.js radar, hud.js, vrui.js. Nothing new.
const CYAN    = new THREE.Color(0x00e5ff);
const MAGENTA = new THREE.Color(0xb14bff);
const ORANGE  = new THREE.Color(0xf7931a);

/**
 * ── Composition, derived rather than eyeballed ──────────────────────────────
 * The camera sits at y=1.6 with a -0.2 rad pitch and a 60deg FOV, which leaves
 * roughly -41deg..+19deg of elevation on screen. Anything whose top crosses
 * ~19deg is clipped by the frame — that is what made the first pass's towers
 * read as boxes crowding the player.
 *
 * NEAR ring at r=58: a 20-unit crown subtends atan((20-1.6)/58) = 17.6deg, and
 * the tallest arch on the inside of the jitter still clears the frame's ~23.5deg
 * ceiling. r=52 was tried and rejected: it cropped the crowns of the arches at
 * the left and right frame edges, which reads as an accident rather than as a
 * ring continuing past you.
 *
 * ── WHY IT NOW READS AS A RING ──────────────────────────────────────────────
 * First review said "I don't see a ring, just arches", and that was a real
 * geometry problem, not a framing one. Every arch faces the arena centre, and
 * the player stands AT the centre — so every arch is seen dead-on, and a circle
 * centred on the viewer projects to a perfectly HORIZONTAL line. There was no
 * curvature information on screen at all.
 *
 * (A base plinth arc was tried first and removed: being centred on the player,
 * it drew as a dead-straight line across the frame, which made the colonnade
 * read MORE like a flat backdrop, not less.)
 *
 * Two changes fix it at the source:
 *   1. r 62 -> 58. Closer means each arch subtends more, fewer fit across the
 *      frame, and the tangent projection compresses their spacing harder toward
 *      the edges — where they now also get cut by the frame, which is what says
 *      "this continues past you".
 *   2. A +/-6% per-arch radius jitter. A PERFECT circle centred on the eye is
 *      degenerate: every arch is equidistant, so nothing is nearer or farther
 *      and the row is flat by construction. Nudging each arch in or out breaks
 *      that, giving genuine near/far cues along the row. It costs one multiply
 *      at build time and nothing at runtime.
 *
 * SLENDERNESS is the point. 6 wide x 20 tall is 1:3.3. At r=62, 26 arches sit
 * one every 15 units, so a 6-wide arch fills ~40% of the horizon and the gaps
 * stay BLACK. A colonnade you can see through, not a fence — the previous pass
 * chased ~62% fill and got a wall of clutter.
 *
 * FAR ring at r=88, offset half a step in angle so it shows through the near
 * gaps, dimmed to 0.30. That is the parallax layer: it gives the colosseum
 * depth without adding anything the eye has to read.
 *
 * THE HARD CEILING ON DISTANCE IS THE CAMERA, NOT THE FOG. scene.js builds the
 * camera with far = 100, so ANYTHING past 100 units is clipped away entirely and
 * silently. The previous pass put its far ring at r=118 and its near ring at
 * r=78 — the far ring was outside the frustum and never drew at all, which is
 * part of why that horizon read thin. Every radius here is chosen so the whole
 * object, corners included, stays inside 100. The camera is NOT touched: it is
 * shared with Gold Arena, AR and the XR rig, and widening it for decoration
 * would be a scene-wide change made for a cosmetic reason.
 *
 * The camera's real vertical FOV is 70deg (not the 60 assumed earlier), so at
 * a -0.2 rad pitch the frame reaches about +23.5deg of elevation — that is the
 * height budget everything below is fitted into.
 */
const NEAR_RING = {
  radius: 58,  count: 30, offset: 0, jitter: 0.06,
  hMin: 17, hMax: 22, wMin: 3.6, wMax: 4.8, rim: 0.26, dim: 1.00, glow: 0.15,
};
const FAR_RING = {
  radius: 88, count: 22, offset: 0.5, jitter: 0.05,
  hMin: 24, hMax: 31, wMin: 5.0, wMax: 6.8, rim: 0.32, dim: 0.30, glow: 0.06,
};

// The three GATES: taller, orange-rimmed, ₿-keystoned. At 0deg (under the
// marquee) and +/-120deg, so wherever you turn there is one landmark in view
// without any two of them crowding each other.
// ANGLE CONVENTION: position is (sin a, 0, cos a) * r, so a=0 is +Z — BEHIND a
// camera that looks down -Z. The marquee hangs at -Z, i.e. a = PI, and the
// central gate has to be the one underneath it. Getting this wrong put the gate
// directly behind the player and left the marquee floating over an ordinary arch.
const MARQUEE_ANGLE = Math.PI;
const GATE_ANGLES = [
  MARQUEE_ANGLE,
  MARQUEE_ANGLE + (2 * Math.PI) / 3,
  MARQUEE_ANGLE + (4 * Math.PI) / 3,
];
// GATES ARE WIDE AND LOW, not tall. The first attempt made them the tallest
// thing on the horizon, which put the central gate's crown straight through the
// marquee and off the top of the frame. Architecturally the grand entrance is a
// BROAD low arch with the name above it — so the gates read as landmarks by
// being wider, warmer and keystoned, and the vertical budget above them is left
// for the sign. 10 wide x 15 tall against the colonnade's 4 x 20 is a clear
// silhouette difference at a glance.
const GATE = { radius: 58, height: 15.0, width: 10.0, rim: 0.34, glow: 0.09 };

// MARQUEE: in the SAME plane as the colonnade (r=62), crowning the central gate
// rather than hovering somewhere behind it. Sized so its band spans about three
// times the gate's opening, which is the proportion a stadium façade uses.
//
// The vertical budget is unforgiving: a 60deg vertical FOV pitched -0.2 rad
// leaves about +18.5deg of headroom, so at r=62 nothing may sit above y ~= 22.4.
// Bottom edge 16.6 clears the 15.0 gate crown; top edge 22.2 clears the frame.
const MARQUEE = { radius: 58, y: 19.4, width: 30, height: 5.6 };

// One large, faint, slowly turning holographic mark, behind and above it all.
// THE HORIZON MARK IS FRUSTUM-BOUND, AND ITS ROTATION IS PART OF THE SUM.
// It is a rotating quad, so the distance that matters is its far TOP CORNER
// mid-swing, not its centre:
//     d = sqrt((r + (size/2)*sin(swing))^2 + (y + size/2)^2)
// At r=94, size 30, swing 0.56 that came to 108 units — past the camera's 100
// far plane, so the mark's corners were being clipped away as it turned. Caught
// by measuring the farthest actual vertex rather than trusting a bounding
// sphere. These numbers give d = 95.9, with real margin:
//     (84 + 13*sin(0.35))^2 + (24 + 13)^2  ->  95.9u
// Its centre still lands at 14.9deg of elevation against the marquee's 16.3, so
// it haloes directly BEHIND the wordmark, and it is drawn first (renderOrder -3)
// so the colonnade paints over it and it reads as the most distant thing there.
const HORIZON_MARK = { radius: 84, y: 24, size: 26, opacity: 0.30, swing: 0.35 };

const PARTICLE_LAYERS = [
  { count: 240, size: 0.16, alpha: 0.40 },  // dust
  { count: 110, size: 0.28, alpha: 0.58 },  // mid motes
  { count: 50,  size: 0.46, alpha: 0.80 },  // the few bright ones
];
const PARTICLE_INNER = 16;   // keep clear of the play space
const PARTICLE_OUTER = 70;
const PARTICLE_TOP   = 40;

const STREAM_COUNT = 10;     // falling "data-stream" lines

/** Owner-facing A/B: ?classic=wall turns the colonnade into an arched-window wall. */
function wallVariant() {
  try { return new URLSearchParams(location.search).get('classic') === 'wall'; }
  catch { return false; }
}

/**
 * Build the Classic skin's decor into `group`.
 * @returns {{ update(dt:number, elapsed:number):void, stats:object }}
 */
export function buildClassicDecor(group) {
  const decor = new THREE.Group();
  decor.name = 'ClassicNeonDecor';
  group.add(decor);

  const stats = {
    arches: 0, gates: 0, triangles: 0, points: 0, lineVertices: 0,
    drawCalls: 0, variant: wallVariant() ? 'arched-window wall' : 'portal ring',
  };
  const rand = mulberry32(0x5A75); // deterministic: the horizon is identical every load

  // ── 1. THE COLOSSEUM ────────────────────────────────────────────────────────
  // Two merged buffers for the whole horizon: one for every rim, one for every
  // inner glow. Both carry per-vertex colour, so hue and the depth dimming ride
  // in the geometry and neither needs a second material.
  const rim  = new MergedRibbon();
  const glow = new MergedFill();
  const _c = new THREE.Color();

  function placeArch({ angle, radius, width, height, thickness, colour, dim, glowAmt }) {
    // Face the arch inward: its local +Z points at the player, so the ribbon is
    // seen flat-on from the centre of the arena.
    const m = new THREE.Matrix4()
      .makeRotationY(angle)
      .setPosition(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);

    const path = archPath(width, height);
    _c.copy(colour).multiplyScalar(dim);
    rim.addRibbon(path, thickness, m, _c);
    glow.addArchFill(path, m, _c, glowAmt);
    stats.arches++;
  }

  for (const ring of [NEAR_RING, FAR_RING]) {
    for (let i = 0; i < ring.count; i++) {
      const angle = ((i + ring.offset) / ring.count) * Math.PI * 2;
      // Skip the near-ring slots the gates occupy, so a gate REPLACES an arch
      // rather than standing inside one.
      if (ring === NEAR_RING && GATE_ANGLES.some((g) => angularGap(angle, g) < 0.14)) continue;

      // Gentle variation only. Every arch differing is noise; none differing is
      // wallpaper. ~15% on height reads as hand-built without reading random.
      const height = ring.hMin + rand() * (ring.hMax - ring.hMin);
      const width  = ring.wMin + rand() * (ring.wMax - ring.wMin);
      // Cyan is the material of the building; magenta is an accent, roughly one
      // arch in four. Orange is NOT in the rotation — it belongs to the gates.
      const colour = rand() > 0.74 ? MAGENTA : CYAN;
      // Push each arch slightly in or out of the nominal radius — see the
      // WHY IT NOW READS AS A RING note above.
      const radius = ring.radius * (1 + (rand() - 0.5) * 2 * ring.jitter);
      placeArch({
        angle, radius, width, height,
        thickness: ring.rim, colour, dim: ring.dim, glowAmt: ring.glow,
      });
    }
  }

  for (const angle of GATE_ANGLES) {
    placeArch({
      angle, radius: GATE.radius, width: GATE.width, height: GATE.height,
      thickness: GATE.rim, colour: ORANGE, dim: 1.0, glowAmt: GATE.glow,
    });
    stats.gates++;
  }

  // ALTERNATE FRAMING (?classic=wall): a low continuous band running behind the
  // near ring with a lit top edge, so the arches read as WINDOWS cut into one
  // architectural mass instead of free-standing portals. Same arches either way
  // — only the mass behind them changes.
  if (wallVariant()) {
    const wall = buildWallBand(NEAR_RING.radius + 1.2, 9.5, 96);
    decor.add(wall.mesh);
    stats.triangles += wall.triangles;
    stats.drawCalls++;

    const capGeo = new THREE.BufferGeometry().setAttribute(
      'position', new THREE.Float32BufferAttribute(ringLine(NEAR_RING.radius + 1.2, 9.5, 96), 3));
    const cap = new THREE.LineLoop(capGeo, new THREE.LineBasicMaterial({
      color: 0x00e5ff, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    cap.name = 'WallCap';
    cap.frustumCulled = false;
    decor.add(cap);
    stats.lineVertices += 96;
    stats.drawCalls++;
  }

  const rimMesh = rim.build('ArchRims');
  decor.add(rimMesh);
  stats.triangles += rim.triangles; stats.drawCalls++;

  const glowMesh = glow.build('ArchGlow');
  decor.add(glowMesh);
  stats.triangles += glow.triangles; stats.drawCalls++;

  // ── 2. LIVING VOID (kept exactly as shipped) ────────────────────────────────
  // Round points (a radial-alpha sprite — the default square Points look is the
  // giveaway of an unfinished scene). Three capped layers give size variety
  // without a custom shader; per-point colour gives brightness variety.
  const dotTex = makeDotTexture();
  const particleGroups = [];

  for (const layer of PARTICLE_LAYERS) {
    const p = [], c = [];
    for (let i = 0; i < layer.count; i++) {
      const a  = rand() * Math.PI * 2;
      const rr = PARTICLE_INNER + rand() * (PARTICLE_OUTER - PARTICLE_INNER);
      const y  = 1 + rand() * PARTICLE_TOP;
      p.push(Math.sin(a) * rr, y, Math.cos(a) * rr);
      const t = rand();
      _c.copy(t > 0.9 ? ORANGE : t > 0.68 ? MAGENTA : CYAN).multiplyScalar(0.45 + rand() * 0.55);
      c.push(_c.r, _c.g, _c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('color',    new THREE.Float32BufferAttribute(c, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({
      size: layer.size, map: dotTex, vertexColors: true, transparent: true,
      opacity: layer.alpha, blending: THREE.AdditiveBlending,
      depthWrite: false, sizeAttenuation: true, fog: false,
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

  // ── 3. THE MARQUEE ──────────────────────────────────────────────────────────
  // A landmark, not a label: wide, far, framed by its own light-bar, fixed above
  // the central gate and facing the centre of the arena. FrontSide on purpose —
  // turn your back on the scoreboard and it is simply behind you, which is what
  // a stadium does. A double-sided plane would show the wordmark MIRRORED from
  // behind, which is worse than showing nothing.
  const marqueeTex = makeMarqueeTexture('SATS ARENA');
  const marquee = new THREE.Mesh(
    new THREE.PlaneGeometry(MARQUEE.width, MARQUEE.height),
    new THREE.MeshBasicMaterial({
      map: marqueeTex, transparent: true, side: THREE.FrontSide,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.98,
    }),
  );
  marquee.name = 'ArenaMarquee';
  marquee.position.set(0, MARQUEE.y, -MARQUEE.radius);
  marquee.frustumCulled = false;
  decor.add(marquee);
  stats.triangles += 2; stats.drawCalls++;

  // A hairline light-bar under the wordmark, the width of the marquee. It ties
  // the sign to the gate below it, so the wordmark sits ON something instead of
  // hanging in the dark.
  const barY = MARQUEE.y - MARQUEE.height * 0.52;
  const barGeo = new THREE.BufferGeometry().setAttribute('position',
    new THREE.Float32BufferAttribute([
      -MARQUEE.width * 0.46, barY, -MARQUEE.radius,
       MARQUEE.width * 0.46, barY, -MARQUEE.radius,
    ], 3));
  const bar = new THREE.LineSegments(barGeo, new THREE.LineBasicMaterial({
    color: 0x00e5ff, transparent: true, opacity: 0.7,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  bar.name = 'MarqueeBar';
  bar.frustumCulled = false;
  decor.add(bar);
  stats.lineVertices += 2; stats.drawCalls++;

  // ── 4. THE HORIZON MARK ─────────────────────────────────────────────────────
  // ONE ₿, huge, faint, far behind the marquee. It turns slowly through a
  // LIMITED arc rather than spinning: a full rotation would take it edge-on and
  // it would vanish, whereas a slow oscillation reads as a projected volume seen
  // from slightly different sides — a hologram, not a decal.
  // TWO textures, because the two jobs are opposite. The keystones are small and
  // near, so a crisp OUTLINE reads as an engraved emblem. The horizon mark is
  // enormous and faint, and an outline at that scale and opacity simply vanished
  // — a hairline stroke spread over 38 world units at 128 metres is sub-pixel.
  // It needs to be a soft MASS: filled, heavily bloomed, low alpha.
  const glyphTex   = makeGlyphTexture('₿', '#f7931a');
  const horizonTex = makeHorizonGlyphTexture('₿', '#f7931a');
  const horizonMark = new THREE.Mesh(
    new THREE.PlaneGeometry(HORIZON_MARK.size, HORIZON_MARK.size),
    new THREE.MeshBasicMaterial({
      map: horizonTex, transparent: true, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      opacity: HORIZON_MARK.opacity,
    }),
  );
  horizonMark.name = 'HorizonMark';
  horizonMark.position.set(0, HORIZON_MARK.y, -HORIZON_MARK.radius);
  horizonMark.frustumCulled = false;
  horizonMark.renderOrder = -3;   // behind the arch glow and everything else
  decor.add(horizonMark);
  stats.triangles += 2; stats.drawCalls++;

  // ₿ keystones — three only, one at the crown of each gate. The glyph says
  // "gate", so it appears exactly where a gate is. Sprites, so they stay legible
  // from any angle without per-frame lookAt work.
  const keystoneMat = new THREE.SpriteMaterial({
    map: glyphTex, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, opacity: 0.62,
  });
  // The CENTRAL gate is crowned by the marquee, so it does not also get a
  // keystone — two ornaments stacked on one arch is exactly the clutter this
  // redesign is removing. Two keystones, on the two side gates.
  for (const angle of GATE_ANGLES.filter((a) => a !== MARQUEE_ANGLE)) {
    const s = new THREE.Sprite(keystoneMat);
    s.name = 'GateKeystone';
    s.position.set(
      Math.sin(angle) * (GATE.radius - 0.4),
      GATE.height + 2.2,
      Math.cos(angle) * (GATE.radius - 0.4),
    );
    s.scale.setScalar(3.6);
    s.frustumCulled = false;
    decor.add(s);
    stats.triangles += 2; stats.drawCalls++;
  }

  // ── Animation ───────────────────────────────────────────────────────────────
  // Cheap by construction: the arches are STATIC (a merged buffer nobody
  // touches), the particle drift is a whole-object rotation, and only the 10
  // stream segments and the two branding elements do per-frame work.
  const glowMat = glowMesh.material;
  function update(dt, elapsed) {
    for (let i = 0; i < particleGroups.length; i++) {
      particleGroups[i].rotation.y += dt * (0.006 + i * 0.004);
    }
    for (let i = 0; i < STREAM_COUNT; i++) {
      const m = streamMeta[i];
      m.y -= dt * m.speed;
      if (m.y < 1) m.y = PARTICLE_TOP + rand() * 8;
      const o = i * 6;
      streamPos[o + 0] = m.x; streamPos[o + 1] = m.y;         streamPos[o + 2] = m.z;
      streamPos[o + 3] = m.x; streamPos[o + 4] = m.y - m.len; streamPos[o + 5] = m.z;
    }
    streamGeo.attributes.position.needsUpdate = true;

    // The portals BREATHE: one shared opacity on the merged glow, so the whole
    // colosseum brightens and dims together, like a single light source beyond
    // the wall. Two detuned sines so the cycle never audibly repeats. One
    // material write per frame, not one per arch.
    glowMat.opacity = 0.86 + Math.sin(elapsed * 0.23) * 0.09 + Math.sin(elapsed * 0.37) * 0.05;

    // The horizon mark turns through +/-20deg and flickers faintly. The arc is
    // limited by BOTH readability (a full spin goes edge-on and vanishes) and
    // the far plane (see HORIZON_MARK above) — do not widen it without redoing
    // that distance sum.
    horizonMark.rotation.y = Math.sin(elapsed * 0.11) * HORIZON_MARK.swing;
    horizonMark.material.opacity = HORIZON_MARK.opacity
      * (0.82 + Math.sin(elapsed * 1.7) * 0.10 + Math.sin(elapsed * 4.3) * 0.06);
  }

  return { update, stats };
}

// ── Arch geometry ────────────────────────────────────────────────────────────

/**
 * The centreline of one arch: up the left leg, around a semicircular head, down
 * the right leg. Returned as a flat polyline in the arch's own XY plane, which
 * every consumer below either offsets (the rim) or fills (the glow).
 *
 * This is why the arches are not boxes. A box outline has four corners and no
 * curve; this path is sampled around a real semicircle, so the crown is round
 * and the rim thickness follows the curve instead of stepping around it.
 */
function archPath(width, height, headSegments = 18) {
  const hw = width / 2;
  const legTop = Math.max(0.1, height - hw);   // where the semicircle starts
  const pts = [];
  // Left leg, bottom to top. A few samples so the ribbon offset stays even.
  for (let i = 0; i <= 3; i++) pts.push({ x: -hw, y: (legTop * i) / 3 });
  // Semicircular head, left to right.
  for (let i = 1; i < headSegments; i++) {
    const t = (i / headSegments) * Math.PI;    // pi -> 0, going left to right
    pts.push({ x: -hw * Math.cos(t), y: legTop + hw * Math.sin(t) });
  }
  // Right leg, top to bottom.
  for (let i = 3; i >= 0; i--) pts.push({ x: hw, y: (legTop * i) / 3 });
  return pts;
}

/** Outward unit normals along a polyline, averaged at the joints. */
function pathNormals(pts) {
  const n = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    // Rotate the tangent -90deg; for this path that points away from the centre.
    n.push({ x: ty, y: -tx });
  }
  return n;
}

/** Accumulates arch RIMS into one buffer: a constant-width band along the path. */
class MergedRibbon {
  constructor() { this.pos = []; this.col = []; this.triangles = 0; }

  addRibbon(pts, thickness, matrix, colour) {
    const nrm = pathNormals(pts);
    const h = thickness / 2;
    const v = new THREE.Vector3();
    const push = (x, y, shade) => {
      v.set(x, y, 0).applyMatrix4(matrix);
      this.pos.push(v.x, v.y, v.z);
      this.col.push(colour.r * shade, colour.g * shade, colour.b * shade);
    };
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i], p1 = pts[i + 1], n0 = nrm[i], n1 = nrm[i + 1];
      // Rims fade toward the ground so the arches feel planted in the dark
      // rather than pasted on it — the same trick that grounded the old towers,
      // now following a curve.
      const s0 = footFade(p0.y), s1 = footFade(p1.y);
      const a = [p0.x - n0.x * h, p0.y - n0.y * h, s0];
      const b = [p0.x + n0.x * h, p0.y + n0.y * h, s0];
      const c = [p1.x + n1.x * h, p1.y + n1.y * h, s1];
      const d = [p1.x - n1.x * h, p1.y - n1.y * h, s1];
      push(a[0], a[1], a[2]); push(b[0], b[1], b[2]); push(c[0], c[1], c[2]);
      push(a[0], a[1], a[2]); push(c[0], c[1], c[2]); push(d[0], d[1], d[2]);
      this.triangles += 2;
    }
  }

  build(name) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color',    new THREE.Float32BufferAttribute(this.col, 3));
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false,
    }));
    mesh.name = name;
    mesh.frustumCulled = false;
    return mesh;
  }
}

/**
 * Accumulates the arch INTERIORS into one buffer — the soft light beyond the
 * portal. Filled as a fan from the centre of the arch's base, coloured by
 * height: essentially nothing at the foot, blooming under the crown.
 */
class MergedFill {
  constructor() { this.pos = []; this.col = []; this.triangles = 0; }

  addArchFill(pts, matrix, colour, amount) {
    const v = new THREE.Vector3();
    // Inset slightly so the fill sits INSIDE the rim rather than under it.
    const nrm = pathNormals(pts);
    const inset = pts.map((p, i) => ({ x: p.x - nrm[i].x * 0.18, y: p.y - nrm[i].y * 0.18 }));
    const top = Math.max(...inset.map((p) => p.y)) || 1;
    const apex = { x: 0, y: 0 };  // fan origin: the centre of the arch's base
    const halfW = Math.max(...inset.map((p) => Math.abs(p.x))) || 1;
    const push = (p) => {
      v.set(p.x, p.y, 0).applyMatrix4(matrix);
      this.pos.push(v.x, v.y, v.z);
      // TWO falloffs, and both are needed. A vertical gradient alone fills the
      // opening edge-to-edge at the top, which is what made the first attempt
      // read as a rounded SLAB — a tombstone, not a portal. Adding a horizontal
      // falloff pulls the light into a soft column down the middle, so the
      // opening reads as depth with something glowing far behind it.
      //   vertical:   cubed, so the bloom gathers under the crown
      //   horizontal: fades to nothing at the jambs, keeping the rim the
      //               sharpest thing in the arch
      const t = Math.max(0, p.y / top);
      const u = 1 - Math.min(1, Math.abs(p.x) / halfW);
      const s = amount * t * t * t * (0.25 + 0.75 * u);
      this.col.push(colour.r * s, colour.g * s, colour.b * s);
    };
    for (let i = 0; i < inset.length - 1; i++) {
      push(apex); push(inset[i]); push(inset[i + 1]);
      this.triangles++;
    }
  }

  build(name) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color',    new THREE.Float32BufferAttribute(this.col, 3));
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false,
    }));
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;   // behind the rims
    return mesh;
  }
}

/** Rim brightness near the ground — dim at the foot, full by ~3 units up. */
function footFade(y) { return Math.min(1, 0.12 + (y / 3.2) * 0.88); }

/** Shortest angular distance between two headings, in radians. */
function angularGap(a, b) {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

/** Alternate framing: a dark mass behind the arches, lit only along its top. */
function buildWallBand(radius, height, segments) {
  const pos = [], col = [];
  const c = new THREE.Color(0x1d3a6b);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const x0 = Math.sin(a0) * radius, z0 = Math.cos(a0) * radius;
    const x1 = Math.sin(a1) * radius, z1 = Math.cos(a1) * radius;
    const quad = [[x0, 0, z0, 0], [x1, 0, z1, 0], [x1, height, z1, 1], [x0, height, z0, 1]];
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      for (const idx of tri) {
        const q = quad[idx];
        pos.push(q[0], q[1], q[2]);
        const s = 0.06 + q[3] * 0.34;   // near-black at the base, lit at the cap
        col.push(c.r * s, c.g * s, c.b * s);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide, fog: false,
  }));
  mesh.name = 'ArchedWindowWall';
  mesh.frustumCulled = false;
  mesh.renderOrder = -2;
  return { mesh, triangles: segments * 2 };
}

/** Flat ring of points at a height — the wall's lit cap. */
function ringLine(radius, y, segments) {
  const p = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    p.push(Math.sin(a) * radius, y, Math.cos(a) * radius);
  }
  return p;
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

/**
 * The wordmark as NEON TUBE, drawn in three passes on one canvas:
 *   1. a wide outer halo      — the light the tube throws onto the air
 *   2. a mid-weight stroke    — the glass
 *   3. a thin near-white fill — the filament itself
 * A plain filled glyph with a drop shadow reads as text with an effect applied;
 * the three-pass build reads as something that is actually emitting. Tracking is
 * wide and applied per glyph (canvas letterSpacing is not reliable everywhere)
 * because a marquee is read at distance, where tight tracking becomes a smear.
 */
function makeMarqueeTexture(text) {
  const W = 1024, H = 192;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const chars = text.split('');
  const FONT = 'bold 104px monospace';
  const TRACK = 26;                      // extra px between glyphs

  x.font = FONT;
  const widths = chars.map((ch) => x.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + TRACK * (chars.length - 1);
  const startX = (W - total) / 2;
  const baseY = H / 2;

  const pass = (colour, blur, lineWidth, fill) => {
    x.font = FONT;
    x.textAlign = 'left';
    x.textBaseline = 'middle';
    x.shadowColor = colour;
    x.shadowBlur = blur;
    x.strokeStyle = colour;
    x.fillStyle = colour;
    x.lineWidth = lineWidth;
    let cx = startX;
    for (let i = 0; i < chars.length; i++) {
      if (fill) x.fillText(chars[i], cx, baseY);
      else      x.strokeText(chars[i], cx, baseY);
      cx += widths[i] + TRACK;
    }
  };

  pass('rgba(0,150,190,0.85)', 44, 13, false);  // outer halo
  pass('#00e5ff',              22, 7,  false);  // glass
  pass('#eaffff',              10, 0,  true);   // filament

  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/**
 * The horizon mark: a FILLED glyph under a heavy bloom, on a big canvas. Drawn
 * as a soft mass rather than an outline because at 38 world units and 0.30 alpha
 * an outline is thinner than a pixel and disappears entirely.
 */
function makeHorizonGlyphTexture(ch, colour) {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.font = `bold ${Math.round(S * 0.66)}px monospace`;
  const cy = S / 2 + S * 0.02;
  // Halo first, then the body — the halo is what survives at low opacity and
  // gives the mark its "projected volume" edge.
  x.shadowColor = colour;
  x.shadowBlur = 90;
  x.fillStyle = colour;
  x.globalAlpha = 0.5;
  x.fillText(ch, S / 2, cy);
  x.shadowBlur = 40;
  x.globalAlpha = 0.8;
  x.fillText(ch, S / 2, cy);
  // A brighter core edge so it does not read as a smudge.
  x.shadowBlur = 0;
  x.globalAlpha = 1;
  x.lineWidth = 5;
  x.strokeStyle = '#ffd79a';
  x.strokeText(ch, S / 2, cy);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Glowing glyph on transparent — outlined, so it reads as an engraved emblem. */
function makeGlyphTexture(ch, colour) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.font = `bold ${Math.round(S * 0.7)}px monospace`;
  x.shadowColor = colour;
  x.shadowBlur = 40;
  x.strokeStyle = colour;
  x.lineWidth = 6;
  x.strokeText(ch, S / 2, S / 2 + S * 0.02);
  x.fillStyle = colour;
  x.globalAlpha = 0.55;
  x.fillText(ch, S / 2, S / 2 + S * 0.02);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

/** Small deterministic PRNG so the horizon is identical on every load. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
