import { Group } from 'three';
import { getSkin, DEFAULT_SKIN_ID } from './registry.js';
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

  // ── Build ───────────────────────────────────────────────────────────────────
  function build(skinId) {
    const skin = getSkin(skinId);
    if (!skin) throw new Error(`[skins] unknown skin "${skinId}"`);

    const group = new Group();
    group.name = groupName(skin.id);
    // Tag every descendant so the leak assertion can identify strays by origin
    // even if something re-parents them out of the group.
    group.userData.skinId = skin.id;

    skin.environment?.build?.(group);
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

    // A skin whose environment supplies its own floor hides the shared radar
    // floor; anything else leaves it exactly as shipped. Always restored in
    // teardown() so this can never leak into the next skin.
    const baseFloor = scene.getObjectByName('BaseRadarFloor');
    if (baseFloor) baseFloor.visible = !skin.hidesBaseFloor;

    activeGroup = group;
    activeId    = skin.id;
    return group;
  }

  // ── Teardown ────────────────────────────────────────────────────────────────
  function teardown() {
    // Revert borrowed objects (gun/coins) to their shipped materials first.
    const tg = getTargetGroup?.();
    if (tg) restoreTint(tg);
    for (const root of getGunRoots?.() || []) restoreTint(root);
    restoreAllTints(); // belt-and-braces: nothing tinted may survive a switch

    // Restore the shared radar floor — the next skin re-decides in build().
    const baseFloor = scene.getObjectByName('BaseRadarFloor');
    if (baseFloor) baseFloor.visible = true;

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
