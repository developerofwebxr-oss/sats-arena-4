import * as THREE from 'three';
// GLTFLoader/DRACOLoader are import()ed lazily — see _loaders() below. Nothing
// on the path to the first interactive frame needs them.
import gunModelUrl from './assets/sats-arena-better-gun.glb?url';
import sponsorGunUrl from './assets/sponsor-gun.glb?url';
import sponsorLogoRightUrl from './assets/sponsor-logo-right.png?url';
import sponsorLogoLeftUrl from './assets/sponsor-logo-left.png?url';
import { isRapidFire } from './upgrade.js';

/**
 * weapon.js — a fancy Bitcoin-themed first-person blaster loaded from a GLB.
 *
 * Gun units:
 *   cameraGun      — child of camera; active in flat/mobile/AR.
 *   controllerGuns[0,1] — permanently attached to each XR controller from startup;
 *                         shown/hidden via 'connected'/'disconnected' events.
 *
 * Each gun is built by buildGunUnit() so it owns its own flash sprite, its own
 * SpriteMaterial (independent flash state), and its own PointLight pair.
 * The GLB is loaded once; cameraGun gets the raw scene, controller guns get
 * deep clones (shared geometry buffers — cheap).
 *
 * Public API:
 *   setupWeapon(camera, renderer)
 *     → { updateWeapon(delta), flashMuzzle(), notifyControllerFire(i), setLeftGunActive(bool), setHidden(bool) }
 */

// Muzzle flash fades from full to zero over this many seconds.
const FLASH_DURATION = 0.12;

// ── Camera (flat/mobile) placement ───────────────────────────────────────────
const CAMERA_POS        = new THREE.Vector3(0.22, -0.20, -0.55);
const CAMERA_POS_MOBILE = new THREE.Vector3(0.10, -0.20, -0.55);
const CAMERA_EULER      = new THREE.Euler(0.05, -0.08, 0);
const CAMERA_SCALE      = 1.0;

function isMobileView() {
  const q = new URLSearchParams(window.location.search);
  if (q.get('gunmobile') === '1') return true;
  if (q.get('gundesktop') === '1') return false;
  return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
         Math.min(window.innerWidth, window.innerHeight) < 600;
}

// ── Controller gun placement (group parented to controller) ──────────────────
const VR_POS   = new THREE.Vector3(0, -0.02, -0.05);
const VR_EULER = new THREE.Euler(0, 0, 0);
const VR_SCALE = 0.7;

// ── GLB model fit (inside each gun unit) ─────────────────────────────────────
// Barrel runs along +X; MODEL_EULER rotates it to face −Z (forward).
const MODEL_SCALE = 0.50;
const MODEL_POS   = new THREE.Vector3(0, -0.26, 0);
const MODEL_EULER = new THREE.Euler(0, Math.PI / 2, 0);

// ── Sponsor gun (shown during the paid rapid-fire window) ────────────────────
// The sponsor GLB shares the bitcoin gun's ORIENTATION CONTRACT exactly — barrel
// along +X, same pivot convention — verified by rendering both through this
// file's transform chain, so MODEL_EULER / VR_MODEL_EULER / VR_MODEL_EULER_LEFT
// all apply unchanged and the muzzle/lightning origin does not move.
//
// Its bounds differ (1.107 x 0.289 x 0.639 vs 1.152 x 0.204 x 0.571) — a chunkier
// gun — so it gets a per-model scale. Matching the apparent cross-section the
// player sees (Y x Z) gives sqrt((0.204*0.571)/(0.289*0.639)) ~= 0.79.
const SPONSOR_MODEL_SCALE = MODEL_SCALE * 0.79;

// Which side of each gun the sponsor decal sits on, in GROUP space:
// -1 = the face toward the player's centre line, which is the side actually
// visible in first person. Flip a value here if a hand reads wrong on-device.
const DECAL_SIDE_CAMERA = -1;
const DECAL_SIDE_RIGHT  = -1;
const DECAL_SIDE_LEFT   = +1;
const DECAL_HEIGHT_FRAC = 0.20;  // decal height as a fraction of the gun's height
// The grip hangs below the receiver, so the bounding box centre sits lower than
// the flat side panel the logo should live on. Bias up the box instead.
const DECAL_Y_BIAS      = 0.63;  // 0 = box bottom, 1 = box top
const DECAL_LIFT        = 0.006; // metres off the surface, avoids z-fighting

