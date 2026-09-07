import * as THREE from 'three';
import { createScene } from './scene.js';
import { setupXR } from './xr.js';
import { spawnTargets, updateTargets } from './targets.js';
import { createHUD, updateRapidFireHUD } from './hud.js';
import { setupInput } from './input.js';
import { setupShooter } from './shoot.js';
import { setupMovement, recenterView } from './movement.js';
import { setupWeapon } from './weapon.js';
import { setupARMode } from './armode.js';
import { setSpawnMode, getTargetGroup } from './targets.js';
import { setupModeSwitcher } from './modeswitcher.js';
import { updateUpgrade } from './upgrade.js';
import { setupVrUI } from './vrui.js';
import { setupVrMenu } from './vr-menu.js';
import {
  setupCoopHud, setCoopMode,
  coopLeave, coopToggleMute, isCoopMuted, isCoopJoined,
  onPendingRequests, approveJoinRequest, denyJoinRequest,
} from './net/coop-hud.js';
import { setupPeerAvatars } from './net/peer-avatars.js';
import { setupPosePublisher } from './net/pose-publisher.js';
import { tickTransport } from './net/room.js';
import { setupMockDevPanel } from './net/mock-dev-panel.js';
import { setupCompetition, updateCompetition, canCompete, proposeCompetition } from './net/competition.js';
import { setupSkins } from './skins/skin-manager.js';
import { setupSkinNet } from './skins/skin-net.js';
import { setupSkinHud, setSwitchOverlay, refreshSkinHud } from './skins/skin-hud.js';
import { loadArena, onArenaReady, getArenaState, setArenaRenderContext } from './skins/arena-glb.js';

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const { renderer, scene, camera, environment } = createScene();

// DEV: expose renderer/scene/camera so javascript_tool can render on demand
// even when the tab is backgrounded and Three.js's rAF loop is suspended.
if (import.meta.env.DEV) {
  window.__R3 = { renderer, scene, camera };
}

// DEV: skin switching + the leak assertion, drivable from a test harness.
// Assigned after setup below.
function _exposeSkinDev(skins, skinNet) {
  if (!import.meta.env.DEV) return;
  // stepGameplay is the REAL guarded tick, so a headless test exercises the same
  // code path the animation loop does (rAF is suspended when the tab is hidden).
  window.__skins = {
    skins, net: skinNet, scene, renderer,
    stepGameplay: (d = 1 / 60, e = 0) => advanceGameplay(d, e),
    arena: () => getArenaState(),
  };
}

// The first-person blaster. Captured as an object so armode can hide it on phone AR.
const weapon = setupWeapon(camera, renderer);

// DEV: drive the weapon's per-frame update deterministically. rAF is suspended
// whenever the preview pane is hidden, which otherwise makes the sponsor swap
// (which rides updateWeapon) untestable headlessly.
if (import.meta.env.DEV) window.__weapon = weapon;

// In-world VR ACTIVATE panel. Set up before setupXR so its select handler can be
// given to the controllers (it takes precedence over shooting when pointed at).
const vrui = setupVrUI(scene, camera, renderer);

// setupShooter must come before setupXR because setupXR needs shootFromRay.
// weapon.flashMuzzle is the onFire callback — triggers the muzzle flash on each shot.
const { onShoot, shootFromRay, updateBursts, spawnPeerShot, spawnLightning } = setupShooter(camera, scene, weapon.flashMuzzle);

// Skin switching pauses gameplay on BOTH players. These wrappers swallow input
// for the duration so nobody can score through the "Switching skin…" overlay.
// Gating happens HERE, at the wiring seam — shoot.js / input.js / xr.js are
// untouched, so the shooting path itself is exactly as confirmed.
let skins    = null; // assigned below; the wrappers are only ever called later
let xrApi    = null; // setupXR's return, read late by the menu's getControllers
let modeCtrl = null; // setupModeSwitcher's return, read late by exitToScreen
const gamePaused      = () => !!skins && skins.isPaused();
const gatedShoot      = (...a) => { if (gamePaused()) return; onShoot(...a); };
const gatedShootFromRay = (...a) => { if (gamePaused()) return; shootFromRay(...a); };

