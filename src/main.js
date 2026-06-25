import * as THREE from 'three';
import { createScene } from './scene.js';
import { setupXR } from './xr.js';
import { buildArena } from './arena.js';
import { spawnTargets, updateTargets } from './targets.js';
import { createHUD, updateRapidFireHUD } from './hud.js';
import { setupInput } from './input.js';
import { setupShooter } from './shoot.js';
import { setupMovement } from './movement.js';
import { setupWeapon } from './weapon.js';
import { setupARMode } from './armode.js';
import { setSpawnMode } from './targets.js';
import { setupModeSwitcher } from './modeswitcher.js';
import { updateUpgrade } from './upgrade.js';
import { setupVrUI } from './vrui.js';
import { setupCoopHud, setCoopMode } from './net/coop-hud.js';
import { setupPeerAvatars } from './net/peer-avatars.js';
import { setupPosePublisher } from './net/pose-publisher.js';
import { tickTransport } from './net/room.js';
import { setupMockDevPanel } from './net/mock-dev-panel.js';

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const { renderer, scene, camera, environment } = createScene();

// DEV: expose renderer/scene/camera so javascript_tool can render on demand
// even when the tab is backgrounded and Three.js's rAF loop is suspended.
if (import.meta.env.DEV) {
  window.__R3 = { renderer, scene, camera };
}

// The first-person blaster. Captured as an object so armode can hide it on phone AR.
const weapon = setupWeapon(camera, renderer);

// In-world VR ACTIVATE panel. Set up before setupXR so its select handler can be
// given to the controllers (it takes precedence over shooting when pointed at).
const vrui = setupVrUI(scene, camera, renderer);

// setupShooter must come before setupXR because setupXR needs shootFromRay.
// weapon.flashMuzzle is the onFire callback — triggers the muzzle flash on each shot.
const { onShoot, shootFromRay, updateBursts } = setupShooter(camera, scene, weapon.flashMuzzle);

// setupXR receives:
//   renderer            — so xr.getController() and the XR camera work
//   scene               — so controller Groups are added to the scene graph
//   shootFromRay        — controller/handheld trigger → hit logic
//   vrui.handleControllerSelect — VR controller pointing at the ACTIVATE panel
//                                 activates a charge instead of firing
const { updateControllers } = setupXR(renderer, scene, shootFromRay, vrui.handleControllerSelect);

// Walls + ceiling ring go into the environment group (with the radar floor) so
// AR mode can hide the whole fake world at once.
buildArena(environment);
spawnTargets(scene);
createHUD(onShoot); // onShoot lets the on-screen SHOOT button fire through the crosshair

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

// Peer avatar renderer. Accepts poses from room.js and draws head + hand markers.
const { updatePeers } = setupPeerAvatars(scene);

// Local pose publisher — throttled to ~15 Hz over the lossy channel.
const publishPose = setupPosePublisher(renderer, camera, modeCtrl);

// Dev panel (only renders in mock/bc transport; no-op for LiveKit).
setupMockDevPanel();

// Wire mouse click and touch tap → onShoot (flat / non-VR mode).
// In VR mode, xr.js handles shooting via selectstart on the controllers.
setupInput(onShoot, renderer);

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

// ─── Animation loop ───────────────────────────────────────────────────────────
// setAnimationLoop is XR-aware: on desktop it acts like rAF; in VR it's driven
// by the headset refresh (72–120 Hz) and receives an XRFrame as the second arg.
renderer.setAnimationLoop(function animate() {
  const delta   = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  updateMovement(delta);  // rotate camera from mouse/keys/gyro/joystick
  (renderer.xr.isPresenting ? renderer.xr.getCamera() : camera).getWorldPosition(_playerPos);
  updateTargets(elapsed, _playerPos); // coins follow the player in AR (drift-proof)
  updateBursts(delta);
  weapon.updateWeapon(delta); // fade the muzzle flash
  updateControllers();    // refresh controller ray lines each frame
  updateUpgrade(delta);   // tick the rapid-fire countdown
  updateRapidFireHUD();   // refresh countdown + upgrade button state
  vrui.updateVrUI();      // head-lock + show/hide the in-world ACTIVATE panel
  tickTransport();        // flush mock/bc impairment queues
  updatePeers(delta);     // interpolate peer avatar positions
  publishPose(delta);     // broadcast local pose ~15 Hz

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
