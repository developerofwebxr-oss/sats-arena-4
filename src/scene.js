import * as THREE from 'three';

/**
 * createScene() sets up and returns everything the renderer needs:
 * the WebGLRenderer, the Scene, and the Camera.
 *
 * Kept in its own module so main.js stays thin and other modules
 * (targets, input, xr) can import { scene, camera } without circular deps.
 */
// The visible viewport. visualViewport excludes mobile browser chrome and is the
// only value that is correct during the cold-load settle; innerWidth/Height are
// the fallback for browsers without it.
function viewportW() { return Math.round(window.visualViewport?.width  ?? window.innerWidth); }
function viewportH() { return Math.round(window.visualViewport?.height ?? window.innerHeight); }

export function createScene() {
  // ─── Renderer ────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({
    antialias: false, // off for Quest 3 perf — the resolution is high enough without it
    alpha: false,     // we own the whole canvas, no need for transparency
  });

  // Cap pixel ratio to 1.5 — Quest 3 native DPR can be ~1.75+, which kills GPU perf.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(viewportW(), viewportH());

  // THREE must drive the loop via setAnimationLoop (not rAF) for WebXR to work.
  // We set the callback in main.js after everything is ready.
  renderer.xr.enabled = true;

  document.body.appendChild(renderer.domElement);

  // ─── Scene ───────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050508); // near-black with a hint of blue

  // Subtle fog gives depth without any expensive effects.
  scene.fog = new THREE.Fog(0x050508, 10, 40);

  // ─── Lighting ────────────────────────────────────────────────────────────
  // Ambient: low-level fill so nothing is pitch black.
  const ambient = new THREE.AmbientLight(0x111122, 1.5);
  scene.add(ambient);

  // One directional light from above-left — cheap, no shadow map.
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(5, 10, 5);
  scene.add(sun);

  // ─── Camera ──────────────────────────────────────────────────────────────
  // In WebXR the headset overrides this camera's matrices, but it's still
  // used for the flat desktop view.
  const camera = new THREE.PerspectiveCamera(
    70,                                      // FOV
    viewportW() / viewportH(),  // aspect
    0.1,                                     // near clip
    100                                      // far clip
  );
  camera.position.set(0, 1.6, 0); // standing eye height in metres
  // Initial pitch (-0.2 tilt) is now set in movement.js so it owns all rotation state.

  // ─── Radar floor ─────────────────────────────────────────────────────────
  // A single canvas texture painted with concentric neon rings, mapped onto
  // one flat plane. Replaces the old grid+floor (was 2 draw calls, now 1).
  // MeshBasicMaterial = unlit, so the rings glow at full brightness regardless
  // of scene lighting — same reasoning as the targets.
  const floorGeo = new THREE.PlaneGeometry(30, 30);
  const floorMat = new THREE.MeshBasicMaterial({
    map: createRadarTexture(),
    transparent: true, // let the faded edges blend into the dark environment
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.name = 'BaseRadarFloor'; // named so a skin with its own floor can hide it
  floor.rotation.x = -Math.PI / 2; // lay flat

  // ─── Environment group ─────────────────────────────────────────────────────
  // Everything that represents the fake VR world (floor here, walls + ceiling
  // added later by buildArena) goes in one group so AR mode can hide it all at
  // once with environment.visible = false, letting passthrough show through.
  const environment = new THREE.Group();
  environment.add(floor);
  scene.add(environment);

  // ─── Camera laser ray (desktop + mobile only) ────────────────────────────
  // A thin line extending 8m forward from the camera along local -Z.
  // Attached as a child of the camera so it always points where the player aims.
  // Hidden automatically when a VR session starts (headset has its own controller rays).
  const laserGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0,  0,  -0.5),  // start slightly in front of the camera lens
    new THREE.Vector3(0,  0,  -8),    // extend 8m forward
  ]);
  const laserMat = new THREE.LineBasicMaterial({
    color: 0xf7931a,
    transparent: true,
    opacity: 0.5,
  });
  const cameraLaser = new THREE.Line(laserGeo, laserMat);
  camera.add(cameraLaser); // child of camera — moves with it, no per-frame update needed

  // Adding the camera to the scene is required when it has children.
  scene.add(camera);

  // Hide the laser while in VR — the controller ray lines take over there.
  renderer.xr.addEventListener('sessionstart', () => { cameraLaser.visible = false; });
  renderer.xr.addEventListener('sessionend',   () => { cameraLaser.visible = true;  });

  // ─── Resize handling ─────────────────────────────────────────────────────
  // ── Viewport sizing ─────────────────────────────────────────────────────────
  // Mobile Safari reports window.innerHeight BEFORE its chrome (URL bar) has
  // settled on a cold load, and CSS 100vh is the LARGE viewport height, so the
  // canvas came up shorter than the visible area and left a black band at the
  // bottom. A reload "fixed" it only because the second load measured a settled
  // viewport. visualViewport is the value that actually describes what the user
  // can see, and it fires its own resize when the chrome collapses — a plain
  // window 'resize' listener does not reliably fire for that.
  function applySize() {
    const w = viewportW(), h = viewportH();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // updateStyle (default) also pins canvas.style in px, which overrides the
    // stylesheet's height and removes the 100vh-vs-innerHeight mismatch.
    renderer.setSize(w, h);
  }

  window.addEventListener('resize', applySize);
  window.addEventListener('orientationchange', () => {
    // Orientation reports the OLD size synchronously; re-measure after layout.
    applySize();
    setTimeout(applySize, 120);
    setTimeout(applySize, 400);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', applySize);
    window.visualViewport.addEventListener('scroll', applySize);
  }

  // Re-measure on the FIRST rendered frame and again after the chrome settles,
  // so the very first load fills edge to edge without needing a reload.
  requestAnimationFrame(applySize);
  setTimeout(applySize, 250);
  setTimeout(applySize, 900);

  return { renderer, scene, camera, environment };
}

