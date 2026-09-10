/**
 * atmosphere.js — who owns scene.background, scene.fog and the base light level.
 *
 * ── THE PARKED QUESTION, ANSWERED ───────────────────────────────────────────
 * Skins were told not to touch scene.background or scene.fog, and the reason was
 * real: armode.js captured both AT STARTUP and restored those captured values on
 * sessionend. A skin that set its own fog would have it silently reverted to the
 * boot fog by one AR round-trip — and worse, the skin would have no idea, so the
 * arena would come back out of passthrough looking wrong until the next switch.
 *
 * The fix is not "capture harder", it is to name an owner. This module is it.
 * Three actors want a say and they are ranked, not merged:
 *
 *   BOOT     scene.js's near-black background, Fog(10,40), ambient + sun.
 *            Captured once, and it is what "no skin has an opinion" means.
 *   SKIN     a skin may declare an atmosphere while it is active, and clears it
 *            on teardown. Exactly one skin is active, so there is no stack.
 *   AR       passthrough must see the room: background and fog go to null for
 *            the duration, whatever anyone else wanted, and the base lights are
 *            left alone (they light the gun, which is still drawn).
 *
 * AR is a SUPPRESSION, not a write: it does not overwrite what the skin asked
 * for, it just stops it painting. So leaving passthrough re-applies whatever is
 * current — the skin's atmosphere if a skin still has one, the boot values if
 * not — and a skin switch DURING an AR session lands correctly on exit too.
 * That is the property the old capture-and-restore could not have.
 *
 * ── WHY THE BASE LIGHTS ARE HERE TOO ────────────────────────────────────────
 * scene.js adds a white directional "sun" at full strength and a blue ambient.
 * They are scene-level, so a skin cannot scope around them: a horror arena that
 * adds its own low-key rig still gets flat white light from above-left across
 * every surface, and the mood dies. Dimming them is the same KIND of problem as
 * the fog — shared scene state that belongs to whoever is on screen — so it is
 * solved in the same place rather than with a second, different mechanism.
 * Skins that say nothing keep the boot lighting exactly.
 */

let _scene = null;
let _boot = null;        // the startup look — the floor everything falls back to
let _desired = null;     // what SHOULD be painting: a skin's, or _boot
let _suppressed = false; // true while passthrough owns the frame
let _owner = null;       // id of the skin holding an atmosphere, for diagnostics

/**
 * Called once from main.js, after scene.js has built the scene and BEFORE
 * setupARMode, so the boot look is captured before anything can change it.
 * @param {THREE.Scene} scene
 * @param {{ambient?:THREE.Light, sun?:THREE.Light}} baseLights
 */
export function setupAtmosphere(scene, baseLights = {}) {
  _scene = scene;
  _boot = {
    background: scene.background,
    fog: scene.fog,
    lights: {
      ambient: baseLights.ambient || null,
      sun: baseLights.sun || null,
      ambientIntensity: baseLights.ambient?.intensity ?? null,
      sunIntensity: baseLights.sun?.intensity ?? null,
    },
  };
  _desired = null;
  apply();
}

/**
 * A skin declares its atmosphere. Applied immediately unless AR is suppressing,
 * in which case it lands the moment passthrough ends.
 *
 * @param {string} owner              skin id, for diagnostics
 * @param {object} atmosphere
 * @param {THREE.Color|null} [atmosphere.background]
 * @param {THREE.Fog|null} [atmosphere.fog]
 * @param {number} [atmosphere.ambientScale]  multiplier on the boot ambient
 * @param {number} [atmosphere.sunScale]      multiplier on the boot sun
 */
export function setAtmosphere(owner, atmosphere) {
  if (!_scene) return;
  _owner = owner;
  _desired = atmosphere;
  apply();
}

/** A skin gives its atmosphere back. Anyone else's is untouched. */
export function clearAtmosphere(owner) {
  if (!_scene || (_owner && owner && _owner !== owner)) return;
  _owner = null;
  _desired = null;
  apply();
}

/** AR passthrough: stop painting the fake world. Nobody's intent is lost. */
export function suppressAtmosphere() { _suppressed = true; apply(); }

/** Passthrough is over: paint whatever is current now. */
export function restoreAtmosphere() { _suppressed = false; apply(); }

/** @returns {{owner:string|null, suppressed:boolean, hasSkinAtmosphere:boolean}} */
export function getAtmosphereState() {
  return { owner: _owner, suppressed: _suppressed, hasSkinAtmosphere: !!_desired };
}

function apply() {
  if (!_scene || !_boot) return;

  if (_suppressed) {
    // background = null and fog = null are essential: anything else paints over
    // the camera feed and the player sees black instead of their room.
    _scene.background = null;
    _scene.fog = null;
    setLightScale(1, 1);   // the gun is still drawn in AR; light it normally
    return;
  }

  const a = _desired;
  _scene.background = a && 'background' in a ? a.background : _boot.background;
  _scene.fog        = a && 'fog' in a        ? a.fog        : _boot.fog;
  setLightScale(a?.ambientScale ?? 1, a?.sunScale ?? 1);
}

function setLightScale(ambientScale, sunScale) {
  const l = _boot.lights;
  if (l.ambient && l.ambientIntensity !== null) l.ambient.intensity = l.ambientIntensity * ambientScale;
  if (l.sun && l.sunIntensity !== null)         l.sun.intensity     = l.sunIntensity * sunScale;
}
