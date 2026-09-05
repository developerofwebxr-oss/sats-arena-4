import * as THREE from 'three';
import { createScene } from './scene.js';
import { setupXR } from './xr.js';
import { spawnTargets, updateTargets } from './targets.js';
import { createHUD, updateRapidFireHUD } from './hud.js';
import { setupInput } from './input.js';
import { setupShooter } from './shoot.js';
import { setupMovement } from './movement.js';
import { setupWeapon } from './weapon.js';
import { setupARMode } from './armode.js';
import { setSpawnMode, getTargetGroup } from './targets.js';
import { setupModeSwitcher } from './modeswitcher.js';
import { updateUpgrade } from './upgrade.js';
import { setupVrUI } from './vrui.js';
import { setupCoopHud, setCoopMode } from './net/coop-hud.js';
import { setupPeerAvatars } from './net/peer-avatars.js';
import { setupPosePublisher } from './net/pose-publisher.js';
import { tickTransport } from './net/room.js';
import { setupMockDevPanel } from './net/mock-dev-panel.js';
import { setupCompetition, updateCompetition } from './net/competition.js';
import { setupSkins } from './skins/skin-manager.js';
import { setupSkinNet } from './skins/skin-net.js';
import { setupSkinHud, setSwitchOverlay, refreshSkinHud } from './skins/skin-hud.js';

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
  window.__skins = { skins, net: skinNet, scene, stepGameplay: (d = 1 / 60, e = 0) => advanceGameplay(d, e) };
}

// The first-person blaster. Captured as an object so armode can hide it on phone AR.
const weapon = setupWeapon(camera, renderer);

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
let skins = null; // assigned below; the wrappers are only ever called later
const gamePaused      = () => !!skins && skins.isPaused();
const gatedShoot      = (...a) => { if (gamePaused()) return; onShoot(...a); };
const gatedShootFromRay = (...a) => { if (gamePaused()) return; shootFromRay(...a); };

// setupXR receives:
//   renderer            — so xr.getController() and the XR camera work
//   scene               — so controller Groups are added to the scene graph
//   shootFromRay        — controller/handheld trigger → hit logic
//   vrui.handleControllerSelect — VR controller pointing at the ACTIVATE panel
//                                 activates a charge instead of firing
const { updateControllers } = setupXR(renderer, scene, gatedShootFromRay, vrui.handleControllerSelect, weapon.notifyControllerFire);

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
const modeCtrl = setupModeSwitcher(renderer);

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
renderer.setAnimationLoop(function animate() {
  const delta   = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  updateMovement(delta);  // look control stays live so the overlay isn't nauseating
  (renderer.xr.isPresenting ? renderer.xr.getCamera() : camera).getWorldPosition(_playerPos);
  advanceGameplay(delta, elapsed); // frozen as one unit while a skin switch runs
  weapon.updateWeapon(delta); // fade the muzzle flash
  updateControllers();    // refresh controller ray lines each frame
  updateRapidFireHUD();   // refresh countdown + upgrade button state (shows the frozen value)
  vrui.updateVrUI();      // head-lock + show/hide the in-world ACTIVATE panel
  tickTransport();        // flush mock/bc impairment queues
  updatePeers(delta);     // interpolate peer avatar positions
  publishPose(delta);     // broadcast local pose ~15 Hz
  updateCompetition();    // opt-in match: broadcast own score, repaint dual HUD

  renderer.render(scene, camera);
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
