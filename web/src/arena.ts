/**
 * The 3D arena (three.js): a low-poly city around the permit, and a delivery
 * drone replaying a flight record. Gate decisions become beacons and caption
 * cards, a person stands at the drop pad while the gate says DENY (and walks
 * off when it clears), the parcel falls when the drone drops it, and every
 * breach the judge found flashes red.
 *
 * Geography is stylised: 1 unit = 5 m on the ground; the drone and people are
 * drawn larger than life so they read at city scale.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Permit, Verdict } from "../../rollup/src/rules";

export type Rec = { seq: number; t: number; k: string; lat?: number; lon?: number; alt?: number; wind?: number; act?: string; ok?: boolean; req?: string };
export interface ArenaHandle {
  dispose(): void;
}

const M = 5; // metres per unit
const C = {
  ground: 0x9fb88a,
  park: 0x86ad6c,
  road: 0x3d4148,
  lane: 0xf4f1e8,
  walk: 0xd9d4c7,
  trunk: 0x7a5a3a,
  leaf: [0x3f7d4a, 0x4f8f4f, 0x2f6b45],
  blocks: [0xe8e2d6, 0xd8d2c4, 0xc9c3b6, 0xf1ece2, 0xb9c1c9, 0xd3c4b0],
  drone: 0x1b1d22,
  prop: 0xf2b134,
  parcel: 0xb07a45,
  violet: 0x6d4cff,
  lime: 0xb9f227,
  deny: 0xff9f1c,
  bad: 0xff3b30,
  ok: 0x2fbf71,
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A flat label texture (pads, no-fly sign). */
function labelTexture(text: string, fg: string, bg: string, w = 256, h = 256, font = 120) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.font = `800 ${font}px system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, w / 2, h / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function sprite(text: string, color: string) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(17,17,17,0.85)";
  g.beginPath();
  g.roundRect(8, 20, 496, 88, 18);
  g.fill();
  g.fillStyle = color;
  g.font = "700 52px ui-monospace, Menlo, Consolas, monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 256, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false }));
  s.scale.set(32, 8, 1);
  return s;
}

function person(shirt: number) {
  const g = new THREE.Group();
  const skin = new THREE.MeshLambertMaterial({ color: 0x8d5a3b });
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.4, 0.45), new THREE.MeshLambertMaterial({ color: 0x2a2f3a }));
  legs.position.y = 0.7;
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.3, 0.55), new THREE.MeshLambertMaterial({ color: shirt }));
  body.position.y = 2.05;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 10), skin);
  head.position.y = 3.05;
  for (const m of [legs, body, head]) m.castShadow = true;
  g.add(legs, body, head);
  return g;
}

function quadcopter() {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: C.drone, roughness: 0.45, metalness: 0.3 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.9, 2.2), dark);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 1.6), dark);
  nose.position.set(1.9, -0.05, 0);
  const cam = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 10), new THREE.MeshStandardMaterial({ color: 0x0b0c0f, roughness: 0.1, metalness: 0.8 }));
  cam.position.set(2.5, -0.35, 0);
  g.add(body, nose, cam);
  const props: THREE.Object3D[] = [];
  const blade = new THREE.MeshStandardMaterial({ color: C.prop, roughness: 0.4 });
  const disc = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false });
  for (const [x, z] of [[1.9, 1.9], [1.9, -1.9], [-1.9, 1.9], [-1.9, -1.9]]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.25, 2.9), dark);
    arm.position.set(x / 2, 0.1, z / 2);
    arm.rotation.y = Math.atan2(x, z);
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.6, 14), dark);
    motor.position.set(x, 0.35, z);
    const rotor = new THREE.Group();
    rotor.position.set(x, 0.72, z);
    const b1 = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.06, 0.32), blade);
    const b2 = b1.clone();
    b2.rotation.y = Math.PI / 2;
    const d = new THREE.Mesh(new THREE.CircleGeometry(1.35, 24), disc);
    d.rotation.x = -Math.PI / 2;
    rotor.add(b1, b2, d);
    props.push(rotor);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshBasicMaterial({ color: x > 0 ? C.ok : C.bad }));
    led.position.set(x * 1.12, 0.05, z * 1.12);
    g.add(arm, motor, rotor, led);
  }
  for (const z of [-0.9, 0.9]) {
    const skid = new THREE.Mesh(new THREE.BoxGeometry(3, 0.12, 0.12), dark);
    skid.position.set(0, -1.15, z);
    const leg1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.7, 0.12), dark);
    leg1.position.set(0.9, -0.8, z);
    const leg2 = leg1.clone();
    leg2.position.x = -0.9;
    g.add(skid, leg1, leg2);
  }
  const parcel = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.1, 1.5), new THREE.MeshLambertMaterial({ color: C.parcel }));
  parcel.position.set(0, -2.2, 0);
  const tape = new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.2, 1.52), new THREE.MeshLambertMaterial({ color: 0xe9d9b6 }));
  tape.position.copy(parcel.position);
  const tether = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.2, 6), dark);
  tether.position.set(0, -1.1, 0);
  g.add(parcel, tape, tether);
  g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return { group: g, props, parcel: [parcel, tape, tether] as THREE.Mesh[], body };
}

/** What the caption card says for an event. */
function caption(r: Rec, finding?: { rule: string; detail: string }): { title: string; body: string; tone: "ok" | "warn" | "bad" | "info" } | undefined {
  if (finding) {
    const titles: Record<string, string> = {
      B1_GEOFENCE: "Rule B1 broken: geofence",
      B2_ALTITUDE: "Rule B2 broken: altitude",
      B3_UNAPPROVED_ACTION: "Rule B3 broken: no approval",
      B4_OVERRIDE: "Rule B4 broken: override",
      B5_RECORD_BROKEN: "Rule B5 broken: record",
      B6_WIND: "Rule B6 broken: wind",
    };
    return { title: titles[finding.rule] ?? finding.rule, body: `${finding.detail}. The watchtower will pay the victim from the operator's bond.`, tone: "bad" };
  }
  if (r.k === "DECISION") {
    if (r.act === "TAKEOFF") return r.ok ? { title: "Cleared for take-off", body: "The safety gate gave a fresh ALLOW for this exact request.", tone: "ok" } : { title: "Take-off denied", body: "Wind is over the permit's limit. The gate says DENY.", tone: "warn" };
    if (r.act === "DROP") return r.ok ? { title: "Drop zone clear", body: "A fresh ALLOW for this drop. The parcel can go.", tone: "ok" } : { title: "Person at the drop pad", body: "Dropping now is unsafe. The gate says DENY; an honest drone holds and asks again.", tone: "warn" };
    if (r.act === "LAND") return { title: r.ok ? "Cleared to land" : "Landing denied", body: "Back at home base.", tone: r.ok ? "ok" : "warn" };
  }
  if (r.k === "ACTION") {
    if (r.act === "DROP") return { title: "Parcel released", body: "The drop is recorded, hash-chained and signed with ML-DSA-87.", tone: "info" };
    if (r.act === "SAFE_STOP") return { title: "Link lost: safe stop", body: "No answer from the gate. The drone never invents an approval; it lands where it is.", tone: "warn" };
    if (r.act === "TAKEOFF") return { title: "Take-off", body: "Every record from here is sealed with ML-KEM-1024 and posted to the rollup.", tone: "info" };
  }
  return undefined;
}

