/**
 * armode.js — AR / passthrough session coordinator.
 *
 * Listens for XR session start/end and reconfigures the scene so the same
 * single scene serves three experiences without duplication:
 *
 *   VR (Quest, immersive-vr) — arena void: environment shown, weapon on hand.
 *   Quest AR (immersive-ar)  — real room: environment hidden, passthrough shows
 *                              through, weapon stays on the controller.
 *   Handheld AR (Android)    — magic-window: environment hidden, weapon hidden,
 *                              crosshair shown via dom-overlay, forward-arc spawn.
 *
 * Mode is detected by capability, not user-agent:
 *   - AR vs VR        → session.environmentBlendMode !== 'opaque' means passthrough.
 *   - handheld vs headset → session.interactionMode === 'screen-space' (phone),
 *                           or dom-overlay being enabled.
 *
 * Public API:
 *   setupARMode({ renderer, scene, environment, weapon, setSpawnMode })
 *   isHandheldAR()  — true while in a handheld AR session (read by xr.js for aim)
 */

import { setScoreHidden } from './hud.js';

let _handheldAR = false;
export function isHandheldAR() { return _handheldAR; }

/**
 * A2: keep the DOM score in step with handheld AR.
 *
 * In phone AR the score is already drawn in-world by vrui.js (it shows the
 * sprite whenever a session is presenting), so the top-left DOM score is a
 * duplicate. This declares the reason; hud.js's arbiter owns the property and
 * ORs it with competition.js's match reason, so a match ending mid-AR-session
 * cannot un-hide it. Called on EVERY transition, including the ones that set
 * _handheldAR back to false, so the reason is never left stale.
 */
function syncScoreVisibility() {
  setScoreHidden('handheldAR', _handheldAR);
}

export function setupARMode({ renderer, scene, environment, weapon, setSpawnMode }) {
  // Remember the original VR-world look so we can restore it after AR.
  const originalBackground = scene.background;
  const originalFog        = scene.fog;

  renderer.xr.addEventListener('sessionstart', () => {
    const session = renderer.xr.getSession();
    if (!session) return;

    // environmentBlendMode is 'opaque' for VR, 'alpha-blend'/'additive' for AR.
    const blend = session.environmentBlendMode;
    const isAR  = blend && blend !== 'opaque';

    if (!isAR) {
      // ── Immersive VR (arena) ── keep the fake world, weapon on hand.
      _handheldAR = false;
      syncScoreVisibility();
      scene.background = originalBackground;
      scene.fog        = originalFog;
      environment.visible = true;
      weapon.setHidden(false);
      setSpawnMode('vr');
      return;
    }

    // ── AR (passthrough) ── strip the fake world so the room shows through.
    // background = null and fog = null are essential: anything else paints
    // over the camera feed and you'd see black instead of your room.
    scene.background = null;
    scene.fog        = null;
    environment.visible = false; // hides walls, radar floor, ceiling ring as one

    // Handheld (phone) vs headset (Quest). interactionMode is the cleanest
    // signal; fall back to dom-overlay being enabled. UNTESTED — verify which
    // branch each device actually takes tomorrow (Quest should be headset,
    // Android should be handheld).
    const enabled = session.enabledFeatures || [];
    _handheldAR =
      session.interactionMode === 'screen-space' || enabled.includes('dom-overlay');
    syncScoreVisibility();

    if (_handheldAR) {
      // Phone: no hand to hold the gun; rely on the dom-overlay crosshair.
      weapon.setHidden(true);
      setSpawnMode('handheld-ar');
    } else {
      // Quest passthrough: keep the blaster on the controller.
      weapon.setHidden(false);
      setSpawnMode('quest-ar');
    }
  });

  renderer.xr.addEventListener('sessionend', () => {
    // Restore the flat / VR world for the fallback experiences.
    _handheldAR = false;
    syncScoreVisibility();
    scene.background = originalBackground;
    scene.fog        = originalFog;
    environment.visible = true;
    weapon.setHidden(false);
    setSpawnMode('vr');
  });
}