// In-world VR/AR menu (X on the left controller). Every item delegates to an
// existing handler. It needs the controllers that setupXR creates, and the mode
// controller built further down, so both are bound late through getters — the
// menu only ever reads them at runtime, never during construction.
const vrMenu = setupVrMenu(scene, renderer, {
  recenterView,                                  // movement.js  — DOM RECENTER action
  coopLeave,                                     // coop-hud.js  — DOM LEAVE button
  coopToggleMute,                                // coop-hud.js  — DOM MUTE button
  isCoopMuted,
  isCoopJoined,
  canCompete,                                    // competition.js — #cmp-compete enablement
  proposeCompetition,                            // competition.js — propose() handshake
  exitToScreen: () => modeCtrl && modeCtrl.exitToScreen(), // modeswitcher.js
  onPendingRequests,                             // coop-hud.js  — knock polling mirror
  approveJoinRequest,                            // coop-hud.js  — DOM ✓ on a knock card
  denyJoinRequest,                               // coop-hud.js  — DOM ✗ on a knock card
  getControllers: () => (xrApi ? xrApi.getControllers() : []),
});

// In-world UI select chain, in priority order. Each handler returns true when it
// consumed the trigger, which suppresses the shot in xr.js. The menu comes first:
// while it's open it consumes EVERY tracked-controller trigger, so the gun can't
// fire underneath it; once closed it returns false immediately and firing is
// restored with no residual state. This SUBSUMES the ACTIVATE-panel handler —
// vrui.handleControllerSelect is the fallback inside inWorldSelect.
function inWorldSelect(origin, direction) {
  if (vrMenu.handleControllerSelect(origin, direction)) return true;
  return vrui.handleControllerSelect(origin, direction);
}

// MERGE NOTE (skins + VR menu): both branches modified this one call. Composed —
//   arg3 gatedShootFromRay  the skins pause gate (skins branch)
//   arg4 inWorldSelect      menu, falling through to the ACTIVATE panel (menu branch)
//   arg6 vrMenu.toggleMenu  X on the LEFT controller opens/closes the menu
// The menu is deliberately NOT pause-gated: stranding a headset user mid-switch
// is worse than letting them open a menu behind a ~1s overlay.
xrApi = setupXR(renderer, scene, gatedShootFromRay, inWorldSelect, weapon.notifyControllerFire, vrMenu.toggleMenu);
const { updateControllers } = xrApi;

// ── Skins ────────────────────────────────────────────────────────────────────
// The arena is no longer built directly here: it is the "classic" skin's
// environment, built into a named group under `environment` so it can be torn
// down on a switch. classic calls the SAME buildArena() with the same geometry,
// so the shipped look is unchanged.
skins = setupSkins({
  scene,
  environment,                              // AR still hides everything via this group
  getGunRoots:    () => weapon.getGunRoots(),
  getTargetGroup: () => getTargetGroup(),
});
skins.buildInitial();                       // classic

spawnTargets(scene);
createHUD(gatedShoot); // on-screen SHOOT button fires through the crosshair

// AR coordinator — reconfigures the scene on AR session start/end.
setupARMode({ renderer, scene, environment, weapon, setSpawnMode });

// Unified SCREEN / VR / AR mode switcher (replaces the separate VR/AR buttons).
// Returns the mode controller; a future in-world 3D switcher can reuse its
// enterVR / enterAR / exitToScreen methods.
modeCtrl = setupModeSwitcher(renderer);

// Keep the co-op module aware of the current XR mode so it publishes the right
// pose joints (VR: head+2 hands; flat/AR: head+aim marker).
modeCtrl.subscribe((state) => setCoopMode(state.activeMode));

// Co-op HUD (bottom-left toggle panel — join by numeric code).
setupCoopHud();