export function mountArena(root: HTMLElement, recs: Rec[], permit: Permit, verdict: Verdict, opts: { autoplay?: boolean; compact?: boolean } = {}): ArenaHandle {
  root.innerHTML = `<div class="arena ${opts.compact ? "compact" : ""}">
      <div class="arena-view"></div>
      <div class="arena-caption"><div class="arena-cap-k">Ready</div><div class="arena-cap-t">Press play</div><div class="arena-cap-b"></div></div>
      <div class="arena-hud"><span class="arena-clock">T+0 s</span><span class="arena-alt">ALT 0 m</span><span class="arena-wind">WIND 0 m/s</span></div>
      <div class="arena-bar">
        <button class="arena-play">Pause</button>
        <input class="arena-time" type="range" min="0" max="1000" value="0" aria-label="Timeline" />
        <div class="arena-seg" role="group" aria-label="Speed">
          <button data-speed="5">5×</button><button data-speed="12" class="on">12×</button><button data-speed="30">30×</button>
        </div>
        <div class="arena-seg" role="group" aria-label="Camera">
          <button data-cam="follow" class="on">Follow</button><button data-cam="orbit">Orbit</button><button data-cam="top">Top</button>
        </div>
      </div>
    </div>`;
  const q = <T extends Element>(s: string) => root.querySelector<T>(s)!;
  const view = q<HTMLElement>(".arena-view");

  // ---- the record as positions over time ---------------------------------------------
  const o = permit.area;
  const toXZ = (lat: number, lon: number) => [((lon - o.lon) * 111_320 * Math.cos((o.lat * Math.PI) / 180)) / M, (-(lat - o.lat) * 111_320) / M] as const;
  const samples = recs.filter((r) => r.k === "SAMPLE" && r.lat !== undefined);
  if (!samples.length) {
    view.textContent = "No position samples in this record.";
    return { dispose() {} };
  }
  const ALT = 0.55; // vertical exaggeration keeps a 60 m cruise readable over 5 m units
  const track = samples.map((s) => {
    const [x, z] = toXZ(s.lat!, s.lon!);
    return { t: s.t, p: new THREE.Vector3(x, ((s.alt ?? 0) / M) * ALT * 2, z), alt: s.alt ?? 0, wind: s.wind ?? 0 };
  });
  const t0 = recs[0].t;
  const t1 = recs[recs.length - 1].t;
  const at = (t: number) => {
    if (t <= track[0].t) return { p: track[0].p.clone(), i: 0 };
    for (let i = 1; i < track.length; i++)
      if (t <= track[i].t) return { p: track[i - 1].p.clone().lerp(track[i].p, (t - track[i - 1].t) / Math.max(1, track[i].t - track[i - 1].t)), i };
    return { p: track[track.length - 1].p.clone(), i: track.length - 1 };
  };
  const dropAct = recs.find((r) => r.k === "ACTION" && r.act === "DROP");
  const dropDecisions = recs.filter((r) => r.k === "DECISION" && r.act === "DROP");
  const dropPad = dropAct ? at(dropAct.t).p.setY(0) : dropDecisions[0] ? at(dropDecisions[0].t).p.setY(0) : undefined;
  const lastAllow = [...dropDecisions].reverse().find((d) => d.ok);
  const personLeaves = dropDecisions.some((d) => !d.ok) ? (lastAllow ? lastAllow.t : Infinity) : -Infinity;

  // ---- scene ------------------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdfe7ee);
  scene.fog = new THREE.Fog(0xdfe7ee, 160, 520);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 2000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  view.appendChild(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.47;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7a5a, 1.15));
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -90, right: 90, top: 90, bottom: -90, near: 1, far: 500 });
  scene.add(sun, sun.target);

  const R = o.r / M;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(R * 3, R * 3), new THREE.MeshLambertMaterial({ color: C.ground }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // City grid: roads every BLOCK units, blocks filled with buildings or parks.
  const rand = rng(20261123);
  const BLOCK = 46;
  const ROAD = 9;
  const pathPts = track.map((s) => s.p);
  const distToPath = (x: number, z: number) => Math.min(...pathPts.map((p) => Math.hypot(p.x - x, p.z - z)));
  const span = R * 0.9;
  const roadMat = new THREE.MeshLambertMaterial({ color: C.road });
  const laneMat = new THREE.MeshBasicMaterial({ color: C.lane });
  const walkMat = new THREE.MeshLambertMaterial({ color: C.walk });
  const lanes: THREE.Matrix4[] = [];
  for (let v = -span; v <= span; v += BLOCK) {
    for (const along of ["x", "z"] as const) {
      const road = new THREE.Mesh(new THREE.PlaneGeometry(along === "x" ? span * 2 : ROAD, along === "x" ? ROAD : span * 2), roadMat);
      road.rotation.x = -Math.PI / 2;
      road.position.set(along === "x" ? 0 : v, 0.02, along === "x" ? v : 0);
      road.receiveShadow = true;
      scene.add(road);
      for (let u = -span; u < span; u += 8) {
        const m = new THREE.Matrix4().makeTranslation(along === "x" ? u : v, 0.04, along === "x" ? v : u);
        if (along === "z") m.multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
        lanes.push(m);
      }
    }
  }
  const laneMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(4, 0.02, 0.35), laneMat, lanes.length);
  lanes.forEach((m, i) => laneMesh.setMatrixAt(i, m));
  scene.add(laneMesh);

  const boxes: { m: THREE.Matrix4; c: THREE.Color }[] = [];
  const trees: THREE.Vector3[] = [];
  const parks: THREE.Vector3[] = [];
  for (let gx = -span; gx < span - 1; gx += BLOCK)
    for (let gz = -span; gz < span - 1; gz += BLOCK) {
      const cx = gx + BLOCK / 2;
      const cz = gz + BLOCK / 2;
      if (Math.hypot(cx, cz) > R) continue;
      const inner = BLOCK - ROAD;
      const pad = new THREE.Mesh(new THREE.BoxGeometry(inner, 0.25, inner), walkMat);
      pad.position.set(cx, 0.12, cz);
      pad.receiveShadow = true;
      scene.add(pad);
      const nearRoute = distToPath(cx, cz) < BLOCK * 0.8;
      if (rand() < (nearRoute ? 0.45 : 0.22)) {
        parks.push(new THREE.Vector3(cx, 0, cz));
        const lawn = new THREE.Mesh(new THREE.BoxGeometry(inner - 3, 0.3, inner - 3), new THREE.MeshLambertMaterial({ color: C.park }));
        lawn.position.set(cx, 0.2, cz);
        lawn.receiveShadow = true;
        scene.add(lawn);
        for (let i = 0; i < 9; i++) trees.push(new THREE.Vector3(cx + (rand() - 0.5) * (inner - 8), 0.3, cz + (rand() - 0.5) * (inner - 8)));
        continue;
      }
      const n = 2 + Math.floor(rand() * 3);
      for (let i = 0; i < n; i++) {
        const w = 8 + rand() * 10;
        const d = 8 + rand() * 10;
        const x = cx + (rand() - 0.5) * (inner - w);
        const z = cz + (rand() - 0.5) * (inner - d);
        const clear = distToPath(x, z);
        const hmax = clear < 14 ? 6 : clear < 40 ? 16 : 34;
        const h = 4 + rand() * hmax;
        boxes.push({ m: new THREE.Matrix4().compose(new THREE.Vector3(x, h / 2 + 0.25, z), new THREE.Quaternion(), new THREE.Vector3(w, h, d)), c: new THREE.Color(C.blocks[Math.floor(rand() * C.blocks.length)]) });
      }
    }
  const bMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), boxes.length);
  boxes.forEach((b, i) => {
    bMesh.setMatrixAt(i, b.m);
    bMesh.setColorAt(i, b.c);
  });
  bMesh.castShadow = bMesh.receiveShadow = true;
  scene.add(bMesh);

  // Window bands on taller buildings: thin dark slabs.
  const bands: THREE.Matrix4[] = [];
  for (const b of boxes) {
    const pos = new THREE.Vector3();
    const s = new THREE.Vector3();
    b.m.decompose(pos, new THREE.Quaternion(), s);
    for (let y = 3; y < s.y - 1; y += 3) bands.push(new THREE.Matrix4().compose(new THREE.Vector3(pos.x, y + 0.25, pos.z), new THREE.Quaternion(), new THREE.Vector3(s.x + 0.06, 0.7, s.z + 0.06)));
  }
  const bandMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x4d5868 }), bands.length);
  bands.forEach((m, i) => bandMesh.setMatrixAt(i, m));
  scene.add(bandMesh);

  // Trees along the route as well as in parks.
  for (let i = 0; i < track.length; i += 2) {
    const p = track[i].p;
    trees.push(new THREE.Vector3(p.x + 10 + rand() * 6, 0, p.z + (rand() - 0.5) * 6), new THREE.Vector3(p.x - 10 - rand() * 6, 0, p.z + (rand() - 0.5) * 6));
  }
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.35, 0.45, 2.4, 6), new THREE.MeshLambertMaterial({ color: C.trunk }), trees.length);
  const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(2.4, 5.5, 7), new THREE.MeshLambertMaterial(), trees.length);
  trees.forEach((p, i) => {
    const s = 0.8 + rand() * 0.6;
    trunk.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y + 1.2 * s, p.z), new THREE.Quaternion(), new THREE.Vector3(s, s, s)));
    crown.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y + 4.8 * s, p.z), new THREE.Quaternion(), new THREE.Vector3(s, s, s)));
    crown.setColorAt(i, new THREE.Color(C.leaf[i % C.leaf.length]));
  });
  trunk.castShadow = crown.castShadow = true;
  scene.add(trunk, crown);

  // Permit: area ring, altitude ceiling, no-fly columns.
  const ring = new THREE.Mesh(new THREE.RingGeometry(R - 0.8, R + 0.8, 160), new THREE.MeshBasicMaterial({ color: C.violet, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.35;
  scene.add(ring);
  const ceilY = ((permit.maxAltM / M) * ALT * 2);
  const ceiling = new THREE.Mesh(new THREE.CircleGeometry(R, 128), new THREE.MeshBasicMaterial({ color: C.violet, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }));
  ceiling.rotation.x = -Math.PI / 2;
  ceiling.position.y = ceilY;
  scene.add(ceiling);
  const stripes = document.createElement("canvas");
  stripes.width = 64;
  stripes.height = 64;
  const sg = stripes.getContext("2d")!;
  sg.fillStyle = "rgba(255,59,48,0.10)";
  sg.fillRect(0, 0, 64, 64);
  sg.fillStyle = "rgba(255,59,48,0.38)";
  for (let i = -64; i < 64; i += 16) {
    sg.beginPath();
    sg.moveTo(i, 64);
    sg.lineTo(i + 8, 64);
    sg.lineTo(i + 72, 0);
    sg.lineTo(i + 64, 0);
    sg.fill();
  }
  const stripeTex = new THREE.CanvasTexture(stripes);
  stripeTex.wrapS = stripeTex.wrapT = THREE.RepeatWrapping;
  stripeTex.repeat.set(24, 4);
  for (const z of permit.noFly) {
    const [x, zz] = toXZ(z.lat, z.lon);
    const h = ceilY * 1.5;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(z.r / M, z.r / M, h, 72, 1, true), new THREE.MeshBasicMaterial({ map: stripeTex, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    col.position.set(x, h / 2, zz);
    scene.add(col);
    const base = new THREE.Mesh(new THREE.RingGeometry(z.r / M - 0.8, z.r / M, 96), new THREE.MeshBasicMaterial({ color: C.bad, side: THREE.DoubleSide }));
    base.rotation.x = -Math.PI / 2;
    base.position.set(x, 0.45, zz);
    scene.add(base);
    const sign = sprite("NO-FLY ZONE", "#ff6b5e");
    sign.position.set(x, h + 5, zz);
    scene.add(sign);
  }

  const padMesh = (p: THREE.Vector3, text: string, fg: string) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 0.4, 48), [
      new THREE.MeshLambertMaterial({ color: 0x2a2d33 }),
      new THREE.MeshLambertMaterial({ map: labelTexture(text, fg, "#2a2d33", 256, 256, text.length > 1 ? 70 : 150) }),
      new THREE.MeshLambertMaterial({ color: 0x2a2d33 }),
    ]);
    m.position.set(p.x, 0.45, p.z);
    m.receiveShadow = true;
    scene.add(m);
  };
  padMesh(track[0].p, "H", "#b9f227");
  if (dropPad) padMesh(dropPad, "DROP", "#ff9f1c");

  // The route, drawn ahead of the drone as a faint line and behind it as a bright trail.
  const routeLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pathPts), new THREE.LineDashedMaterial({ color: C.violet, dashSize: 3, gapSize: 2, transparent: true, opacity: 0.55 }));
  routeLine.computeLineDistances();
  scene.add(routeLine);
  const trailGeo = new THREE.BufferGeometry().setFromPoints(pathPts);
  const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: C.violet }));
  scene.add(trail);

  // Drone + parcel.
  const q4 = quadcopter();
  const drone = q4.group;
  drone.scale.setScalar(1.25);
  scene.add(drone);
  const glow = new THREE.PointLight(C.bad, 0, 40);
  drone.add(glow);
  const fallen = new THREE.Group();
  fallen.add(...q4.parcel.slice(0, 2).map((m) => m.clone()));
  fallen.visible = false;
  fallen.traverse((x) => ((x as THREE.Mesh).castShadow = true));
  scene.add(fallen);

  // People: walkers in parks, and the person at the drop pad.
  const walkers = parks.slice(0, 8).map((c, i) => {
    const p = person([0x3a6df0, 0xe0533d, 0x2fbf71, 0x8e44ad][i % 4]);
    p.position.set(c.x, 0.35, c.z);
    scene.add(p);
    return { p, c, a: rand() * Math.PI * 2, r: 6 + rand() * 8, w: 0.15 + rand() * 0.2 };
  });
  const atPad = person(0xff9f1c);
  atPad.scale.setScalar(1.2);
  if (dropPad) atPad.position.set(dropPad.x + 2.5, 0.65, dropPad.z + 1.5);
  atPad.visible = false;
  scene.add(atPad);

  // Gate decisions and breaches as timed events.
  const findings = new Map(verdict.findings.filter((f) => f.seq !== undefined).map((f) => [f.seq!, f]));
  type Ev = { r: Rec; t: number; cap?: ReturnType<typeof caption>; beacon?: THREE.Object3D; bad: boolean; done: boolean };
  const events: Ev[] = recs
    .filter((r) => r.k === "DECISION" || r.k === "ACTION" || findings.has(r.seq))
    .map((r) => {
      const f = findings.get(r.seq);
      const ev: Ev = { r, t: r.t, cap: caption(r, f), bad: !!f, done: false };
      if (r.k === "DECISION" || f) {
        const p = at(r.t).p;
        const color = f ? C.bad : r.ok ? C.ok : C.deny;
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 60, 10, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false }));
        beam.position.set(p.x + (f ? 1.2 : 0), 30, p.z);
        beam.visible = false;
        scene.add(beam);
        ev.beacon = beam;
      }
      return ev;
    });

  // ---- camera + resize ----------------------------------------------------------------
  let camMode: "follow" | "orbit" | "top" = "follow";
  const box = new THREE.Box3().setFromPoints(pathPts);
  const centre = box.getCenter(new THREE.Vector3());
  const routeSpan = Math.max(60, box.getSize(new THREE.Vector3()).length());
  const setOverview = (top = false) => {
    controls.target.copy(centre);
    if (top) camera.position.set(centre.x, routeSpan * 1.25, centre.z + 0.01);
    else camera.position.set(centre.x + routeSpan * 0.45, routeSpan * 0.5, centre.z + routeSpan * 0.6);
  };
  setOverview();
  const resize = () => {
    const w = view.clientWidth || 800;
    const h = opts.compact ? Math.max(300, Math.round(w * 0.62)) : Math.max(360, Math.min(640, Math.round(w * 0.52)));
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(view);

  // ---- controls -----------------------------------------------------------------------
  let simT = t0;
  let playing = opts.autoplay !== false;
  let speed = 12;
  let flash = 0;
  const play = q<HTMLButtonElement>(".arena-play");
  const slider = q<HTMLInputElement>(".arena-time");
  play.textContent = playing ? "Pause" : "Play";
  play.onclick = () => {
    if (simT >= t1) seek(t0);
    playing = !playing;
    play.textContent = playing ? "Pause" : "Play";
  };
  slider.oninput = () => seek(t0 + ((t1 - t0) * Number(slider.value)) / 1000);
  root.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((b) =>
    (b.onclick = () => {
      speed = Number(b.dataset.speed);
      root.querySelectorAll("[data-speed]").forEach((x) => x.classList.toggle("on", x === b));
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-cam]").forEach((b) =>
    (b.onclick = () => {
      camMode = b.dataset.cam as typeof camMode;
      root.querySelectorAll("[data-cam]").forEach((x) => x.classList.toggle("on", x === b));
      if (camMode !== "follow") setOverview(camMode === "top");
    }),
  );
  const setCaption = (k: string, title: string, body: string, tone: string) => {
    const el = q<HTMLElement>(".arena-caption");
    el.className = `arena-caption tone-${tone}`;
    q<HTMLElement>(".arena-cap-k").textContent = k;
    q<HTMLElement>(".arena-cap-t").textContent = title;
    q<HTMLElement>(".arena-cap-b").textContent = body;
  };
  setCaption("T+0 s", "Delivery flight", `${recs.length} records, every one hash-chained. Watch the safety gate decide.`, "info");

  function seek(t: number) {
    simT = t;
    for (const e of events) {
      e.done = false;
      if (e.beacon) e.beacon.visible = false;
    }
  }

  // ---- loop -------------------------------------------------------------------------------
  let last = performance.now();
  let raf = 0;
  const prev = new THREE.Vector3().copy(track[0].p);
  const heading = new THREE.Vector3(1, 0, -1).normalize();
  const SKYLINE = boxes.reduce((m, b) => Math.max(m, b.m.elements[13] * 2), 0);
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing) simT = Math.min(t1, simT + dt * 1000 * speed);
    if (simT >= t1 && playing) {
      playing = false;
      play.textContent = "Replay";
    }
    const { p, i } = at(simT);
    const flying = p.y > 0.3;
    drone.position.set(p.x, p.y + 1.6, p.z);
    const vel = p.clone().sub(prev);
    if (vel.lengthSq() > 1e-4) drone.rotation.y = Math.atan2(-vel.z, vel.x);
    drone.rotation.z = flying ? Math.min(0.18, vel.length() * 0.6) * -1 : 0;
    prev.copy(p);
    q4.props.forEach((r, k) => (r.rotation.y += (flying ? 1.4 : 0.15) * (k % 2 ? 1 : -1)));
    q4.body.position.y = flying ? Math.sin(now / 260) * 0.06 : 0;

    // Parcel: attached until the DROP action, then it falls to the pad.
    const dropped = dropAct && simT >= dropAct.t;
    q4.parcel.forEach((m) => (m.visible = !dropped));
    fallen.visible = !!dropped;
    if (dropped && dropAct) {
      const k = Math.min(1, (simT - dropAct.t) / 2500);
      const from = at(dropAct.t).p;
      fallen.position.set(from.x, Math.max(1.2, (from.y + 1.6 - 2.7) * (1 - k * k) + 1.2 * k * k), from.z);
    }

    // The person at the drop pad leaves when the gate clears.
    if (dropPad) {
      const leaving = simT >= personLeaves;
      atPad.visible = simT > t0 && (simT < personLeaves + 9000);
      if (leaving) {
        const k = Math.min(1, (simT - personLeaves) / 9000);
        atPad.position.set(dropPad.x + 2.5 + k * 22, 0.65, dropPad.z + 1.5 + k * 8);
        atPad.rotation.y = -Math.PI / 2.5;
      }
    }
    for (const w of walkers) {
      w.a += w.w * dt;
      w.p.position.set(w.c.x + Math.cos(w.a) * w.r, 0.35, w.c.z + Math.sin(w.a) * w.r);
      w.p.rotation.y = -w.a;
    }

    for (const e of events) {
      if (e.done || e.t > simT) continue;
      e.done = true;
      if (e.beacon) e.beacon.visible = true;
      if (e.bad) flash = 1;
      if (e.cap) setCaption(`T+${Math.round((e.t - t0) / 1000)} s`, e.cap.title, e.cap.body, e.cap.tone);
    }
    flash = Math.max(0, flash - dt * 0.7);
    glow.intensity = flash * 60;

    // Trail: draw the path flown so far.
    trailGeo.setDrawRange(0, i + 1);

    sun.position.set(drone.position.x + 60, 140, drone.position.z + 40);
    sun.target.position.copy(drone.position);

    if (camMode === "follow") {
      if (vel.lengthSq() > 1e-4) heading.copy(vel).setY(0).normalize();
      const want = drone.position.clone().add(heading.clone().multiplyScalar(-30)).add(new THREE.Vector3(10, 18, 10));
      want.y = Math.max(want.y, SKYLINE + 8); // stay above the rooftops so the drone is never hidden
      camera.position.lerp(want, 0.05);
      controls.target.lerp(drone.position, 0.12);
    }
    const tr = track[Math.min(i, track.length - 1)];
    q<HTMLElement>(".arena-clock").textContent = `T+${Math.round((simT - t0) / 1000)} s`;
    q<HTMLElement>(".arena-alt").textContent = `ALT ${Math.round(tr.alt)} m${tr.alt > permit.maxAltM ? " ▲ CEILING" : ""}`;
    q<HTMLElement>(".arena-wind").textContent = `WIND ${tr.wind.toFixed(1)} m/s`;
    if (document.activeElement !== slider) slider.value = String(Math.round(((simT - t0) / Math.max(1, t1 - t0)) * 1000));
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => {
          (x as THREE.MeshBasicMaterial).map?.dispose();
          x.dispose();
        });
      });
      renderer.dispose();
      root.innerHTML = "";
    },
  };
}
