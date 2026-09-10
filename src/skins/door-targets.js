import * as THREE from 'three';
import { sendEvent, onPeerEvent, onPeerLeave, getParticipantCount, getRoomName } from '../net/room.js';
import { getOwnCode } from '../net/coop-hud.js';

/**
 * door-targets.js — a GENERIC "something comes out of a door" target system.
 *
 * Built once, configured per skin. Satoshi in the Gold Arena is config #1; the
 * Carnivorous "Snapper" (P47) is meant to be config #2 and should need no code
 * here — only a config object. Nothing below mentions Satoshi.
 *
 * ── The config shape (this is the contract P47 codes against) ───────────────
 *   {
 *     id            string   unique per skin; used on the wire
 *     model         { kind: 'plane', texture: THREE.Texture, size: [w,h] }
 *                 | { kind: 'object3d', object: THREE.Object3D }
 *                   The MOUNT is swappable: 'plane' is the sprite-plane path,
 *                   'object3d' takes anything already built (a loaded GLB scene,
 *                   a group) so a modelled Snapper drops in without new code.
 *     points        number   awarded to whoever hits it
 *     spawnCadence  [min,max] seconds between attempts
 *     holdTime      number   seconds out before it gives up and retracts
 *     emergeSeconds number   travel time out (and back)
 *     sounds        { emerge?: fn, hit?: fn }  FUNCTIONS, not urls — see audio.js
 *     emergeStyle   'pop' | 'slide'
 *     bob           { amplitude, hz }  vertical drift while held out
 *     offset        number   metres proud of the door face when fully out
 *     retreat       number   metres BEHIND the door face when fully in. 0 (the
 *                            default) starts flush, which is right for a sprite;
 *                            a modelled creature starts inside the passage so
 *                            the doorway itself hides it on the way in and out.
 *     scaleWithTravel boolean  default true: the mount scales 0->1 as it comes
 *                            out, which is the sprite "pop". A creature does not
 *                            GROW out of a hole, it comes through it, so a model
 *                            sets this false and keeps its own size throughout.
 *     targetLight   { colour, intensity, distance, decay, offset:[x,y,z] } | null
 *                            A light that travels with whatever is out. Both
 *                            arenas are dark by design and both put their doors
 *                            on the WALL, away from the key light, so a target
 *                            that has just appeared is the one thing on screen
 *                            with no light on it. This is one PointLight, built
 *                            once with the mount, switched on when the target
 *                            emerges and off the moment it is gone — so a skin
 *                            with nothing out pays nothing, and there is never
 *                            more than one extra light in the scene.
 *                            null (the default) keeps the old unlit behaviour.
 *   }
 *
 * ── Host authority (mirrors the shared-coin rule from P19) ─────────────────
 * The HOST picks the door and the timing and broadcasts it; both clients render
 * the same target on the same door. A hit is a CLAIM sent to the host, and the
 * host applies FIRST CLAIM WINS, credits that shooter, and broadcasts the
 * result. A peer never scores itself — that is what stops both players banking
 * the same target when two shots land within a round-trip of each other.
 * Solo runs the whole loop locally with no traffic. Everything goes on the
 * RELIABLE channel: a dropped spawn or close would leave a target stuck out.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 * The mount is parented into whatever group the caller passes, which for the
 * Gold Arena is the arena root — so it is Gold-only, travels with the cached
 * arena, and is hidden with `environment` in AR.
 *
 * AR: NO TARGETS SPAWN. armode.js sets environment.visible = false in
 * passthrough, which hides the arena, its doors and therefore this. Spawning
 * into it would mean a target you cannot see, a laugh from nowhere, and points
 * you cannot earn — so the scheduler is explicitly gated OFF while an AR session
 * is presenting rather than merely being invisible.
 */

const MSG = {
  SPAWN: 'dt-spawn',   // host -> peers : open this door and send this target out
  CLAIM: 'dt-claim',   // peer -> host  : I hit it
  HIT:   'dt-hit',     // host -> peers : X got it, retract
  CLOSE: 'dt-close',   // host -> peers : nobody got it, retract
};

const isHost  = () => !!getOwnCode() && getRoomName() === getOwnCode();
const hasPeer = () => getParticipantCount() >= 2;
const send = (t, extra = {}) => sendEvent({ t, ...extra }, { reliable: true });

/** Ease used for both directions of travel — soft out, soft in. */
const easeOutBack = (t) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const easeInCubic = (t) => t * t * t;

