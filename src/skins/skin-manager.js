import { Group } from 'three';
import { getSkin, DEFAULT_SKIN_ID } from './registry.js';
import { applyTheme } from '../theme.js';
import { applyTint, restoreTint, restoreAllTints } from './appearance.js';

/**
 * skin-manager.js — the active-skin slot.
 *
 * ONE skin is active at a time. Everything a skin spawns lives under a single
 * NAMED group ("skin:<id>") parented to the scene's `environment` group.
 *
 * Why a child of `environment` and not of the scene: armode.js hides the whole
 * fake world in AR passthrough with `environment.visible = false`. Parenting the
 * skin group there keeps that working untouched — one flag still hides
 * everything — while still letting the skin be torn down independently.
 *
 * WHAT A SKIN HIDES IS DECLARED, NOT WRITTEN.
 * A skin never reaches into the shared scene or into a cached asset to turn
 * something off. It DECLARES a `hides` block (see registry.js) and applyHides()
 * below is the only code that writes .visible for it — at build, again when a
 * skin's asset finishes loading late, and undone in teardown(). That is the
 * double-writer lesson: two places writing one flag is how a hidden thing comes
 * back, or fails to.
 *
 * TEARDOWN IS TOTAL, AND ASSERTED.
 * This is the xr-ballcatch lesson: themed scenery leaked across switches and
 * two themes ended up co-existing. So switching does not "hide" or "reuse" —
 * it removes the group, disposes its geometry/materials, reverts every tint,
 * and then WALKS THE WHOLE SCENE to prove nothing from the old skin survived.
 * A leak throws in dev and console.errors in prod rather than passing silently.
 */

const groupName = (id) => `skin:${id}`;

