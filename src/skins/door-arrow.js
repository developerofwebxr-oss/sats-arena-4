import * as THREE from 'three';

/**
 * door-arrow.js — "it's behind you": point the player at the open door.
 *
 * The Satoshi target appears on ONE of 42 doors ringing the arena, holds for
 * seven seconds, and retracts. A player facing the wrong way never learns it
 * existed. This closes that gap in the two modes where it can.
 *
 * ── EVENT-DRIVEN, NOT POLLED ───────────────────────────────────────────────
 * It subscribes to the door-target's OWN lifecycle. There is no second copy of
 * the spawn logic, no cadence timer here, and no scanning of door state — this
 * module cannot disagree with P42b about what is happening, because it is only
 * ever told. `setTarget(pose)` and `clearTarget()` are the whole interface.
 *
 * ── FLAT / MOBILE: a DOM marker ────────────────────────────────────────────
 * Project the door's world position with camera.project(). Two cases:
 *   ON SCREEN  — a small ring drawn at the projected point.
 *   OFF SCREEN — clamp to the viewport edge and rotate an arrow to point at it.
 * The trap is that projection is only valid IN FRONT of the camera. Behind it,
 * the projected point flips through the origin and a naive clamp sends the arrow
 * to the exact opposite edge — confidently pointing away from the target. So the
 * sign is corrected explicitly from the camera-space Z. See project() below.
 *
 * ── VR: a 3D arrow parented to the CAMERA ──────────────────────────────────
 * A DOM overlay does not exist in a headset, and a world-space marker at the
 * door would be just as easy to miss as the door. So the arrow is a CHILD OF THE
 * CAMERA, sitting slightly below and ahead of the eye line, and it YAWS to point
 * at the door. Parenting to the camera is what makes it render correctly in
 * stereo: it inherits each eye's view matrix rather than being positioned for a
 * single viewpoint, which is how a naive "billboard at a fixed screen offset"
 * breaks in a headset. It is kept small and close to the centre because anything
 * large and head-locked in VR reads as dirt on the lens.
 *
 * ── AR: inactive ───────────────────────────────────────────────────────────
 * The arena and its doors are suppressed in passthrough (armode hides
 * `environment`), so no target ever spawns there and there is nothing to point
 * at. Both surfaces stay hidden.
 *
 * Gold-only: it is driven by the Gold Arena's door target and nothing else calls
 * setTarget().
 *
 * ── COLOUR, and why it is not importing the theme ──────────────────────────
 * P51's token module lives on a different branch; this one descends from the
 * door work. So the DOM surface reads `var(--ui-glow, <literal>)`: the literal is
 * Classic's bitcoin orange and is what paints today, and the moment P51 merges
 * the variable resolves and the arrow themes with everything else — no edit
 * needed. The 3D arrow takes the same literal as a constant, which is the one
 * line to point at the theme later.
 */

// Classic's bitcoin orange. See the note above: the DOM uses this as a CSS
// fallback and the WebGL arrow as its colour, so both become theme-driven with a
// one-line change once P51 is in the same tree.
const GLOW      = '#f7931a';
const GLOW_INT  = 0xf7931a;
const GLOW_SOFT = 'rgba(247,147,26,0.35)';

// ── Flat marker geometry (CSS px) ────────────────────────────────────────────
const EDGE_PAD   = 46;   // keep the clamped arrow clear of the viewport edge
const MARKER_PX  = 54;   // on-screen ring diameter
const ARROW_PX   = 40;   // off-screen arrow size
const PULSE_HZ   = 1.1;  // gentle — this is a hint, not an alarm

// ── VR arrow placement (metres, camera space; -Z is forward) ─────────────────
// Low and close: at 0.55 m the arrow subtends ~7deg, which is readable without
// occluding the aim point, and it sits below the eye line so it never covers a
// target the player is already shooting at.
const VR_OFFSET  = new THREE.Vector3(0, -0.20, -0.55);
const VR_SCALE   = 0.055;