// ── Per-hand VR model orientation ────────────────────────────────────────────
// Lifted from sats-arena/src/weapon.js — same GLB, verified correct on Quest.
// Right: +180° extra yaw so barrel faces forward with trigger under the finger.
// Left: mirrored (negative X scale), so it needs the OPPOSITE sign (plain PI/2).
// Two independent constants — tuning one hand never touches the other.
const VR_MODEL_EULER      = new THREE.Euler(0, Math.PI / 2 + Math.PI, 0); // right (VERIFIED)
const VR_MODEL_EULER_LEFT = new THREE.Euler(0, Math.PI / 2, 0);           // left  (VERIFIED)
const MIRROR_LEFT = true; // negative X scale so the left gun isn't a backwards right gun

// ── Muzzle flash placement ────────────────────────────────────────────────────
const FLASH_POS  = new THREE.Vector3(0, -0.10, -0.36);
const FLASH_SIZE = 0.62;

// ── GLTFLoader (shared, lazily constructed) ──────────────────────────────────
// Built on first use so the ~52 KB of three/addons parse cost lands alongside
// the GLB fetch instead of in front of the player's first frame. The promise is
// memoised, so the gun and the sponsor gun still share ONE loader and ONE Draco
// decoder worker exactly as before.
let _loaderPromise = null;
function _loaders() {
  if (_loaderPromise) return _loaderPromise;
  _loaderPromise = Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/loaders/DRACOLoader.js'),
  ]).then(([{ GLTFLoader }, { DRACOLoader }]) => {
    const gltfLoader  = new GLTFLoader();
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    // Warm the decoder worker while the GLB is still in flight.
    dracoLoader.preload();
    gltfLoader.setDRACOLoader(dracoLoader);
    return gltfLoader;
  });
  return _loaderPromise;
}

// ── Peer-gun clone API ────────────────────────────────────────────────────────
let _gunLoadedResolve;
const _gunLoadedPromise = new Promise((r) => { _gunLoadedResolve = r; });
let _loadedGunScene = null;

export async function cloneGun() {
  await _gunLoadedPromise;
  return _loadedGunScene.clone(true);
}

