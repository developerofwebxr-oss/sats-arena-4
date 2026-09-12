import * as THREE from '../../node_modules/three/build/three.module.js';
const D2R = Math.PI/180, R2D = 180/Math.PI;
const ZEE = new THREE.Vector3(0,0,1);
const q1  = new THREE.Quaternion(-Math.sqrt(0.5),0,0,Math.sqrt(0.5));

function deviceRaw(a,b,g){
  const e = new THREE.Euler(b*D2R, a*D2R, -g*D2R, 'YXZ');
  return new THREE.Quaternion().setFromEuler(e).multiply(q1);
}
const full = (a,b,g,orient=0) =>
  deviceRaw(a,b,g).multiply(new THREE.Quaternion().setFromAxisAngle(ZEE, -orient*D2R));

// the proposed helper
const yawAboutUp = (q) => 2*Math.atan2(q.y, q.w);
const Ry = (t) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), t);

// ── property check: yawAboutUp is additive under pre-rotation about world Y ──
let worst = 0;
for (let i=0;i<20000;i++){
  const q = new THREE.Quaternion().random();
  const t = (Math.random()*2-1)*Math.PI;
  const lhs = yawAboutUp(Ry(t).clone().multiply(q));
  let d = lhs - (t + yawAboutUp(q));
  d = Math.atan2(Math.sin(d), Math.cos(d));           // wrap
  worst = Math.max(worst, Math.abs(d));
}
console.log(`additivity yawAboutUp(Ry(t)*q) == t + yawAboutUp(q): max error ${(worst*R2D).toExponential(2)} deg over 20k random q\n`);

function metrics(q){
  const fwd = new THREE.Vector3(0,0,-1).applyQuaternion(q);
  const up  = new THREE.Vector3(0,1,0).applyQuaternion(q);
  const elevation = Math.asin(THREE.MathUtils.clamp(fwd.y,-1,1))*R2D;
  const right = new THREE.Vector3().crossVectors(fwd,new THREE.Vector3(0,1,0)).normalize();
  const roll = Math.atan2(up.dot(right), up.dot(new THREE.Vector3().crossVectors(right,fwd)))*R2D;
  return { elevation, roll, heading: Math.atan2(-fwd.x,-fwd.z)*R2D };
}
const horizonPx = (e,H=812,f=70)=> H/2 + (H/2)/Math.tan(f*D2R/2)*Math.tan(e*D2R);

const HEADINGS=[0,90,180,270];
for (const beta of [90,75,60]) {
  // OLD: anchorInverse is the FULL inverse of the anchor pose
  const anchorInv = deviceRaw(0,beta,0).invert();
  // NEW: the correction is a pure world-up yaw that cancels the anchor's heading
  const yawOffset = -yawAboutUp(full(0,beta,0));

  const rows = HEADINGS.map(a=>{
    const o = metrics(anchorInv.clone().multiply(full(a,beta,0)));
    const n = metrics(Ry(yawOffset).clone().multiply(full(a,beta,0)));
    return { alpha:a,
      old_elev:+o.elevation.toFixed(2), old_roll:+o.roll.toFixed(2), old_px:+horizonPx(o.elevation).toFixed(0),
      new_elev:+n.elevation.toFixed(2), new_roll:+n.roll.toFixed(2), new_px:+horizonPx(n.elevation).toFixed(0),
      new_heading:+n.heading.toFixed(1) };
  });
  const sp=(k)=>{const v=rows.map(r=>r[k]);return (Math.max(...v)-Math.min(...v)).toFixed(2);};
  console.log(`hold beta=${beta} (${90-beta} deg back from upright), gamma=0, anchored facing alpha=0`);
  console.table(rows);
  console.log(`  OLD elev spread ${sp('old_elev')} deg / roll spread ${sp('old_roll')} deg / horizon spread ${sp('old_px')} px`);
  console.log(`  NEW elev spread ${sp('new_elev')} deg / roll spread ${sp('new_roll')} deg / horizon spread ${sp('new_px')} px\n`);
}

// ── roll handling: phone rolled in-hand (gamma != 0) ────────────────────────
console.log('gamma sweep at beta=75, alpha=135 (NEW math) — roll must track the device, not the heading');
console.table([0,10,20,-15].map(g=>{
  const yawOffset = -yawAboutUp(full(0,75,0));
  const m = metrics(Ry(yawOffset).clone().multiply(full(135,75,g)));
  return { gamma:g, elev:+m.elevation.toFixed(2), roll:+m.roll.toFixed(2) };
}));