export function setupDoorArrow({ scene, camera, renderer, isSuppressed }) {

  // ── Flat surface: two DOM elements, styled from the P51 tokens ────────────
  const root = document.createElement('div');
  root.id = 'door-arrow';
  root.style.cssText = `
    position: fixed; inset: 0; z-index: 7500;
    pointer-events: none; display: none;`;

  const marker = document.createElement('div');
  marker.id = 'door-arrow-ring';
  marker.style.cssText = `
    position: absolute; width: ${MARKER_PX}px; height: ${MARKER_PX}px;
    margin-left: ${-MARKER_PX / 2}px; margin-top: ${-MARKER_PX / 2}px;
    border-radius: 50%; box-sizing: border-box;
    border: 2px solid var(--ui-glow, ${GLOW}); box-shadow: 0 0 14px var(--ui-glow-soft, ${GLOW_SOFT});
    display: none;`;

  const arrow = document.createElement('div');
  arrow.id = 'door-arrow-tip';
  // A CSS triangle, so there is no image to load and it recolours with the skin.
  arrow.style.cssText = `
    position: absolute; width: 0; height: 0;
    margin-left: ${-ARROW_PX / 2}px; margin-top: ${-ARROW_PX / 2}px;
    border-left: ${ARROW_PX / 2}px solid transparent;
    border-right: ${ARROW_PX / 2}px solid transparent;
    border-bottom: ${ARROW_PX}px solid var(--ui-glow, ${GLOW});
    filter: drop-shadow(0 0 8px var(--ui-glow-soft, ${GLOW_SOFT}));
    display: none;`;

  const hint = document.createElement('div');
  hint.id = 'door-arrow-hint';
  hint.textContent = '+42';
  hint.style.cssText = `
    position: absolute; transform: translate(-50%, 0);
    font: 700 15px/1 monospace; letter-spacing: .12em;
    color: var(--ui-glow, ${GLOW}); text-shadow: 0 0 10px var(--ui-glow-soft, ${GLOW_SOFT});
    display: none;`;

  root.append(marker, arrow, hint);
  document.body.appendChild(root);

  // ── VR surface: a flat chevron, parented to the camera ────────────────────
  // Drawn as a triangle rather than a loaded asset so it costs one draw call and
  // recolours with the skin like everything else.
  const shape = new THREE.Shape();
  shape.moveTo(0, 1.0); shape.lineTo(-0.62, -0.25); shape.lineTo(0, 0.10);
  shape.lineTo(0.62, -0.25); shape.lineTo(0, 1.0);
  const vrArrow = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({
      color: GLOW_INT, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthTest: false, fog: false, toneMapped: false,
    }),
  );
  vrArrow.name = 'DoorArrowVR';
  vrArrow.renderOrder = 20;     // never occluded by the arena it points through
  vrArrow.scale.setScalar(VR_SCALE);
  vrArrow.position.copy(VR_OFFSET);
  vrArrow.visible = false;
  camera.add(vrArrow);
  // camera is not in the scene graph in every setup; adding it is harmless and
  // guarantees the child is traversed for rendering.
  if (!camera.parent) scene.add(camera);

  // ── State ─────────────────────────────────────────────────────────────────
  let target = null;      // THREE.Vector3 world position of the open door
  let shownHintFor = null;
  let hintUsed = false;   // the "+42" explains itself ONCE, then stops nagging
  let elapsed = 0;

  const _v   = new THREE.Vector3();
  const _cam = new THREE.Vector3();
  const _q   = new THREE.Quaternion();

  /** P42b calls this when a target emerges. */
  function setTarget(worldPos) {
    target = worldPos ? worldPos.clone() : null;
    if (target && !hintUsed) { shownHintFor = target; hintUsed = true; }
  }
  /** ...and this when it retracts, is hit, or is cleared. */
  function clearTarget() { target = null; shownHintFor = null; }

  /**
   * World point -> viewport point, WITH the behind-camera case handled.
   *
   * camera.project() divides by w. For a point behind the camera w is negative,
   * so x and y come back mirrored through the origin — a target directly behind
   * you projects to the centre of the screen, and a naive edge-clamp then points
   * the arrow at precisely the wrong edge. Taking the camera-space Z tells us
   * which side we are on, and the sign is flipped explicitly when it is behind.
   */
  function project(world) {
    _v.copy(world);
    camera.updateMatrixWorld();
    const camSpace = _v.clone().applyMatrix4(
      camera.matrixWorldInverse ?? camera.matrixWorld.clone().invert());
    const behind = camSpace.z > 0;

    _v.copy(world).project(camera);
    let x = _v.x, y = _v.y;
    if (behind) { x = -x; y = -y; }

    return {
      behind,
      // NDC -> CSS px, y flipped because NDC is up-positive and CSS is down-positive.
      px: (x * 0.5 + 0.5) * window.innerWidth,
      py: (-y * 0.5 + 0.5) * window.innerHeight,
      ndc: { x, y },
      onScreen: !behind && Math.abs(x) <= 1 && Math.abs(y) <= 1,
    };
  }

  /**
   * Clamp an off-screen point to the viewport edge and give the arrow's angle.
   *
   * BEHIND YOU, THE ONLY USEFUL INSTRUCTION IS "TURN". The doors sit above eye
   * level, so a target directly behind projects (after the sign correction) well
   * above centre — and clamping to the nearest edge then parks the arrow at the
   * TOP, telling the player to look at the ceiling. Height is not actionable
   * from behind: you cannot pitch your way to a door at your back. So when the
   * target is behind, the vertical component is dropped and the arrow goes to
   * the left or right edge, pointing the way to turn. Exactly 180deg is a real
   * tie — both ways are equally short — and it breaks to the right rather than
   * flickering between the two.
   */
  function clampToEdge(p) {
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    let dx = p.px - cx, dy = p.py - cy;
    if (p.behind) { dy = 0; if (Math.abs(dx) < 1) dx = 1; }
    if (dx === 0 && dy === 0) dy = 1;      // degenerate: pick a direction
    const mx = cx - EDGE_PAD, my = cy - EDGE_PAD;
    // Scale the direction vector until it touches whichever edge it meets first.
    const s = Math.min(mx / Math.abs(dx || 1e-6), my / Math.abs(dy || 1e-6));
    return {
      x: cx + dx * s, y: cy + dy * s,
      // The CSS triangle points UP at rest, so its rotation is offset by 90deg
      // from the direction angle.
      angle: Math.atan2(dy, dx) * 180 / Math.PI + 90,
    };
  }

  function hideFlat() {
    root.style.display = 'none';
    marker.style.display = arrow.style.display = hint.style.display = 'none';
  }

  function update(dt) {
    elapsed += dt;
    const presenting = renderer.xr.isPresenting;
    const off = !target || (isSuppressed && isSuppressed());

    if (off) { hideFlat(); vrArrow.visible = false; return; }

    // Pulse: opacity only. Scaling a head-locked object in VR is a comfort
    // problem, and the same value drives both surfaces so they feel like one
    // thing seen two ways.
    const pulse = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(elapsed * Math.PI * 2 * PULSE_HZ));

    if (presenting) {
      hideFlat();
      // YAW ONLY. The arrow lives in camera space, so it must be rotated by the
      // bearing to the door RELATIVE TO where the head is looking — and only
      // about the head's up axis. Pitching it would tip a head-locked object,
      // which is exactly the kind of motion that makes people ill.
      camera.getWorldPosition(_cam);
      camera.getWorldQuaternion(_q);
      const toDoor = _v.copy(target).sub(_cam);
      // Into the camera's own frame, then flatten.
      toDoor.applyQuaternion(_q.clone().invert());
      const bearing = Math.atan2(toDoor.x, -toDoor.z);   // 0 = dead ahead
      vrArrow.rotation.set(0, 0, -bearing);
      vrArrow.material.opacity = 0.9 * pulse;
      vrArrow.visible = true;
      return;
    }

    vrArrow.visible = false;
    root.style.display = 'block';
    const p = project(target);

    if (p.onScreen) {
      marker.style.display = 'block';
      arrow.style.display = 'none';
      marker.style.left = `${p.px}px`;
      marker.style.top  = `${p.py}px`;
      marker.style.opacity = String(pulse);
      if (shownHintFor) {
        hint.style.display = 'block';
        hint.style.left = `${p.px}px`;
        hint.style.top  = `${p.py + MARKER_PX / 2 + 8}px`;
        hint.style.opacity = String(pulse);
      } else hint.style.display = 'none';
    } else {
      const c = clampToEdge(p);
      marker.style.display = 'none';
      hint.style.display = 'none';
      arrow.style.display = 'block';
      arrow.style.left = `${c.x}px`;
      arrow.style.top  = `${c.y}px`;
      arrow.style.transform = `rotate(${c.angle}deg)`;
      arrow.style.opacity = String(pulse);
    }
  }

  return {
    setTarget, clearTarget, update,
    /** Test surface: what the arrow currently believes and shows. */
    debug: () => {
      if (!target) return { active: false };
      const p = project(target);
      return {
        active: true, presenting: renderer.xr.isPresenting,
        behind: p.behind, onScreen: p.onScreen,
        px: Math.round(p.px), py: Math.round(p.py),
        edge: p.onScreen ? null : (({ x, y, angle }) =>
          ({ x: Math.round(x), y: Math.round(y), angle: Math.round(angle) }))(clampToEdge(p)),
        vrVisible: vrArrow.visible,
        vrYawDeg: Math.round(-vrArrow.rotation.z * 180 / Math.PI),
        hint: hint.style.display === 'block',
      };
    },
    dispose: () => { root.remove(); camera.remove(vrArrow); },
  };
}