/**
 * @param {object} opts
 * @param {object} opts.doors      the P41 door API (openDoor/closeDoor/getDoorPose/...)
 * @param {THREE.Object3D} opts.parent  where the target mount lives
 * @param {object} opts.config     see the config shape above
 * @param {() => boolean} opts.isSuppressed  true when targets must not spawn (AR)
 * @param {(points:number) => void} opts.onLocalScore  credit the local player
 * @param {(pose:{position:THREE.Vector3}|null) => void} [opts.onTargetChange]
 *   P44: fired with the door's world pose when a target becomes visible, and
 *   with null when it goes. The arrow subscribes to this instead of watching
 *   door state, so there is exactly one source of truth about what is out.
 * @param {() => THREE.Camera} opts.getCamera  for raycast-based hit tests
 */
export function setupDoorTargets({ doors, parent, config, isSuppressed, onLocalScore, getCamera, onTargetChange }) {
  if (!doors || !config) return null;

  const cfg = {
    points: 42,
    spawnCadence: [20, 40],
    holdTime: 7,
    emergeSeconds: 0.45,
    emergeStyle: 'pop',
    offset: 0.55,
    retreat: 0,
    scaleWithTravel: true,
    bob: { amplitude: 0.05, hz: 0.5 },
    sounds: {},
    targetLight: null,
    ...config,
  };

  // ── The mount ─────────────────────────────────────────────────────────────
  // One object, reused for every appearance. Building it per spawn would churn
  // geometry and textures for something that appears once every 30 seconds.
  const mount = new THREE.Group();
  mount.name = `DoorTarget:${cfg.id}`;
  mount.visible = false;
  parent.add(mount);

  let visual = null;
  let baseScale = 1;
  if (cfg.model?.kind === 'object3d' && cfg.model.object) {
    visual = cfg.model.object;
  } else if (cfg.model?.texture) {
    const [w, h] = cfg.model.size || [0.8, 0.8];
    visual = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        map: cfg.model.texture,
        transparent: true,
        alphaTest: 0.35,      // kill the fringe the keyed PNG leaves at its edge
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
  }
  if (!visual) { console.warn(`[door-target] "${cfg.id}" has no model`); return null; }
  visual.name = `${mount.name}:visual`;
  mount.add(visual);

  // ── The target light ──────────────────────────────────────────────────────
  // Parented to the MOUNT, so it travels with the target for free: no per-frame
  // position write, no allocation, and it is hidden with the mount between
  // appearances. Built once, like everything else here.
  //
  // It sits slightly in FRONT of the target (mount +Z is the direction it
  // travels into the room) rather than behind it — a light between the target
  // and the wall would rim it and leave the face the player is aiming at dark,
  // which is the problem this exists to solve.
  let targetLight = null;
  if (cfg.targetLight) {
    const L = cfg.targetLight;
    targetLight = new THREE.PointLight(
      L.colour ?? L.color ?? 0xffffff,
      L.intensity ?? 20,
      L.distance ?? 6,
      L.decay ?? 1.9,
    );
    targetLight.name = `${mount.name}:light`;
    targetLight.position.fromArray(L.offset || [0, 0.15, 0.9]);
    targetLight.visible = false;      // only ever on while something is out
    mount.add(targetLight);
  }

  // ── State ─────────────────────────────────────────────────────────────────
  // ONE ACTIVE AT A TIME, by construction: `active` is a single slot, and the
  // scheduler refuses to arm while it is filled.
  let active = null;   // { doorId, phase, t, spawnAt, base, normal, hitBy }
  let nextAt = null;   // seconds on the local clock for the next attempt
  let elapsed = 0;
  const _v = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const raycaster = new THREE.Raycaster();

  function scheduleNext() {
    const [lo, hi] = cfg.spawnCadence;
    nextAt = elapsed + lo + Math.random() * (hi - lo);
  }
  scheduleNext();

  // ── Placement ─────────────────────────────────────────────────────────────
  // The door anchors face the arena centre (local +Z points inward), so the
  // target's outward normal — the direction it travels to come at the players —
  // is that same +Z. A plane placed with the door's rotation therefore faces the
  // players with no extra work.
  function poseFor(doorId) {
    const pose = doors.getDoorPose(doorId);
    if (!pose) return null;
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(pose.quaternion).normalize();
    return { base: pose.position.clone(), quaternion: pose.quaternion.clone(), normal };
  }

  function beginSpawn(doorId, { announce }) {
    const pose = poseFor(doorId);
    if (!pose) return;
    active = { doorId, phase: 'opening', t: 0, ...pose, hitBy: null };
    doors.openDoor(doorId);
    if (announce) send(MSG.SPAWN, { id: cfg.id, doorId });
  }

  // The door has to be OPEN before anything comes out of it, so the emerge is
  // driven by the door's own onOpened callback rather than by a guessed delay.
  const offOpened = doors.onOpened((doorId) => {
    if (!active || active.doorId !== doorId || active.phase !== 'opening') return;
    active.phase = 'emerging';
    active.t = 0;
    mount.visible = true;
    if (targetLight) targetLight.visible = true;
    // Announce as soon as it STARTS coming out, not when it finishes: the point
    // of the arrow is to turn the player's head while there is still time.
    onTargetChange?.({ position: active.base.clone().addScaledVector(active.normal, cfg.offset) });
    try { cfg.sounds.emerge?.(); } catch (e) { console.warn('[door-target] emerge sound', e); }
  });

  function retract(reason) {
    if (!active || active.phase === 'retracting' || active.phase === 'done') return;
    // Stop pointing the moment it starts going away — an arrow that lingers over
    // a closing door sends the player somewhere there is nothing to shoot.
    onTargetChange?.(null);
    active.phase = 'retracting';
    active.t = 0;
    active.reason = reason;
  }

  function finish() {
    if (active) doors.closeDoor(active.doorId);
    active = null;
    mount.visible = false;
    if (targetLight) targetLight.visible = false;
    onTargetChange?.(null);
    scheduleNext();
  }

  // ── Hit handling ──────────────────────────────────────────────────────────
  /**
   * Called from the shooting path with a world ray.
   * @returns {{point: THREE.Vector3, points: number}|null} the hit, so the
   * shooter can put its burst and floater in the right place — and null when it
   * missed, so the shot falls through to the normal coin test unchanged.
   */
  function tryHit(origin, direction) {
    if (!active || !mount.visible) return null;
    if (active.phase === 'retracting' || active.hitBy) return null;
    // Raycast against where the face IS, not where it was drawn. The mount is
    // animated every update() and its world matrix is otherwise only refreshed
    // by the renderer, so without this a shot tests the PREVIOUS frame's
    // transform — a whole frame stale during the pop, when the plane is still
    // scaling up from nothing. It is a two-node subtree; the update is free.
    mount.updateWorldMatrix(true, true);
    raycaster.set(origin, direction);
    const hits = raycaster.intersectObject(mount, true);
    if (!hits.length) return null;

    if (!hasPeer()) {           // solo: resolve immediately, no traffic
      applyHit('me', true);
    } else if (isHost()) {      // host: I am the authority, so I decide now
      applyHit('me', true);
      send(MSG.HIT, { id: cfg.id, doorId: active.doorId, by: 'host' });
    } else {                    // peer: CLAIM only. The host credits, not me.
      send(MSG.CLAIM, { id: cfg.id, doorId: active.doorId });
    }
    return { point: hits[0].point.clone(), points: cfg.points };
  }

  function applyHit(who, creditLocal) {
    if (!active || active.hitBy) return;
    active.hitBy = who;
    active.flashUntil = performance.now() + 220;
    try { cfg.sounds.hit?.(); } catch (e) { console.warn('[door-target] hit sound', e); }
    if (creditLocal) onLocalScore?.(cfg.points);
    retract('hit');
  }

  // ── Wire ──────────────────────────────────────────────────────────────────
  onPeerEvent((msg) => {
    if (!msg || typeof msg.t !== 'string' || msg.id !== cfg.id) return;
    switch (msg.t) {
      case MSG.SPAWN:
        // Peers render what the host chose. A peer never picks a door.
        if (isHost()) return;
        if (active) finish();
        beginSpawn(msg.doorId, { announce: false });
        break;

      case MSG.CLAIM: {
        // FIRST CLAIM WINS. Only the host runs this, and only once — a second
        // claim arriving a few ms later finds hitBy already set and is dropped,
        // which is what stops both players banking the same target.
        if (!isHost() || !active || active.hitBy) return;
        if (msg.doorId !== active.doorId) return;
        active.hitBy = 'peer';
        active.flashUntil = performance.now() + 220;
        try { cfg.sounds.hit?.(); } catch { /* non-fatal */ }
        retract('hit');
        send(MSG.HIT, { id: cfg.id, doorId: active.doorId, by: 'peer' });
        break;
      }

      case MSG.HIT:
        if (isHost()) return;
        if (!active || msg.doorId !== active.doorId) return;
        // by:'peer' means the HOST is telling us WE got it.
        applyHit(msg.by, msg.by === 'peer');
        break;

      case MSG.CLOSE:
        if (isHost()) return;
        if (!active || msg.doorId !== active.doorId) return;
        retract('timeout');
        break;

      default: break;
    }
  });

  // A peer leaving mid-spawn must not strand a target out of a door.
  onPeerLeave(() => { if (active) retract('peer-left'); });

  // ── Per-frame ─────────────────────────────────────────────────────────────
  function update(dt) {
    elapsed += dt;

    // AR: explicitly OFF, not merely invisible. See the header note.
    const suppressed = isSuppressed ? isSuppressed() : false;
    if (suppressed) {
      if (active) { finish(); }
      return;
    }

    // Only the host (or a solo player) schedules. A peer's targets arrive on the
    // wire, so a peer scheduling too would double the spawn rate.
    if (!active && (!hasPeer() || isHost()) && nextAt !== null && elapsed >= nextAt) {
      const ids = doors.listDoors().filter((id) => !doors.isOpen(id) && !doors.isMoving(id));
      if (ids.length) beginSpawn(ids[(Math.random() * ids.length) | 0], { announce: hasPeer() });
      else scheduleNext();
    }

    if (!active) return;

    switch (active.phase) {
      case 'opening':
        break; // waiting on the door's onOpened

      case 'emerging':
        active.t += dt / cfg.emergeSeconds;
        if (active.t >= 1) { active.t = 1; active.phase = 'out'; active.outAt = elapsed; }
        placeMount(cfg.emergeStyle === 'pop' ? easeOutBack(active.t) : active.t);
        break;

      case 'out':
        placeMount(1);
        if (elapsed - active.outAt >= cfg.holdTime) {
          // Timed out. The HOST announces the close so both sides retract
          // together; a peer just waits to be told.
          if (!hasPeer() || isHost()) {
            if (hasPeer()) send(MSG.CLOSE, { id: cfg.id, doorId: active.doorId });
            retract('timeout');
          }
        }
        break;

      case 'retracting':
        active.t += dt / cfg.emergeSeconds;
        if (active.t >= 1) { finish(); return; }
        placeMount(1 - easeInCubic(active.t));
        break;

      default: break;
    }
  }

  /** @param {number} k 0 = fully in (flush, or `retreat` deep), 1 = fully out. */
  function placeMount(k) {
    const kk = Math.max(0, k);   // easeOutBack overshoots past 1 on purpose
    const out = -cfg.retreat + kk * (cfg.offset + cfg.retreat);
    _v.copy(active.base).addScaledVector(active.normal, out);
    if (active.phase === 'out' && cfg.bob) {
      _v.y += Math.sin(elapsed * Math.PI * 2 * cfg.bob.hz) * cfg.bob.amplitude;
    }
    mount.position.copy(_v);
    mount.quaternion.copy(active.quaternion);

    // Hit reaction: a brief squash + flash rather than a new asset, so it works
    // for any configured model including a GLB.
    let s = baseScale;
    if (active.hitBy && performance.now() < (active.flashUntil || 0)) {
      const f = (active.flashUntil - performance.now()) / 220;
      s = baseScale * (1 + 0.25 * f);
      if (visual.material) visual.material.color?.setScalar(1 + 1.5 * f);
    } else if (visual.material) {
      visual.material.color?.setScalar(1);
    }
    mount.scale.setScalar(cfg.scaleWithTravel
      ? s * Math.max(0.001, Math.min(1, k))
      : s);
  }

  // ── Public ────────────────────────────────────────────────────────────────
  return {
    update,
    tryHit,
    config: cfg,
    /** Test/diagnostic surface — also what a host uses to force a spawn. */
    spawnNow: (doorId) => {
      if (active) return false;
      const ids = doors.listDoors().filter((id) => !doors.isOpen(id) && !doors.isMoving(id));
      const pick = doorId || ids[(Math.random() * ids.length) | 0];
      if (!pick) return false;
      beginSpawn(pick, { announce: hasPeer() && isHost() });
      return true;
    },
    getState: () => (active
      ? { doorId: active.doorId, phase: active.phase, hitBy: active.hitBy, visible: mount.visible }
      : null),
    secondsToNext: () => (nextAt === null ? null : Math.max(0, nextAt - elapsed)),
    mount,
    dispose: () => {
      offOpened?.();
      targetLight?.parent?.remove(targetLight);
      mount.parent?.remove(mount);
      if (visual?.geometry) visual.geometry.dispose();
      if (visual?.material) visual.material.dispose();
    },
    stats: {
      id: cfg.id,
      triangles: cfg.model?.kind === 'object3d' ? null : 2,   // one quad
      drawCalls: 1,
      points: cfg.points,
      spawnCadence: cfg.spawnCadence,
      holdTime: cfg.holdTime,
      light: cfg.targetLight
        ? `#${new THREE.Color(cfg.targetLight.colour ?? cfg.targetLight.color).getHexString()} ` +
          `@${cfg.targetLight.intensity ?? 20}, ${cfg.targetLight.distance ?? 6}m`
        : 'none',
      mechanism: `${cfg.emergeStyle} over ${cfg.emergeSeconds}s, ` +
        `${cfg.retreat}m in -> ${cfg.offset}m out` +
        (cfg.scaleWithTravel ? ', scaling with travel' : ', at constant size'),
    },
  };
}
