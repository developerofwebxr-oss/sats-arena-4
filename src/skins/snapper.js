import * as THREE from 'three';
import { playSample, preloadSample } from '../audio.js';
import snapperRiggedUrl from '../assets/satoshi-snapper-rigged.glb?url';
import snapperMobileUrl from '../assets/satoshi-snapper-mobile.glb?url';
import snapSfxUrl from '../assets/sfx/snapper-snap.m4a?url';

/**
 * snapper.js — the Satoshi Snapper: the creature, its clips, and its hitbox.
 *
 * This is HALF of config #2. The other half is the config object in
 * carnivorous-glb.js; door-targets.js (P42b) is untouched except for two
 * options a modelled creature needs and a sprite never did. Everything about
 * WHEN it appears, on which maw, who scores and what goes on the wire is the
 * generic system's, not this file's.
 *
 * ── THE PACK SHIPPED NOTES, AND THEY ARE ACCURATE ───────────────────────────
 * Unlike the Carnivorous arena pack, satoshi-snapper-rigged-pack.zip is intact
 * and carries a README plus a rig manifest. Every number below was re-measured
 * from the GLBs and matches what it claims:
 *
 *   rigged  121,978 tris   mobile  47,264 tris   both: 12 primitives,
 *   12 materials, six 512x512 textures, ONE 32-joint skin, identical clips.
 *   Metres, +Y up, +Z FORWARD, root origin AT THE FEET, 2.902 m tall,
 *   1.782 m wide, and the pack's own conversion for a target height.
 *
 * ── THE CLIPS IT HAS, AND THE ONE IT DOES NOT ───────────────────────────────
 *   Idle          3.00 s  body/head motion, gentle jaw, petal flex
 *   Walk_InPlace  1.20 s  alternating legs and arms, no root motion
 *   Bite          0.80 s  jaw closure and head/tongue motion
 *   HitReact      0.55 s  body recoil and head tilt
 *
 * There is NO emerge, lunge or death clip. So the lunge OUT of the maw and the
 * retreat back into it are PROCEDURAL — driven by door-targets' own travel,
 * which is what that system already does — and the clips cover everything that
 * happens in place: Walk_InPlace while it hauls itself out (legs working as it
 * comes), Idle while it waits, Bite on its own rhythm while it is out, HitReact
 * when it is shot. Nothing is faked that the rig can actually do, and nothing is
 * claimed that it cannot: there is no death animation, so a hit plays HitReact
 * and the generic retract takes it back inside.
 *
 * ── WHICH GLB, AND THE RULE ─────────────────────────────────────────────────
 * The detailed model on capable devices, the mobile model on MEASURED-weak ones,
 * with the arena's thresholds and the arena's principle: UNKNOWN IS NOT WEAK,
 * because Safari does not report deviceMemory and demoting on "unknown" is how
 * every iPhone got the fallback in P36. Overridable with ?snapper=rigged /
 * ?snapper=mobile.
 *
 * A device that measures weak also gets the PANORAMA arena, which has no maws —
 * so in normal play a weak device sees no Snapper at all, and the reduced model
 * is reached by ?arena=glb on such a device, or by ?snapper=mobile anywhere.
 * That is worth knowing before reading anything into the variant on a phone.
 *
 * On the P32 budget: that prompt cut the gun from 374,990 to 44,998 triangles
 * because triangle count, not draw calls, was the frame. One detailed Snapper is
 * 121,978 on top of the Carnivorous arena's 565,136 and the gun's 44,998 — call
 * it 732k in frame with one creature out, against 612k with none. The mobile
 * model puts that at 657k for a creature that is 10 m away and 1.8 m tall. Both
 * numbers are reported at load so the choice can be made on a headset with a
 * frame counter rather than on taste.
 */

// The pack suggests 1.8 m "for a 1.8 m creature", and at 1.8 m in a 3.81 m maw
// twelve metres away it read as a doll standing in a doorway. This is a monster
// in a room built around twelve mouths: 2.5 m fills the aperture, is legible at
// the far side of a 31 m arena, and still clears the sill and the lintel.
const TARGET_HEIGHT = 2.5;
const MODEL_HEIGHT  = 2.9013;
const MODEL_SCALE   = TARGET_HEIGHT / MODEL_HEIGHT;

// The maw's centre is ~2.1 m up and the model's origin is at its FEET, so the
// creature is dropped by half its height: its middle ends up on the aperture
// centre and it hangs OUT of the mouth, which is what something lunging from a
// hole in a trunk does. Standing it on the sill would put its head inside.
const BODY_DROP = -TARGET_HEIGHT / 2;

// Idle snaps while it is out. Not a fixed beat — a metronome reads as a machine.
const SNAP_MIN_S = 1.4;
const SNAP_MAX_S = 2.8;