// Opt-in competition mode (4:20 race). Inert until both players agree; free
// endless co-op stays the default. Must come after setupCoopHud so its Compete
// control can mount inside the co-op panel.
setupCompetition();

// Host-authoritative shared switching + the both-ready synced pause. Must come
// after setupCoopHud (host identity) and setupCompetition (the match lock).
const skinNet = setupSkinNet({
  skins,
  onPauseChange: (on, name) => setSwitchOverlay(on, name),
});
setupSkinHud({ skins, net: skinNet });
_exposeSkinDev(skins, skinNet);

// Preload the Gold Arena environment at boot so a switch stays instant and the
// both-ready handshake never has to wait on a 7 MB download. The picker shows
// the row as LOADING… until this resolves, then re-renders.
// NOTE ON AR: no XR listener is registered here on purpose. The skin group is a
// child of `environment`, which armode.js already hides wholesale in passthrough
// (environment.visible = false), so the arena shell is suppressed for free. A
// second writer to the same visibility would be the exact bug pattern to avoid;
// arena-glb.js exposes setArenaShellVisible() for finer control if props are
// ever added that SHOULD stay visible in AR.
// LOADING ARCHITECTURE — init must NEVER wait on environment assets.
// The default skin is CLASSIC, which needs no arena at all, so downloading the
// arena during init spent the player's first seconds (and, on cellular, tens of
// seconds) on content they had not asked for. It now starts only AFTER the game
// is interactive, on an idle callback, so the mode switcher, motion-permission
// button, shooting and co-op controls are all live first. The skin picker also
// calls loadArena() on demand, so picking GOLD ARENA never has to wait for idle.
const _afterInteractive = (fn) => (typeof requestIdleCallback === 'function'
  ? requestIdleCallback(fn, { timeout: 3000 })
  : setTimeout(fn, 1200));

// Give the arena loader the render context so it can PRE-COMPILE the arena's
// shader programs and upload its textures off the frame that first shows them
// (see warmShaders/warmTextures in arena-glb.js). Without this the whole set is
// compiled synchronously on that one frame — the classic "frozen, then
// everything appears" stall.
setArenaRenderContext({ renderer, scene, camera });

onArenaReady((st) => {
  console.log(`[arena] ready via ${st.source}`, st.diagnostics);
  refreshSkinHud();
});
_afterInteractive(() => loadArena());

// Peer avatar renderer. Accepts poses from room.js and draws head + hand markers.
// onCompositionChange fires whenever the flat-vs-headset mix of peers changes.
// anyFlatPeer = true → at least one peer has no tracked controllers (flat/mobile).
// Headset player drops to right-hand-only on that event (fairness), and gains
// the left gun back the moment the last flat peer leaves.
let _hadFlatPeer = false;
const { updatePeers } = setupPeerAvatars(scene, {
  spawnPeerShot,
  spawnLightning,
  onCompositionChange(anyFlatPeer) {
    refreshSkinHud(); // peer count changed → host/peer dimming may differ
    weapon.setLeftGunActive(!anyFlatPeer);
    if (anyFlatPeer && !_hadFlatPeer) vrui.showFairnessNotice();
    if (!anyFlatPeer && _hadFlatPeer)  vrui.showFairnessRestoreNotice();
    _hadFlatPeer = anyFlatPeer;
  },
});

// Local pose publisher — throttled to ~15 Hz over the lossy channel.
const publishPose = setupPosePublisher(renderer, camera, modeCtrl);

// Dev panel (only renders in mock/bc transport; no-op for LiveKit).
setupMockDevPanel();

// Wire mouse click and touch tap → onShoot (flat / non-VR mode).
// In VR mode, xr.js handles shooting via selectstart on the controllers.
setupInput(gatedShoot, renderer);

// setupMovement owns all camera rotation:
//   desktop  → mouse drag + arrow keys
//   mobile   → gyroscope (with iOS permission flow) or virtual joystick fallback
//   Quest VR → no-op (WebXR head tracking takes over)
const { updateMovement } = setupMovement(camera, renderer);