// ─── Radar floor texture ─────────────────────────────────────────────────────
// Paints concentric neon rings onto one canvas, drawn once at startup.
// Cyan inner rings → magenta/purple mid rings → faint orange accents, all
// fading toward the edges via a radial alpha mask. Returns a CanvasTexture.
function createRadarTexture() {
  const SIZE = 1024;
  const canvas = document.createElement('canvas');
  canvas.width  = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');

  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const maxR = SIZE / 2;

  // Dark base — blends into the near-black environment at the edges.
  ctx.fillStyle = '#050508';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Ring palette, from center outward. Cyan core, magenta mids, orange accents.
  const RING_COUNT = 8;
  const colors = [
    '#00e5ff', // cyan
    '#00e5ff',
    '#b14bff', // magenta/purple
    '#f7931a', // orange accent (ties back to targets)
    '#b14bff',
    '#00e5ff',
    '#b14bff',
    '#f7931a', // outer orange accent
  ];

  // Draw each ring twice: a wide blurred glow pass, then a thin bright core.
  for (let i = 1; i <= RING_COUNT; i++) {
    const radius = (i / RING_COUNT) * maxR * 0.92; // leave a margin before the edge
    const color  = colors[i - 1];

    // Glow pass — wide, faint, blurred.
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 10;
    ctx.globalAlpha = 0.18;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 24;
    ctx.stroke();

    // Bright core line on top.
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.lineWidth   = 2.5;
    ctx.globalAlpha = 0.9;
    ctx.shadowBlur  = 8;
    ctx.stroke();
  }

  // Radar sweep lines (N/S/E/W) — faint cyan, reinforces the radar feel.
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth   = 2;
  ctx.shadowBlur  = 6;
  ctx.beginPath();
  ctx.moveTo(cx, cy - maxR * 0.85); ctx.lineTo(cx, cy + maxR * 0.85);
  ctx.moveTo(cx - maxR * 0.85, cy); ctx.lineTo(cx + maxR * 0.85, cy);
  ctx.stroke();

  // Center core dot — bright cyan where the player stands.
  ctx.globalAlpha = 1;
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur  = 30;
  ctx.fillStyle   = '#00e5ff';
  ctx.beginPath();
  ctx.arc(cx, cy, 8, 0, Math.PI * 2);
  ctx.fill();

  // Reset shadow before the fade mask so the mask itself isn't blurred.
  ctx.shadowBlur  = 0;
  ctx.globalAlpha = 1;

  // Radial alpha fade — punch a transparent gradient over everything so the
  // rings glow at center and fade to nothing at the edges.
  // 'destination-in' keeps existing pixels only where the gradient is opaque.
  const fade = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
  fade.addColorStop(0.0, 'rgba(0,0,0,1)');   // fully keep center
  fade.addColorStop(0.65, 'rgba(0,0,0,1)');  // hold most of the radius
  fade.addColorStop(1.0, 'rgba(0,0,0,0)');   // fade out at the edge
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.globalCompositeOperation = 'source-over';

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}