const CLIP = { IDLE: 'Idle', WALK: 'Walk_InPlace', BITE: 'Bite', HIT: 'HitReact' };

/**
 * Detailed model or mobile model, decided by MEASUREMENT.
 *
 * The thresholds are the arena's, deliberately: same rule, same severity, and
 * UNKNOWN IS NOT WEAK — Safari does not implement deviceMemory, so anything
 * that treats "unknown" as weak hands every iPhone the reduced model.
 *
 * It measures here rather than calling preferGlbArena(), which looks the same
 * and is not: that function answers ?arena=glb FIRST, so borrowing it would
 * make an ARENA override silently pick the creature's LOD too. ?snapper=
 * overrides this one, and nothing else does.
 */
function wantDetailed() {
  try {
    const q = new URLSearchParams(location.search).get('snapper');
    if (q === 'rigged') return true;
    if (q === 'mobile') return false;
  } catch { /* no URL */ }
  const mem   = navigator.deviceMemory;         // undefined on iOS Safari
  const cores = navigator.hardwareConcurrency;  // undefined on some browsers
  const weakMemory = typeof mem === 'number' && mem <= 2;
  const weakCpu    = typeof cores === 'number' && cores <= 2;
  return !(weakMemory || weakCpu);
}

/**
 * Load the creature and wrap it in everything the door-target system needs:
 * a visual to mount, a cheap hitbox, and a per-frame driver that turns the
 * target's own lifecycle into animation. Idempotent per page.
 *
 * @returns {Promise<object|null>}
 */
let _promise = null;
export function loadSnapper() {
  if (_promise) return _promise;
  _promise = _load().catch((e) => {
    console.warn('[snapper] load failed — the Carnivorous arena keeps its maws, ' +
      'but nothing will come out of them', e);
    return null;
  });
  return _promise;
}