// ─── Clock ────────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

// Reused each frame: the player's world position, fed to updateTargets so the
// coin group can follow the player in AR. Use the XR camera while presenting
// (its pose is the head/device); the flat camera otherwise.
const _playerPos = new THREE.Vector3();

// ─── Gameplay tick ────────────────────────────────────────────────────────────
// Every call that ADVANCES TIME lives here behind a single guard, so a skin
// switch freezes the world as one unit and nothing can drift out of step.
//
// RAPID-FIRE FREEZE — how it works WITHOUT touching the confirmed timer:
// upgrade.js keeps its remaining seconds in one variable that is only ever
// decremented by updateUpgrade(delta). Simply not calling it freezes the
// countdown exactly where it stands, and it resumes on the next unpaused frame.
// No paid seconds are burned during the swap and nothing is rewound. The
// confirmed behaviour is untouched: grantRapidFire() (P18 shared grant),
// isRapidFire(), the repeatable window (P25) and RAPID_DURATION are not
// modified — upgrade.js has no edits at all. updateRapidFireHUD() keeps running
// outside this guard so the HUD renders the frozen value rather than blanking.
function advanceGameplay(delta, elapsed) {
  if (skins.isPaused()) return;
  updateTargets(elapsed, _playerPos); // coins hold still during the swap
  updateBursts(delta);
  updateUpgrade(delta);              // FROZEN during a switch
}

// ─── Animation loop ───────────────────────────────────────────────────────────
// setAnimationLoop is XR-aware: on desktop it acts like rAF; in VR it's driven
// by the headset refresh (72–120 Hz) and receives an XRFrame as the second arg.
// ── Boot splash dismissal ─────────────────────────────────────────────────────
// index.html paints a pure-CSS splash on the browser's first paint, with no JS
// involved. It is cleared HERE, from inside the render loop, on the first frame
// that has actually been drawn — not on load, not on a timer. Tying it to a real
// frame means it can never uncover a black canvas and claim the game is ready
// before it is, and it stays up for exactly as long as the device needs.
let _firstFrameDone = false;
function clearBootSplash() {
  const el = document.getElementById('boot');
  if (!el) return;
  el.classList.add('done');
  // Remove after the fade so it can never eat a tap.
  setTimeout(() => el.remove(), 500);
  const t = Math.round(performance.now());
  console.log(`[boot] first rendered frame at ${t}ms — splash cleared`);
}

renderer.setAnimationLoop(function animate() {
  const delta   = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  updateMovement(delta);  // look control stays live so the overlay isn't nauseating
  (renderer.xr.isPresenting ? renderer.xr.getCamera() : camera).getWorldPosition(_playerPos);
  advanceGameplay(delta, elapsed); // frozen as one unit while a skin switch runs
  weapon.updateWeapon(delta); // fade the muzzle flash
  updateControllers();    // refresh controller ray lines each frame
  updateRapidFireHUD();   // refresh countdown + upgrade button state (shows the frozen value)
  skins.updateSkin(delta, elapsed); // cosmetic skin animation (Classic's neon void)
  vrui.updateVrUI();      // head-lock + show/hide the in-world ACTIVATE panel
  vrMenu.updateVrMenu();  // in-world menu: laser hover, knock notice/badge, toasts
  tickTransport();        // flush mock/bc impairment queues
  updatePeers(delta);     // interpolate peer avatar positions
  publishPose(delta);     // broadcast local pose ~15 Hz
  updateCompetition();    // opt-in match: broadcast own score, repaint dual HUD

  renderer.render(scene, camera);

  if (!_firstFrameDone) { _firstFrameDone = true; clearBootSplash(); }
});

// DEV: __animateFrame() lets javascript_tool drive one render while the tab is
// backgrounded (Three.js rAF is suspended when document.hidden === true).
if (import.meta.env.DEV) {
  window.__animateFrame = function(dt = 1 / 60) {
    tickTransport();
    updatePeers(dt);
    renderer.render(scene, camera);
  };
}