// ── setupWeapon ───────────────────────────────────────────────────────────────
export function setupWeapon(camera, renderer) {

  // Texture created once; each gun unit gets its own SpriteMaterial that shares
  // this texture read-only, so the flash state (opacity, rotation) is independent.
  const flashTex = createMuzzleTexture();

  // ── Gun unit factory ──────────────────────────────────────────────────────
  // Builds one self-contained gun: group + own flash sprite + own light pair.
  // The GLB model is added later via setModel() once loading finishes.
  function buildGunUnit(initialEuler = MODEL_EULER) {
    const group = new THREE.Group();

    // Each gun owns its SpriteMaterial so flash opacity/rotation is independent.
    const flashMat = new THREE.SpriteMaterial({
      map: flashTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    const flash = new THREE.Sprite(flashMat);
    flash.position.copy(FLASH_POS);
    flash.scale.set(FLASH_SIZE, FLASH_SIZE, 1);
    flash.visible = false;
    flash.frustumCulled = false;
    group.add(flash);

    // Own light pair so both guns are individually illuminated.
    const gunKey  = new THREE.PointLight(0xfff2dd, 8, 2, 2);
    gunKey.position.set(0.25, 0.35, 0.2);
    const gunFill = new THREE.PointLight(0x9fd8ff, 4, 2, 2);
    gunFill.position.set(-0.3, 0.0, 0.3);
    group.add(gunKey, gunFill);

    let _model  = null;         // ALWAYS points at the ACTIVE model, so grey +
                                // transform logic below needs no changes.
    let _mirror = false;
    let _euler  = initialEuler;
    let _modelScale = MODEL_SCALE;

    // Sponsor swap state. Both models are preloaded and parented; swapping is a
    // visibility toggle, so there is no hitch when the paid window opens.
    let _bitcoinModel = null;
    let _sponsorModel = null;
    let _sponsorOn    = false;

    // SPONSOR DECAL — deliberately a child of `group`, NOT of the model.
    // The left gun's model is mirrored with a NEGATIVE X scale; anything
    // parented under it inherits that mirror and would render the sponsor's
    // wordmark BACKWARDS. Hanging the decal off the unmirrored group makes a
    // reversed logo structurally impossible on every hand.
    let _decal = null;
    const _invGroup = new THREE.Matrix4(); // reused: world → group space for the decal

    // ── Grey (disabled) state ──────────────────────────────────────────────
    // Captures original material values so restore is exact.
    // setGrey(true/false) can be called before or after setModel — _greyActive
    // is checked in setModel and applied immediately when the model arrives.
    let _greyActive = false;
    const _savedMats = new Map(); // material → { color, emissive, opacity, transparent }
    let _savedKeyI   = 8;  // gunKey.intensity before grey
    let _savedFillI  = 4;  // gunFill.intensity before grey

    function _applyGrey() {
      if (!_model) return;
      _savedKeyI  = gunKey.intensity;
      _savedFillI = gunFill.intensity;
      gunKey.intensity  = 0;
      gunFill.intensity = 0;
      _model.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((mat) => {
          if (!_savedMats.has(mat)) {
            _savedMats.set(mat, {
              color:       mat.color.clone(),
              emissive:    mat.emissive ? mat.emissive.clone() : null,
              opacity:     mat.opacity,
              transparent: mat.transparent,
            });
          }
          mat.color.setRGB(0.45, 0.45, 0.45);
          if (mat.emissive) mat.emissive.set(0x000000);
          mat.opacity     = 0.35;
          mat.transparent = true;
          mat.needsUpdate = true;
        });
      });
    }

    function _restoreGrey() {
      gunKey.intensity  = _savedKeyI;
      gunFill.intensity = _savedFillI;
      _savedMats.forEach((saved, mat) => {
        mat.color.copy(saved.color);
        if (mat.emissive && saved.emissive) mat.emissive.copy(saved.emissive);
        mat.opacity     = saved.opacity;
        mat.transparent = saved.transparent;
        mat.needsUpdate = true;
      });
      _savedMats.clear();
    }

    function setGrey(active) {
      _greyActive = active;
      if (active) _applyGrey(); else _restoreGrey();
    }

    function _applyTransform() {
      if (!_model) return;
      _model.position.copy(MODEL_POS);
      _model.rotation.copy(_euler);
      _model.scale.set(_mirror ? -_modelScale : _modelScale, _modelScale, _modelScale);
    }

    function setModel(m) {
      _model = m;
      _bitcoinModel = m;
      _modelScale = MODEL_SCALE;
      m.traverse((o) => {
        if (!o.isMesh) return;
        o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false;
        // Clone the material so this gun unit owns it independently — safe to mutate
        // for grey state without affecting the camera gun or other controller guns.
        if (o.material) {
          o.material = Array.isArray(o.material)
            ? o.material.map((mat) => mat.clone())
            : o.material.clone();
        }
      });
      _applyTransform();
      group.add(m);
      if (_greyActive) _applyGrey(); // apply pending grey if set before model loaded
    }

    /**
     * Preload this unit's sponsor model + decal. Added hidden; setSponsor()
     * reveals it. Mirrors setModel()'s material-cloning so grey state on the
     * sponsor gun cannot bleed into another unit.
     */
    function setSponsorModel(m, decalTexture, decalSide) {
      _sponsorModel = m;
      m.traverse((o) => {
        if (!o.isMesh) return;
        o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false;
        if (o.material) {
          o.material = Array.isArray(o.material)
            ? o.material.map((mat) => mat.clone())
            : o.material.clone();
        }
      });
      m.visible = false;
      group.add(m);

      if (decalTexture) {
        const mat = new THREE.MeshBasicMaterial({
          map: decalTexture, transparent: true, alphaTest: 0.06,
          depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
        });
        _decal = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        _decal.name = 'SponsorDecal';
        _decal.frustumCulled = false;
        _decal.visible = false;
        _decal.userData.side = decalSide;
        group.add(_decal);   // NOT group.add via the model — never mirrored
      }
      _placeDecal();
    }

    /**
     * Position the decal on the sponsor gun's outward face. Measured from the
     * model's ACTUAL bounds in group space, so it adapts to the camera gun's
     * euler, both VR eulers, and the left gun's mirror without hand-tuned
     * offsets per hand.
     */
    function _placeDecal() {
      if (!_decal || !_sponsorModel) return;
      const box = _groupSpaceBox(_sponsorModel);
      if (!isFinite(box.min.x)) return;

      const side = _decal.userData.side >= 0 ? 1 : -1;
      const h = (box.max.y - box.min.y) * DECAL_HEIGHT_FRAC;
      const img = _decal.material.map?.image;
      const aspect = img && img.height ? img.width / img.height : 3.27;

      _decal.scale.set(h * aspect, h, 1);
      _decal.position.set(
        side > 0 ? box.max.x + DECAL_LIFT : box.min.x - DECAL_LIFT,
        box.min.y + (box.max.y - box.min.y) * DECAL_Y_BIAS,
        (box.min.z + box.max.z) / 2,
      );
      // Plane faces +Z by default; turn it to face outward along X.
      _decal.rotation.set(0, side > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
    }

    /**
     * Bounds of `root` expressed in GROUP space.
     *
     * Deliberately NOT Box3.setFromObject() + inverse-group: that returns a
     * WORLD axis-aligned box, and re-bounding it through the group's rotation
     * (the camera gun's group carries CAMERA_EULER) inflates and re-centres it,
     * which put the decal off the gun. Transforming each geometry's own
     * bounding box by (inverse-group x mesh-world) instead gives a tight,
     * correctly-centred box in the space the decal's position actually lives in.
     */
    function _groupSpaceBox(root) {
      group.updateMatrixWorld(true);
      const inv = _invGroup.copy(group.matrixWorld).invert();
      const out = new THREE.Box3(); out.makeEmpty();
      const tmp = new THREE.Box3(); const m = new THREE.Matrix4();
      root.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        tmp.copy(o.geometry.boundingBox);
        m.multiplyMatrices(inv, o.matrixWorld);
        tmp.applyMatrix4(m);
        out.union(tmp);
      });
      return out;
    }

    /** Swap between the bitcoin gun and the sponsor gun. Visibility only. */
    function setSponsor(on) {
      if (on === _sponsorOn) return;
      if (!_sponsorModel || !_bitcoinModel) return;

      // Grey (fairness) bookkeeping is keyed by material, so restore the model
      // we are leaving before switching, then re-apply to the one we arrive at.
      const wasGrey = _greyActive;
      if (wasGrey) _restoreGrey();

      _sponsorOn = on;
      _bitcoinModel.visible = !on;
      _sponsorModel.visible = on;
      if (_decal) _decal.visible = on;

      _model      = on ? _sponsorModel : _bitcoinModel;
      _modelScale = on ? SPONSOR_MODEL_SCALE : MODEL_SCALE;
      _applyTransform();
      if (_decal) _placeDecal();

      if (wasGrey) { _greyActive = true; _applyGrey(); }
    }

    function setMirror(b)      { _mirror = b; _applyTransform(); _placeDecal(); }
    function setModelEuler(e)  { _euler  = e; _applyTransform(); _placeDecal(); }

    // ── Flash state (per-unit) ──────────────────────────────────────────────
    let _flashAge = FLASH_DURATION; // start "expired"

    function flashMuzzle() {
      _flashAge = 0;
      flash.visible = true;
      flashMat.opacity = 1;
      flashMat.rotation = Math.random() * Math.PI * 2;
      const j = FLASH_SIZE * (0.85 + Math.random() * 0.4);
      flash.scale.set(j, j, 1);
    }

    function updateFlash(delta) {
      if (!flash.visible) return;
      _flashAge += delta;
      if (_flashAge >= FLASH_DURATION) {
        flash.visible = false;
        flashMat.opacity = 0;
      } else {
        flashMat.opacity = 1 - _flashAge / FLASH_DURATION;
      }
    }

    return { group, setModel, setSponsorModel, setSponsor, setMirror, setModelEuler,
             setGrey, flashMuzzle, updateFlash };
  }

  // ── Create guns ───────────────────────────────────────────────────────────
  const cameraGun      = buildGunUnit(MODEL_EULER);
  const controllerGuns = [buildGunUnit(VR_MODEL_EULER), buildGunUnit(VR_MODEL_EULER)];

  // Camera gun: permanent camera child; visible in flat/mobile/AR.
  camera.add(cameraGun.group);
  cameraGun.group.position.copy(isMobileView() ? CAMERA_POS_MOBILE : CAMERA_POS);
  cameraGun.group.rotation.copy(CAMERA_EULER);
  cameraGun.group.scale.setScalar(CAMERA_SCALE);

  // Controller guns: permanently attached to their controller from startup;
  // hidden until the controller actually connects as a tracked-pointer device.
  controllerGuns.forEach((g, i) => {
    const c = renderer.xr.getController(i);
    c.add(g.group);
    g.group.position.copy(VR_POS);
    g.group.rotation.copy(VR_EULER);
    g.group.scale.setScalar(VR_SCALE);
    g.group.visible = false;
  });

  // ── Load GLB once; assign to guns ─────────────────────────────────────────
  console.log('[gun] loading GLB from', gunModelUrl);
  _loaders().then((gltfLoader) => gltfLoader.load(
    gunModelUrl,
    (gltf) => {
      // Snapshot BEFORE transforms — peers get a clean, unpositioned copy.
      _loadedGunScene = gltf.scene.clone(true);
      _gunLoadedResolve();

      // Diagnostics (unchanged from before).
      const box    = new THREE.Box3().setFromObject(gltf.scene);
      const size   = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      let meshCount = 0;
      const mats = new Set();
      gltf.scene.traverse((o) => {
        if (o.isMesh) {
          meshCount++;
          const m = o.material;
          (Array.isArray(m) ? m : [m]).forEach((mat) => mat && mats.add(mat.type));
        }
      });
      console.log('[gun] LOADED ✓ ' + JSON.stringify({
        rawSize: [+size.x.toFixed(3), +size.y.toFixed(3), +size.z.toFixed(3)],
        center:  [+center.x.toFixed(3), +center.y.toFixed(3), +center.z.toFixed(3)],
        meshCount,
        materials: [...mats],
        willScaleBy: MODEL_SCALE,
      }));

      // Camera gun gets the raw scene; controller guns get deep clones.
      cameraGun.setModel(gltf.scene);
      controllerGuns[0].setModel(gltf.scene.clone(true));
      controllerGuns[1].setModel(gltf.scene.clone(true));
    },
    (p) => { if (p.total) console.log(`[gun] loading ${Math.round((p.loaded / p.total) * 100)}%`); },
    (err) => console.error('[gun] LOAD FAILED ✗', err),
  ));

  // ── Sponsor gun preload ───────────────────────────────────────────────────
  // Loaded ONCE at startup and cloned per gun, so the swap when the paid window
  // opens is a visibility toggle with no download and no hitch.
  //
  // PER-HAND LOGO MAPPING (as specified): camera + right hand use the
  // "facing_right" sheet, the left hand uses "facing_left".
  // IMPORTANT, verified by inspecting the supplied art: the "left" sheet is NOT
  // a pre-mirrored copy — it is the same two logos with their POSITIONS swapped,
  // and the LNbits wordmark reads FORWARD in both. So a mirrored decal would
  // render it backwards no matter which sheet was used. That is why the decal
  // hangs off the unmirrored group (see setSponsorModel): both hands read
  // correctly by construction, and this mapping is preserved so the sheets can
  // still be swapped per hand after the on-device check.
  // DEFERRED PRELOAD — the sponsor gun + its two logo sheets are ~800 KB and are
  // only needed once a PAID rapid-fire window opens, which cannot happen in the
  // first seconds of a session. Fetching them during init pushed ~800 KB ahead
  // of the player's first interaction (and on cellular, well ahead of it). They
  // now load once the game is already playable. The swap is still instant when
  // the window opens, because that is minutes of play away, not milliseconds.
  const afterInteractive = (fn) => (typeof requestIdleCallback === 'function'
    ? requestIdleCallback(fn, { timeout: 5000 })
    : setTimeout(fn, 2000));

  let _logoRight = null, _logoLeft = null;

  function preloadSponsor() {
    const texLoader = new THREE.TextureLoader();
    _logoRight = texLoader.load(sponsorLogoRightUrl);
    _logoLeft  = texLoader.load(sponsorLogoLeftUrl);
    [_logoRight, _logoLeft].forEach((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
    });
    _loadSponsorGun();
  }

  function _loadSponsorGun() {
  _loaders().then((gltfLoader) => gltfLoader.load(
    sponsorGunUrl,
    (gltf) => {
      // Measure BEFORE parenting: once the model is inside a gun group, a world
      // AABB picks up the group's rotation and reports inflated numbers.
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const size = box.getSize(new THREE.Vector3());
      cameraGun.setSponsorModel(gltf.scene, _logoRight, DECAL_SIDE_CAMERA);
      controllerGuns[0].setSponsorModel(gltf.scene.clone(true), _logoRight, DECAL_SIDE_RIGHT);
      controllerGuns[1].setSponsorModel(gltf.scene.clone(true), _logoLeft,  DECAL_SIDE_LEFT);
      console.log('[gun:sponsor] LOADED ✓ ' + JSON.stringify({
        rawSize: [+size.x.toFixed(3), +size.y.toFixed(3), +size.z.toFixed(3)],
        scale: +SPONSOR_MODEL_SCALE.toFixed(3),
      }));
      _applySponsorState(isRapidFire()); // in case a window is already open
    },
    undefined,
    (err) => console.error('[gun:sponsor] LOAD FAILED ✗ — keeping the bitcoin gun', err),
  ));
  }

  afterInteractive(preloadSponsor);

  // ── Sponsor swap, riding the EXISTING paid rapid-fire window ─────────────
  // isRapidFire() is the same single source of truth the HUD countdown and
  // shoot.js's lightning already read, so the gun swaps exactly when the paid
  // window opens and reverts exactly when it closes — including every repeat
  // window, with no new timer, event bus, or duplicated state.
  let _sponsorShown = false;
  function _applySponsorState(on) {
    if (on === _sponsorShown) return;
    _sponsorShown = on;
    if (import.meta.env.DEV) console.log('[gun:sponsor] window ' + (on ? 'OPEN → sponsor gun' : 'CLOSED → bitcoin gun'));
    cameraGun.setSponsor(on);
    controllerGuns.forEach((g) => g.setSponsor(on));
  }

  // ── VR session: show/hide camera gun ─────────────────────────────────────
  // Camera gun stays parented to camera the whole time; hidden during VR so
  // the controller guns (permanently on their controllers) take over visually.
  renderer.xr.addEventListener('sessionstart', () => { cameraGun.group.visible = false; });
  renderer.xr.addEventListener('sessionend',   () => { cameraGun.group.visible = true;  });

  // ── Fairness gate: left gun active/inactive ───────────────────────────────
  // setLeftGunActive(false) drops to right-hand-only when a flat peer is in the
  // session. Updates gun visibility instantly; fire is gated in notifyControllerFire.
  // Left-stick locomotion is NOT touched — only the gun visual + its trigger.
  let _leftGunActive      = true;
  let _leftControllerIndex = -1; // controller index whose handedness === 'left'

  function setLeftGunActive(active) {
    _leftGunActive = active;
    if (_leftControllerIndex >= 0) {
      // Don't hide — grey out instead so the player sees the gun is present but off.
      controllerGuns[_leftControllerIndex].setGrey(!active);
    }
  }

  // ── Per-hand orientation: set euler + mirror at connect time ──────────────
  // Controller index 0/1 is not reliably left/right — handedness comes from
  // event.data.handedness. Two separate euler constants so tuning one never
  // touches the other.
  [0, 1].forEach((i) => {
    renderer.xr.getController(i).addEventListener('connected', (e) => {
      const src = e.data;
      if (!src || src.targetRayMode !== 'tracked-pointer') return;
      const isLeft = src.handedness === 'left';
      if (isLeft) _leftControllerIndex = i;
      controllerGuns[i].setModelEuler(isLeft ? VR_MODEL_EULER_LEFT : VR_MODEL_EULER);
      controllerGuns[i].setMirror(isLeft && MIRROR_LEFT);
      controllerGuns[i].group.visible = true; // always show; grey signals disabled
      // Apply grey immediately if the fairness gate was already active.
      if (isLeft && !_leftGunActive) controllerGuns[i].setGrey(true);
    });
    renderer.xr.getController(i).addEventListener('disconnected', () => {
      if (i === _leftControllerIndex) _leftControllerIndex = -1;
      controllerGuns[i].setGrey(false); // reset material state for next connect cycle
      controllerGuns[i].group.visible = false;
    });
  });

  // ── Flash routing ─────────────────────────────────────────────────────────
  // xr.js calls notifyControllerFire(index) just before shootFromRay.
  // Returns false when the left gun is gated — xr.js skips the shot entirely.
  let _firingController = -1;

  function notifyControllerFire(index) {
    if (index === _leftControllerIndex && !_leftGunActive) return false;
    _firingController = index;
    return true;
  }

  /** Called by shoot.js's onFire callback on every shot. */
  function flashMuzzle() {
    if (_firingController >= 0 && renderer.xr.isPresenting) {
      controllerGuns[_firingController].flashMuzzle();
    } else {
      cameraGun.flashMuzzle();
    }
  }

  /** Called every frame. Fades all active gun flashes, and keeps the sponsor
   *  swap in step with the paid rapid-fire window. Edge-detected, so the actual
   *  swap runs only on the two frames where the window opens and closes. */
  function updateWeapon(delta) {
    cameraGun.updateFlash(delta);
    controllerGuns.forEach((g) => g.updateFlash(delta));
    _applySponsorState(isRapidFire());
  }

  /**
   * setHidden(bool) — hide/show the camera gun.
   * Called by armode.js to hide the gun on handheld phone AR.
   * Controller guns manage their own visibility via connected/disconnected.
   */
  function setHidden(hidden) {
    cameraGun.group.visible = !hidden;
  }

  /**
   * Read-only accessor: the root Object3D of every gun (camera gun + both
   * controller guns). The skins module uses these to apply a REVERSIBLE tint
   * without re-parenting or rebuilding anything here. Nothing about weapon
   * behaviour changes; this only hands out references it already owns.
   */
  function getGunRoots() {
    return [cameraGun.group, ...controllerGuns.map((g) => g.group)];
  }

  return { updateWeapon, flashMuzzle, notifyControllerFire, setLeftGunActive, setHidden, getGunRoots };
}

// ── Muzzle-flash burst texture (drawn once, shared across all gun units) ─────
function createMuzzleTexture() {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  const cx = S / 2, cy = S / 2;
  ctx.clearRect(0, 0, S, S);

  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, S / 2);
  glow.addColorStop(0, 'rgba(255,240,200,0.9)');
  glow.addColorStop(0.3, 'rgba(247,147,26,0.7)');
  glow.addColorStop(0.7, 'rgba(247,147,26,0.18)');
  glow.addColorStop(1, 'rgba(247,147,26,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, S / 2, 0, Math.PI * 2);
  ctx.fill();

  const spikes = 13;
  const outer  = S * 0.48;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const ang = (i / (spikes * 2)) * Math.PI * 2;
    const isOuter = i % 2 === 0;
    const r = isOuter
      ? outer * (0.6 + Math.random() * 0.4)
      : S * (0.1 + Math.random() * 0.08);
    const x = cx + Math.cos(ang) * r;
    const y = cy + Math.sin(ang) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const fill = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer);
  fill.addColorStop(0, 'rgba(255,255,255,1)');
  fill.addColorStop(0.35, 'rgba(255,205,100,0.98)');
  fill.addColorStop(1, 'rgba(247,147,26,0.6)');
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