async function _load() {
  const detailed = wantDetailed();
  const url = detailed ? snapperRiggedUrl : snapperMobileUrl;

  const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/loaders/DRACOLoader.js'),
  ]);
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
  draco.preload();
  loader.setDRACOLoader(draco);

  const t0 = performance.now();
  const gltf = await loader.loadAsync(url);
  const model = gltf.scene;
  model.name = 'SatoshiSnapper';

  // ── Placement, per the pack's contract ────────────────────────────────────
  // The model faces +Z and the door pose's +Z points into the arena, so no
  // rotation is needed: mounted on a maw, it already faces the players.
  const visual = new THREE.Group();
  visual.name = 'SnapperVisual';
  model.scale.setScalar(MODEL_SCALE);
  model.position.y = BODY_DROP;
  visual.add(model);

  let triangles = 0;
  const skinned = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = false;
    o.frustumCulled = false;      // a skinned mesh's bounds do not follow its pose
    const g = o.geometry;
    triangles += g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
    // RAYCASTING A SKINNED MESH IS THE WRONG TOOL. three would have to walk
    // 122k triangles and bone-transform each candidate vertex, per shot, on the
    // main thread — for a creature the size of a person that a player is aiming
    // at with a crosshair. The box below is the hitbox; these opt out.
    o.raycast = () => {};
    skinned.push(o);
  });

  // ── The hitbox ────────────────────────────────────────────────────────────
  // Sized from the bind pose and left a little generous: this thing is meant to
  // be EASIER to hit than the Satoshi plane — 0.90 x 1.66 m against 0.78 x 0.78,
  // about two and a half times the area a shooter is aiming at.
  // The material is `visible: false`, which stops it rendering while leaving it
  // raycastable — an object with visible=false would be skipped by the graph
  // walk, and a transparent material would still cost a draw call.
  const bind = new THREE.Box3().setFromObject(model);
  const size = bind.getSize(new THREE.Vector3());
  const centre = bind.getCenter(new THREE.Vector3());
  const hitProxy = new THREE.Mesh(
    new THREE.BoxGeometry(Math.max(0.9, size.x * 0.78), Math.max(1.2, size.y * 0.92), Math.max(0.7, size.z * 1.15)),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hitProxy.name = 'SnapperHitbox';
  hitProxy.position.copy(centre);
  visual.add(hitProxy);

  // ── The light it brings with it ───────────────────────────────────────────
  // The Conservatory is deliberately dark and its key light is a shaft down the
  // MIDDLE of the room, so a creature at the wall was a silhouette in a hole:
  // present, but unreadable, and unfair to shoot at. This is a small warm light
  // travelling with the creature, sat in front of its chest and aimed at
  // nothing — it reads as the maw's own glow spilling onto whatever came out,
  // and it is only ever in the scene while something is out, because the mount
  // is hidden the rest of the time.
  const spill = new THREE.PointLight(0xff8a46, 34, 8.5, 1.9);
  spill.name = 'SnapperSpill';
  spill.position.set(0, TARGET_HEIGHT * 0.15, 1.1);
  visual.add(spill);

  // ── Animation ─────────────────────────────────────────────────────────────
  const mixer = new THREE.AnimationMixer(model);
  const actions = new Map();
  for (const clip of gltf.animations) {
    const a = mixer.clipAction(clip);
    a.clampWhenFinished = true;
    actions.set(clip.name, a);
  }
  const has = (n) => actions.has(n);
  const clipNames = [...actions.keys()];

  let current = null;
  function play(name, { loop = true, fade = 0.18, timeScale = 1 } = {}) {
    const next = actions.get(name);
    if (!next || current === next) return;
    next.reset();
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    next.timeScale = timeScale;
    next.enabled = true;
    if (current) next.crossFadeFrom(current, fade, false);
    next.play();
    current = next;
  }

  /** A one-shot layered over whatever is running, then handed back to Idle. */
  function oneShot(name, { timeScale = 1 } = {}) {
    const a = actions.get(name);
    if (!a) return false;
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.timeScale = timeScale;
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.play();
    return true;
  }
  mixer.addEventListener('finished', (e) => {
    // Bite and HitReact both return to Idle — the pack's own controller does the
    // same, and it is what stops a one-shot freezing on its last frame.
    if (e.action !== current) { e.action.stop(); current?.setEffectiveWeight(1); }
  });

  preloadSample(snapSfxUrl);

  // ── The driver ────────────────────────────────────────────────────────────
  // Reads the door-target's OWN state rather than keeping a second copy of the
  // lifecycle. There is one source of truth about what is happening and it is
  // door-targets.js; this only decides what the body does about it.
  let phase = null;
  let hitPlayed = false;
  let nextSnapAt = 0;
  let outFor = 0;

  function update(dt, state) {
    mixer.update(dt);

    if (!state) {                       // nothing out: stop animating a hidden thing
      if (phase !== null) { current?.fadeOut(0.1); current = null; phase = null; }
      return;
    }

    if (state.phase !== phase) {
      phase = state.phase;
      hitPlayed = false;
      if (phase === 'emerging') {
        // Legs working as it hauls itself out. The clip has no root motion, so
        // the travel is still the generic system's — this is just the body.
        play(CLIP.WALK, { loop: true, fade: 0.05, timeScale: 1.35 });
      } else if (phase === 'out') {
        play(CLIP.IDLE, { loop: true, fade: 0.25 });
        outFor = 0;
        nextSnapAt = SNAP_MIN_S * 0.5;   // one early snap so it announces itself
      } else if (phase === 'retracting') {
        play(CLIP.WALK, { loop: true, fade: 0.1, timeScale: -1.1 });  // backing in
      }
    }

    // Shot: recoil once, and let the generic retract take it away.
    if (state.hitBy && !hitPlayed) {
      hitPlayed = true;
      oneShot(CLIP.HIT, { timeScale: 1.15 });
      return;
    }

    // Idle snaps while it is out — the cartoon jaw sound with the Bite clip, on
    // an irregular beat.
    if (phase === 'out') {
      outFor += dt;
      if (outFor >= nextSnapAt) {
        nextSnapAt = outFor + SNAP_MIN_S + Math.random() * (SNAP_MAX_S - SNAP_MIN_S);
        if (oneShot(CLIP.BITE, { timeScale: 1.1 })) {
          try { playSample(snapSfxUrl, { gain: 0.7 }); } catch { /* audio is never fatal */ }
        }
      }
    }
  }

  const stats = {
    variant: detailed ? 'rigged' : 'mobile',
    url: url.split('/').pop(),
    triangles: Math.round(triangles),
    meshes: skinned.length,
    bones: (() => { let n = 0; model.traverse((o) => { if (o.isBone) n++; }); return n; })(),
    clips: clipNames,
    usedClips: {
      emerging: has(CLIP.WALK) ? CLIP.WALK : '(procedural travel only)',
      out: has(CLIP.IDLE) ? CLIP.IDLE : '(none)',
      snap: has(CLIP.BITE) ? CLIP.BITE : '(none)',
      hit: has(CLIP.HIT) ? CLIP.HIT : '(none)',
      emergeMotion: 'procedural — the pack ships no emerge/lunge/death clip',
    },
    heightMetres: +(size.y).toFixed(2),
    hitboxMetres: [
      +hitProxy.geometry.parameters.width.toFixed(2),
      +hitProxy.geometry.parameters.height.toFixed(2),
      +hitProxy.geometry.parameters.depth.toFixed(2),
    ],
    loadMs: Math.round(performance.now() - t0),
  };

  console.log(`[snapper] ${stats.variant} loaded — ${stats.triangles} tris, ${stats.bones} bones, ` +
    `clips [${clipNames.join(', ')}], hitbox ${stats.hitboxMetres.join('x')} m, ${stats.loadMs}ms`);

  return { object: visual, update, play, stats, mixer, hitProxy };
}
