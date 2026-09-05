import * as THREE from 'three';
import { buildArena } from '../arena.js';
import { attachArenaInto, whenArenaReady, isArenaReady, getArenaState } from './arena-glb.js';

/**
 * registry.js — skin definitions.
 *
 * A SKIN IS A BUNDLE: one coherent set of environment + gun + coins + targets.
 * Switching swaps the whole bundle, never a single piece.
 *
 * Shape:
 *   {
 *     id, name,
 *     environment : { build(group) }   // scenery; everything it adds is scoped
 *                                      // to `group` and torn down with the skin
 *     gun         : { tint }           // null = leave the gun exactly as shipped
 *     coinType    : { tint }           // null = leave coins exactly as shipped
 *     targetTypes : [...]              // which target kinds this skin spawns
 *     hands       : null,              // reserved — future hand models
 *     animations  : null,              // reserved — future skin animations
 *     entry       : { sats }           // paywall; 0 = free (all of them, today)
 *   }
 *
 * `tint` is a hex colour multiplied into the existing materials and fully
 * reverted on teardown (see appearance.js). It is a CRUDE recolour on purpose —
 * the placeholder skin exists to prove switching and scoping, not to look good.
 * Real art arrives later by filling `environment` with a GLB loader.
 *
 * NOTE ON BACKGROUND/FOG: skins deliberately do NOT touch scene.background or
 * scene.fog. armode.js captures those at startup and restores them on XR
 * sessionend, so a skin-owned background would be silently reverted by an
 * AR round-trip. Themed sky/fog needs that ownership question settled first.
 */

// ── classic ───────────────────────────────────────────────────────────────────
// The game EXACTLY as it shipped. buildArena() is the same function main.js
// used to call directly; the only difference is that its output is parented
// into the skin group (an untransformed child of `environment`) so it can be
// torn down. No colours, sizes, or positions change.
const classic = {
  id: 'classic',
  name: 'CLASSIC',
  environment: {
    build(group) {
      buildArena(group); // identical geometry to the original main.js call
    },
  },
  gun: null,       // ship-default gun
  coinType: null,  // ship-default coins
  targetTypes: ['coin', 'satoshi'],
  hands: null,
  animations: null,
  entry: { sats: 0 },
};

// ── placeholder ───────────────────────────────────────────────────────────────
// A deliberately crude, obviously-different variant. Its ONLY job is to make
// "did the switch happen?" and "did the old skin leak?" answerable at a glance.
const placeholder = {
  id: 'placeholder',
  name: 'PLACEHOLDER',
  devOnly: true,   // hidden from the public menu; see DEV_MODE below
  environment: {
    build(group) {
      const GREEN = 0x39ff88;
      const PINK  = 0xff3ea5;

      // Four walls — same footprint as classic so the play space is unchanged,
      // but unmistakably different colours and a wireframe treatment.
      const RADIUS = 10, W = 20, H = 6;
      const panelMat = new THREE.MeshBasicMaterial({
        color: 0x101a14, side: THREE.FrontSide, transparent: true, opacity: 0.65,
      });
      const edgeMat = new THREE.LineBasicMaterial({ color: GREEN });

      [0, Math.PI / 2, Math.PI, Math.PI * 1.5].forEach((angle) => {
        const geo = new THREE.PlaneGeometry(W, H);
        const panel = new THREE.Mesh(geo, panelMat);
        panel.position.set(Math.sin(angle) * RADIUS, H / 2, Math.cos(angle) * RADIUS);
        panel.rotation.y = angle;
        group.add(panel);

        const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
        outline.position.copy(panel.position);
        outline.rotation.copy(panel.rotation);
        group.add(outline);
      });

      // Pink ceiling ring instead of classic's cyan one.
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(RADIUS - 0.05, RADIUS + 0.05, 32),
        new THREE.MeshBasicMaterial({
          color: PINK, side: THREE.DoubleSide, transparent: true, opacity: 0.45,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = H;
      group.add(ring);

      // Eight pillars classic does NOT have — the clearest possible "did the old
      // skin get torn down?" tell. If these survive a switch back to classic,
      // teardown leaked.
      const pillarMat = new THREE.MeshBasicMaterial({
        color: PINK, transparent: true, opacity: 0.5, wireframe: true,
      });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.6, H, 0.6), pillarMat);
        pillar.position.set(Math.sin(a) * (RADIUS - 1.5), H / 2, Math.cos(a) * (RADIUS - 1.5));
        group.add(pillar);
      }
    },
  },
  gun:      { tint: 0x39ff88 }, // crude green gun
  coinType: { tint: 0xff3ea5 }, // crude pink coins
  targetTypes: ['coin', 'satoshi'],
  hands: null,
  animations: null,
  entry: { sats: 0 },
};

// ── gold-arena ────────────────────────────────────────────────────────────────
// The "Imperial Gold" arena GLB (or, on a hard validation failure, its 360
// panorama fallback — arena-glb.js decides and reports which). The asset is
// preloaded once at boot and re-parented on each switch, so build() stays
// synchronous like every other skin.
const goldArena = {
  id: 'gold-arena',
  name: 'GOLD ARENA',
  environment: {
    build(group) {
      // Attaches immediately when preloaded. If a switch somehow beats the
      // load, whenReady() below holds the both-ready handshake open until the
      // arena is actually in the scene, so nobody resumes into an empty world.
      if (!attachArenaInto(group)) {
        whenArenaReady().then(() => attachArenaInto(group));
      }
    },
  },
  gun: null,        // keep the shipped gun against the gold architecture
  coinType: null,   // and the shipped coins
  // This environment brings its own floor, so the base radar floor must be
  // hidden or it z-fights and bleeds cyan through the stone.
  hidesBaseFloor: true,
  targetTypes: ['coin', 'satoshi'],
  hands: null,
  animations: null,
  entry: { sats: 0 },

  // Optional per-skin readiness, honoured by the P30 both-ready handshake.
  whenReady: () => whenArenaReady(),
  isReady:   () => isArenaReady(),
  // Shown in the picker while the 7 MB GLB streams in.
  readyLabel: () => (isArenaReady() ? (getArenaState().source === 'panorama' ? '360°' : 'FREE') : 'LOADING…'),
};

// Order here is the order the picker shows them in. classic is index 0 and is
// the boot default — the game must look untouched until someone switches.
const SKINS = [classic, goldArena, placeholder];

export const DEFAULT_SKIN_ID = classic.id;

// ── Dev-only skins ────────────────────────────────────────────────────────────
// PLACEHOLDER is the crude green/pink leak-test skin from the skins seam work.
// It is a DEV TOOL, not a product, so it is ABSENT from the public menu rather
// than dimmed — a locked-looking row would imply something buyable. It stays in
// the code (and in getSkin/hasSkin) because it is still how the named-group
// teardown gets verified.
//
// Same flag the DEV/MOCK panel uses (mock-dev-panel.js): ?dev in the URL.
const DEV_MODE = new URLSearchParams(location.search).has('dev');

/**
 * Skins the picker should offer. Dev-only skins are filtered out unless ?dev.
 * NOTE: getSkin()/hasSkin() below are deliberately NOT filtered, so a ?dev host
 * can still switch a non-dev peer onto the placeholder — the peer resolves the
 * id it was sent and builds it, which is exactly what the leak test needs.
 */
export function listSkins()     { return SKINS.filter((s) => !s.devOnly || DEV_MODE); }
export function getSkin(id)     { return SKINS.find((s) => s.id === id) || null; }
export function hasSkin(id)     { return !!getSkin(id); }