export function setupSkins({ scene, environment, getGunRoots, getTargetGroup }) {
  let activeId    = null;
  let activeGroup = null;
  let paused      = false;

  // Everything applyHides() turned off, so teardown() can turn it back on.
  // It matters for exactly the objects that OUTLIVE the skin group: the shared
  // radar floor, and a cached arena GLB that is re-parented rather than rebuilt
  // (its meshes survive `keepAlive`, so a hide left on one would follow it).
  let hidden = [];

  /**
   * The ONE writer for skin-declared visibility. Idempotent — safe to re-run
   * whenever more of a skin's scenery has arrived.
   *
   *   hides.baseFloor  hide the shared cyan radar floor (a skin with its own)
   *   hides.materials  hide every mesh in THIS skin's scenery whose material(s)
   *                    are all named here — for a GLB that ships geometry the
   *                    game should not draw.
   */
  function applyHides(skin, group) {
    const h = skin.hides || {};

    const baseFloor = scene.getObjectByName('BaseRadarFloor');
    if (h.baseFloor && baseFloor?.visible) {
      baseFloor.visible = false;
      hidden.push(baseFloor);
    }

    const names = h.materials;
    if (!names?.length || !group) return;
    let n = 0;
    group.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      // EVERY material must be named, so a multi-material mesh that is only
      // partly made of the offending stuff is left alone rather than vanished.
      if (!mats.length || !mats.every((m) => m && names.includes(m.name))) return;
      o.visible = false;
      hidden.push(o);
      n++;
    });
    if (n) console.log(`[skins] ${skin.id}: hid ${n} mesh(es) with material ${names.join('/')}`);
  }

  /** Undo every hide this slot made. Called from teardown(), nowhere else. */
  function clearHides() {
    for (const o of hidden) o.visible = true;
    hidden = [];
  }

  // ── Build ───────────────────────────────────────────────────────────────────
  function build(skinId) {
    const skin = getSkin(skinId);
    if (!skin) throw new Error(`[skins] unknown skin "${skinId}"`);

    // P51: the UI follows the skin. Applied FIRST, before any geometry, so the
    // DOM has already restyled by the time the new world appears — a HUD that
    // recolours a frame after the arena does reads as a glitch. This is the ONE
    // place a theme is applied; nothing else in the codebase calls applyTheme.
    applyTheme(skin.ui, skin.id);

    const group = new Group();
    group.name = groupName(skin.id);
    // Tag every descendant so the leak assertion can identify strays by origin
    // even if something re-parents them out of the group.
    group.userData.skinId = skin.id;

    // Handed to the skin so an environment that finishes loading AFTER build()
    // returns can ask for its `hides` to be re-applied, instead of writing
    // visibility itself. The guard makes a late callback from a skin that has
    // already been switched away from a no-op.
    const ctx = { applyHides: () => { if (activeGroup === group) applyHides(skin, group); } };

    skin.environment?.build?.(group, ctx);
    group.traverse((o) => { o.userData.skinId = skin.id; });

    environment.add(group);

    // Objects the skin does NOT own get a reversible tint instead.
    if (skin.gun?.tint != null) {
      for (const root of getGunRoots?.() || []) applyTint(root, skin.gun.tint);
    }
    if (skin.coinType?.tint != null) {
      const tg = getTargetGroup?.();
      if (tg) applyTint(tg, skin.coinType.tint);
    }

    activeGroup = group;
    activeId    = skin.id;

    // Whatever the skin declared, applied once here for everything already in
    // the group. An async environment calls ctx.applyHides() again when the
    // rest of it lands. Always undone in teardown(), so a hide cannot leak into
    // the next skin.
    applyHides(skin, group);
    return group;
  }

  // ── Teardown ────────────────────────────────────────────────────────────────
  function teardown() {
    // Revert borrowed objects (gun/coins) to their shipped materials first.
    const tg = getTargetGroup?.();
    if (tg) restoreTint(tg);
    for (const root of getGunRoots?.() || []) restoreTint(root);
    restoreAllTints(); // belt-and-braces: nothing tinted may survive a switch

    // Put back everything the outgoing skin's `hides` turned off — the next
    // skin re-decides in build().
    clearHides();

    if (activeGroup) {
      activeGroup.parent?.remove(activeGroup);
      disposeTree(activeGroup);
    }
    // Let the outgoing skin drop any per-build handles it kept.
    if (activeId) getSkin(activeId)?.onTeardown?.();

    const goneId = activeId;
    activeGroup = null;
    activeId    = null;
    return goneId;
  }

  /** Recursively dispose geometries and materials so a long session can't grow. */
  function disposeTree(root) {
    // A skin may attach a CACHED asset it does not want destroyed — the arena
    // GLB is parsed once and re-parented on every switch. Detach those first so
    // the dispose walk below never reaches them. They leave the scene either
    // way, so the leak assertion is unaffected; we also clear their skin tag so
    // a stale id can never be mistaken for a leak later.
    const keep = [];
    root.traverse((o) => { if (o.userData?.keepAlive) keep.push(o); });
    for (const k of keep) {
      k.parent?.remove(k);
      k.traverse((o) => { delete o.userData.skinId; });
    }

    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        m.map?.dispose?.();
        m.dispose?.();
      }
    });
    root.clear?.();
  }

  // ── Leak assertion ──────────────────────────────────────────────────────────
  /**
   * Walk the ENTIRE scene and prove nothing tagged with `goneId` survives, and
   * that no group named "skin:<goneId>" is still attached anywhere.
   * Returns a report; also throws in dev so a leak cannot pass a test run.
   */
  function assertNoLeak(goneId, { throwOnLeak = import.meta.env.DEV } = {}) {
    if (!goneId) return { ok: true, strays: 0, named: false, skinId: goneId };

    let strays = 0;
    const sample = [];
    scene.traverse((o) => {
      if (o.userData?.skinId === goneId) {
        strays++;
        if (sample.length < 5) sample.push(o.name || o.type);
      }
    });
    const named = !!scene.getObjectByName(groupName(goneId));

    const report = { ok: strays === 0 && !named, strays, named, sample, skinId: goneId };
    if (!report.ok) {
      const msg = `[skins] LEAK: ${strays} object(s) from "${goneId}" survived teardown`
                + `${named ? ` (group ${groupName(goneId)} still attached)` : ''}`;
      console.error(msg, report);
      if (throwOnLeak) throw new Error(msg);
    }
    return report;
  }

  // ── Public: swap one skin for another, locally ──────────────────────────────
  /**
   * Local half of a switch. Network coordination lives in skin-net.js — this
   * function is deliberately synchronous-ish and side-effect-complete so both
   * the solo path and the networked path share exactly one implementation.
   */
  function applySkinLocal(skinId) {
    if (!getSkin(skinId)) throw new Error(`[skins] unknown skin "${skinId}"`);
    const goneId = teardown();
    const leak   = goneId && goneId !== skinId ? assertNoLeak(goneId) : { ok: true, strays: 0 };
    build(skinId);
    return leak;
  }

  function buildInitial(skinId = DEFAULT_SKIN_ID) {
    if (activeId) return;
    build(skinId);
  }

  return {
    buildInitial,
    applySkinLocal,
    assertNoLeak,
    getActiveSkinId: () => activeId,
    getActiveGroup:  () => activeGroup,
    /**
     * Per-frame tick for the ACTIVE skin's cosmetic animation, if it has any.
     * Purely decorative, so main.js calls it outside the gameplay pause gate —
     * a frozen skyline during a skin switch would look broken, and it cannot
     * affect scoring or the clock.
     */
    updateSkin(dt, elapsed) {
      if (!activeId) return;
      getSkin(activeId)?.update?.(dt, elapsed);
    },
    // Gameplay pause — read by main.js's animation loop and input gates.
    isPaused: () => paused,
    setPaused: (v) => { paused = !!v; },
  };
}
