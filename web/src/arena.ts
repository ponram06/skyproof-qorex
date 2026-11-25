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

/** The QoreX mark: a dark ring over offset teal and violet rings. */
function qorexMark(g: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const ring = (x: number, y: number, rx: number, ry: number, rot: number, color: string, w: number) => {
    g.beginPath();
    g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
    g.strokeStyle = color;
    g.lineWidth = w;
    g.stroke();
  };
  ring(cx + r * 0.12, cy - r * 0.08, r * 1.02, r * 0.9, -0.5, "rgba(122,108,255,0.7)", r * 0.42);
  ring(cx - r * 0.1, cy + r * 0.1, r * 0.98, r * 0.92, 0.4, "rgba(64,214,214,0.75)", r * 0.42);
  ring(cx, cy, r * 0.82, r * 0.82, 0, "#141420", r * 0.42);
}

/** A QoreX badge texture: the mark and a name on a light plate. */
function brandTex(name: string, sub: string, aspect: number) {
  const c = document.createElement("canvas");
  c.height = 256;
  c.width = Math.round(256 * aspect);
  const g = c.getContext("2d")!;
  g.fillStyle = "#f3effc";
  g.beginPath();
  g.roundRect(6, 6, c.width - 12, c.height - 12, 28);
  g.fill();
  if (!name) {
    qorexMark(g, c.width / 2, c.height / 2, Math.min(c.width, c.height) * 0.3);
  } else {
    const mr = c.height * 0.24;
    qorexMark(g, mr + 40, c.height / 2, mr);
    const x0 = mr * 2 + 70;
    g.fillStyle = "#141420";
    g.textAlign = "left";
    g.textBaseline = "middle";
    let size = 96;
    g.font = `800 ${size}px Inter, system-ui, sans-serif`;
    while (g.measureText(name).width > c.width - x0 - 24 && size > 20) g.font = `800 ${(size -= 4)}px Inter, system-ui, sans-serif`;
    g.fillText(name, x0, sub ? c.height / 2 - 20 : c.height / 2);
    if (sub) {
      g.fillStyle = "#5a4fd6";
      g.font = "600 38px Inter, system-ui, sans-serif";
      g.fillText(sub, x0, c.height / 2 + 52);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function sprite(text: string, color: string) {
  const c = document.createElement("canvas");
  const font = "700 52px ui-monospace, Menlo, Consolas, monospace";
  const m = c.getContext("2d")!;
  m.font = font;
  // wide enough for the whole text, so nothing is cut off
  c.width = Math.max(512, Math.ceil(m.measureText(text).width) + 64);
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(17,17,17,0.85)";
  g.beginPath();
  g.roundRect(8, 20, c.width - 16, 88, 18);
  g.fill();
  g.fillStyle = color;
  g.font = font;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, c.width / 2, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  // drawn on top of everything, so the drone or a building never hides a label
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, depthTest: false }));
  s.renderOrder = 10;
  s.scale.set(32 * (c.width / 512), 8, 1);
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
  // QoreChain branding: a decal on top of the body and on the parcel's sides
  const top = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 2.0), new THREE.MeshBasicMaterial({ map: brandTex("QOREX", "quantum-safe", 3 / 2), transparent: true }));
  top.rotation.x = -Math.PI / 2;
  top.position.y = 0.46;
  g.add(top);
  const sideTex = brandTex("", "", 1.5 / 1.1);
  for (const [x, z, ry] of [[0, 0.77, 0], [0, -0.77, Math.PI], [0.77, 0, Math.PI / 2], [-0.77, 0, -Math.PI / 2]] as const) {
    const sd = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.8), new THREE.MeshBasicMaterial({ map: sideTex, transparent: true }));
    sd.position.set(x, -2.2, z);
    sd.rotation.y = ry;
    parcel.add(sd);
    sd.position.sub(parcel.position);
  }
  return { group: g, props, parcel: [parcel, tape, tether] as THREE.Mesh[], body };
}

/** What the caption card says for an event. */
const BROKE: Record<string, string> = {
  B1_GEOFENCE: "flew into a no-fly zone",
  B2_ALTITUDE: "flew too high",
  B3_UNAPPROVED_ACTION: "acted without asking the safety check",
  B4_OVERRIDE: "ignored the safety check's \"No\"",
  B5_RECORD_BROKEN: "the record was tampered with",
  B6_WIND: "took off in unsafe wind",
};
/** Plain-language explanation of a finding's detail. */
export function plain(f: { rule: string; detail: string }) {
  const act = (a: string) => ({ TAKEOFF: "took off", DROP: "dropped the parcel", LAND: "landed" })[a] ?? a.toLowerCase();
  let m = f.detail.match(/^(\w+) after the safety model said DENY/);
  if (m) return `The safety check said "No", but the operator ${act(m[1])} anyway.`;
  m = f.detail.match(/^took off in ([\d.]+) m\/s wind \(limit ([\d.]+)\)/);
  if (m) return `Wind was ${m[1]} m/s; the permit allows take-off only up to ${m[2]} m/s.`;
  m = f.detail.match(/^(\w+) with no safety decision/);
  if (m) return `The drone ${act(m[1])} without asking the safety check first.`;
  return f.detail[0].toUpperCase() + f.detail.slice(1) + ".";
}

function caption(r: Rec, finding?: { rule: string; detail: string } | { rule: string; detail: string }[]): { title: string; body: string; tone: "ok" | "warn" | "bad" | "info" } | undefined {
  const fs = finding ? (Array.isArray(finding) ? finding : [finding]) : [];
  if (fs.length) {
    const rules = [...new Set(fs.map((f) => BROKE[f.rule] ?? f.rule))];
    return { title: `Rule broken: ${rules.join(" + ")}`, body: `${[...new Set(fs.map(plain))].join(" ")} This is saved in the signed record, so the victim gets paid.`, tone: "bad" };
  }
  if (r.k === "DECISION") {
    if (r.act === "TAKEOFF") return r.ok ? { title: "Safe to take off", body: "The drone asked its safety check first, and got a \"Yes\".", tone: "ok" } : { title: "Too windy to take off", body: "The safety check says \"No\". A safe drone stays on the ground.", tone: "warn" };
    if (r.act === "DROP") return r.ok ? { title: "Drop area is clear", body: "The safety check says \"Yes\". The parcel can be dropped.", tone: "ok" } : { title: "Someone is standing below", body: "Dropping now could hurt them. The safety check says \"No\", so a safe drone waits and asks again.", tone: "warn" };
    if (r.act === "LAND") return { title: r.ok ? "Safe to land" : "Landing not allowed", body: "Back at home base.", tone: r.ok ? "ok" : "warn" };
  }
  if (r.k === "ACTION") {
    if (r.act === "DROP") return { title: "Parcel dropped", body: "This moment is saved in the drone's sealed black box.", tone: "info" };
    if (r.act === "SAFE_STOP") return { title: "Signal lost: landing safely", body: "No answer from the safety check, so the drone does not guess. It lands where it is.", tone: "warn" };
    if (r.act === "TAKEOFF") return { title: "Take-off", body: "From now on, everything the drone does is recorded and locked.", tone: "info" };
  }
  return undefined;
}

export function mountArena(root: HTMLElement, recs: Rec[], permit: Permit, verdict: Verdict, opts: { autoplay?: boolean; compact?: boolean; seed?: number; onBreach?: () => void; onEnd?: () => void } = {}): ArenaHandle {
  root.innerHTML = `<div class="arena ${opts.compact ? "compact" : ""}">
     <div class="arena-main">
      <div class="arena-view"></div>
      <div class="arena-caption"><div class="arena-cap-k">Ready</div><div class="arena-cap-t">Press play</div><div class="arena-cap-b"></div></div>
      <div class="arena-hud"><span class="arena-clock">Time 0 s</span><span class="arena-alt">Height 0 m</span><span class="arena-wind">Wind 0 m/s</span></div>
      <div class="arena-bar">
        <button class="arena-play">Pause</button>
        <input class="arena-time" type="range" min="0" max="1000" value="0" aria-label="Timeline" />
        <div class="arena-seg" role="group" aria-label="Camera">
          <button data-cam="follow" class="on">Follow drone</button><button data-cam="orbit">Free look</button><button data-cam="top">From above</button>
        </div>
      </div>
     </div>
     <div class="arena-side">
      <div class="arena-steps-h">What happens, step by step <span>(click one to jump there)</span></div>
      <ol class="arena-steps"></ol>
      <div class="arena-legend">
        <span><i style="background:#2fbf71"></i>Green beam: safety check said <b>Yes</b></span>
        <span><i style="background:#ff9f1c"></i>Orange beam: safety check said <b>No</b></span>
        <span><i style="background:#ff3b30"></i>Red beam: <b>a rule was broken here</b></span>
        <span><i style="background:#6d4cff"></i>Purple: the drone's route and allowed area</span>
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
  // A safe wait: the person walks off BEFORE the safety check says "Yes", and is clear when it does.
  const firstDeny = dropDecisions.find((d) => !d.ok);
  const lastDeny = [...dropDecisions].reverse().find((d) => !d.ok);
  const waits = !!firstDeny && !!lastAllow && lastAllow.t > firstDeny.t;
  const walkEnd = waits ? lastAllow!.t - 600 : Infinity;
  const walkStart = waits ? Math.max(lastDeny!.t + 800, walkEnd - 6000) : Infinity;

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
  const rand = rng(20261123 + (opts.seed ?? 0) * 7919);
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
  const homeSign = sprite("HOME BASE", "#b9f227");
  homeSign.position.set(track[0].p.x - 14, 34, track[0].p.z - 14);
  homeSign.scale.set(3.25 * (homeSign.scale.x / 8), 3.25, 1);
  scene.add(homeSign);
  if (dropPad) {
    const dropSign = sprite("DELIVERY ADDRESS", "#ffb44d");
    dropSign.position.set(dropPad.x - 8, 26, dropPad.z);
    dropSign.scale.set(3.75 * (dropSign.scale.x / 8), 3.75, 1);
    scene.add(dropSign);
  }
  const ceilSign = sprite(`${permit.maxAltM} m HEIGHT LIMIT`, "#b8a9ff");
  ceilSign.position.set(R * 0.7, ceilY + 3, -R * 0.7); // out at the edge of the permit area
  ceilSign.scale.set(4 * (ceilSign.scale.x / 8), 4, 1);
  scene.add(ceilSign);

  // Windsock at home base: leans with the wind.
  const sockPole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 7, 6), new THREE.MeshLambertMaterial({ color: 0xdddddd }));
  sockPole.position.set(track[0].p.x - 7, 3.5, track[0].p.z - 7);
  const sock = new THREE.Mesh(new THREE.ConeGeometry(0.8, 4, 12, 1, true), new THREE.MeshLambertMaterial({ color: 0xff6a00, side: THREE.DoubleSide }));
  sock.geometry.translate(0, -2, 0);
  sock.position.set(track[0].p.x - 7, 6.8, track[0].p.z - 7);
  scene.add(sockPole, sock);

  // The safety link: a line from the drone to home base (green while the safety check answers).
  const linkGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const linkMat = new THREE.LineDashedMaterial({ color: C.ok, dashSize: 2, gapSize: 1.2, transparent: true, opacity: 0.8 });
  const link = new THREE.Line(linkGeo, linkMat);
  scene.add(link);
  const linkLostAt = recs.find((r) => r.k === "ACTION" && r.act === "SAFE_STOP")?.t;
  const waitSign = sprite("WAITING: SOMEONE IS BELOW", "#ffb44d");
  waitSign.scale.set(3.5 * (waitSign.scale.x / 8), 3.5, 1);
  waitSign.visible = false;
  scene.add(waitSign);
  const clearSign = sprite("CLEAR: SAFE TO DROP", "#3ddc84");
  clearSign.scale.set(3.5 * (clearSign.scale.x / 8), 3.5, 1);
  clearSign.visible = false;
  scene.add(clearSign);
  const lostSign = sprite("SIGNAL LOST", "#ff6b5e");
  lostSign.scale.set(3.25 * (lostSign.scale.x / 8), 3.25, 1);
  lostSign.visible = false;
  scene.add(lostSign);

  // Wind streaks, shown when the wind is over the permit's limit.
  const streaks: THREE.Mesh[] = [];
  const streakMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false });
  for (let i = 0; i < 70; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(6 + rand() * 6, 0.12, 0.12), streakMat);
    m.userData = { ox: (rand() - 0.5) * 120, oy: 2 + rand() * 40, oz: (rand() - 0.5) * 120, v: 30 + rand() * 30 };
    m.visible = false;
    scene.add(m);
    streaks.push(m);
  }

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
  atPad.scale.setScalar(2.3);
  if (dropPad) atPad.position.set(dropPad.x + 1.5, 0.65, dropPad.z + 1);
  atPad.visible = false;
  scene.add(atPad);
  const padRing = new THREE.Mesh(new THREE.RingGeometry(3.2, 4.2, 40), new THREE.MeshBasicMaterial({ color: C.bad, side: THREE.DoubleSide, transparent: true }));
  padRing.rotation.x = -Math.PI / 2;
  padRing.visible = false;
  scene.add(padRing);
  const personSign = sprite("PERSON BELOW", "#ffb44d");
  personSign.scale.set(3 * (personSign.scale.x / 8), 3, 1);
  personSign.visible = false;
  scene.add(personSign);
  const hitSign = sprite("INJURED: HIT BY THE PARCEL", "#ff6b5e");
  hitSign.scale.set(4 * (hitSign.scale.x / 8), 4, 1);
  hitSign.visible = false;
  scene.add(hitSign);

  // Pedestrians along the route, on the pavement either side.
  for (let i = 3; i < track.length; i += 4) {
    const p = track[i].p;
    const side = i % 8 < 4 ? 1 : -1;
    const w = person([0x3a6df0, 0xe0533d, 0x2fbf71, 0x8e44ad, 0xf2b134][i % 5]);
    w.scale.setScalar(1.6);
    scene.add(w);
    walkers.push({ p: w, c: new THREE.Vector3(p.x + side * (9 + rand() * 4), 0, p.z + (rand() - 0.5) * 6), a: rand() * Math.PI * 2, r: 2 + rand() * 3, w: 0.25 + rand() * 0.25 });
  }

  // Cars driving on the roads near the route.
  const cars: { g: THREE.Group; along: "x" | "z"; v: number; u: number; s: number }[] = [];
  const carColors = [0xd7263d, 0x1b998b, 0xf46036, 0x2e294e, 0xe2e2e2, 0x3a86ff];
  const roadsNear = new Set<string>();
  for (const p of pathPts) {
    const vx = Math.round((p.x + span) / BLOCK) * BLOCK - span;
    const vz = Math.round((p.z + span) / BLOCK) * BLOCK - span;
    roadsNear.add(`z:${vx}`);
    roadsNear.add(`x:${vz}`);
  }
  [...roadsNear].slice(0, 12).forEach((key, i) => {
    const [along, v] = key.split(":");
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.2, 2), new THREE.MeshLambertMaterial({ color: carColors[i % carColors.length] }));
    body.position.y = 0.9;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 1.8), new THREE.MeshLambertMaterial({ color: 0x223040 }));
    cab.position.set(-0.2, 1.9, 0);
    body.castShadow = cab.castShadow = true;
    g.add(body, cab);
    if (along === "z") g.rotation.y = Math.PI / 2;
    scene.add(g);
    cars.push({ g, along: along as "x" | "z", v: Number(v) + (i % 2 ? 2 : -2), u: (rand() - 0.5) * span * 2, s: (i % 2 ? 1 : -1) * (6 + rand() * 6) });
  });

  // Gate decisions and breaches as timed events.
  const findings = new Map<number, typeof verdict.findings>();
  for (const f of verdict.findings) if (f.seq !== undefined) findings.set(f.seq, [...(findings.get(f.seq) ?? []), f]);
  type Ev = { r: Rec; t: number; cap?: ReturnType<typeof caption>; beacon?: THREE.Object3D; bad: boolean; done: boolean; hold?: number };
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
  // An accident: the operator dropped while the person was still there. Show it slowly and hold on it.
  const accident = !!dropAct && personLeaves === Infinity;
  const HIT_AT = dropAct ? dropAct.t + 1500 : Infinity;
  if (accident) {
    for (const e of events) if (e.r === dropAct) e.hold = 0; // no pause yet: let the parcel fall
    events.push({
      r: { seq: -1, t: HIT_AT + 1100, k: "HIT" },
      t: HIT_AT + 1100,
      cap: { title: "The parcel hit the person below", body: "They were standing at the drop point, the safety check said \"No\", and the operator dropped anyway. The drone's signed record shows exactly this, so the victim is paid.", tone: "bad" },
      bad: true,
      done: false,
      hold: 5000,
    });
    events.sort((a, b) => a.t - b.t);
  }
  // Too windy: the gust at the drop blows the parcel sideways onto a parked car.
  const windAtDrop = dropAct ? track.reduce((m, s) => (Math.abs(s.t - dropAct.t) < 4000 ? Math.max(m, s.wind) : m), 0) : 0;
  const windHit = !!dropPad && !!dropAct && !accident && windAtDrop > permit.maxWindMs;
  const parked = new THREE.Group();
  const carBody = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.2, 2), new THREE.MeshLambertMaterial({ color: 0x3a86ff }));
  carBody.position.y = 0.9;
  const carCab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 1.8), new THREE.MeshLambertMaterial({ color: 0x223040 }));
  carCab.position.set(-0.2, 1.9, 0);
  const hazards = [-1, 1].map((sd) => {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.5), new THREE.MeshBasicMaterial({ color: 0xffa500 }));
    l.position.set(2.15, 1, sd * 0.7);
    return l;
  });
  carBody.castShadow = carCab.castShadow = true;
  parked.add(carBody, carCab, ...hazards);
  parked.visible = windHit;
  if (dropPad) parked.position.set(dropPad.x + 9, 0, dropPad.z + 4);
  scene.add(parked);
  const carRing = padRing.clone();
  carRing.material = (padRing.material as THREE.MeshBasicMaterial).clone();
  carRing.visible = false;
  scene.add(carRing);
  const carSign = sprite("CAR DAMAGED: PARCEL BLOWN ONTO IT", "#ff6b5e");
  carSign.scale.set(4 * (carSign.scale.x / 8), 4, 1);
  carSign.visible = false;
  scene.add(carSign);
  const CAR_AT = dropAct ? dropAct.t + 2500 : Infinity;
  if (windHit) {
    for (const e of events) if (e.r === dropAct) e.hold = 0;
    events.push({
      r: { seq: -1, t: CAR_AT + 1100, k: "HIT" },
      t: CAR_AT + 1100,
      cap: { title: "A gust blew the parcel onto a parked car", body: `The wind was ${windAtDrop.toFixed(1)} m/s, over the permit's ${permit.maxWindMs} m/s. The safety check said "No" to taking off and the operator flew anyway. The car's owner files a claim; the signed record proves the unsafe take-off, so they are paid.`, tone: "bad" },
      bad: true,
      done: false,
      hold: 5000,
    });
    events.sort((a, b) => a.t - b.t);
  }

  // ---- step list: every captioned moment, repeats folded into one row -----------------------
  type Step = { t: number; title: string; body: string; tone: string; n: number; evs: Ev[] };
  const steps: Step[] = [];
  for (const e of events) {
    if (!e.cap) continue;
    const lastStep = steps[steps.length - 1];
    if (lastStep && lastStep.title === e.cap.title && !e.bad) {
      lastStep.n++;
      lastStep.evs.push(e);
    } else steps.push({ t: e.t, title: e.cap.title, body: e.cap.body, tone: e.cap.tone, n: 1, evs: [e] });
  }
  const stepList = q<HTMLOListElement>(".arena-steps");
  stepList.innerHTML = steps
    .map(
      (st, k) => `<li class="tone-${st.tone}" data-step="${k}"><span class="arena-step-t">${Math.round((st.t - t0) / 1000)} s</span><span><b>${st.title}</b>${st.n > 1 ? ` <em>(${st.n} times)</em>` : ""}<span class="arena-step-b">${st.body}</span></span></li>`,
    )
    .join("");
  let shownStep = -1;
  const markStep = (e: Ev) => {
    const k = steps.findIndex((st) => st.evs.includes(e));
    if (k < 0 || k === shownStep) return;
    shownStep = k;
    stepList.querySelectorAll("li").forEach((li, j) => {
      li.classList.toggle("now", j === k);
      li.classList.toggle("past", j < k);
    });
    const li = stepList.children[k] as HTMLElement | undefined;
    if (li) stepList.scrollTop = li.offsetTop - stepList.offsetTop - 40;
  };

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
    // The step panel is exactly as tall as the 3D view and its controls (beside it on wide screens).
    requestAnimationFrame(() => {
      const side = root.querySelector<HTMLElement>(".arena-side");
      const main = root.querySelector<HTMLElement>(".arena-main");
      // Beside the view (same top): match its height. Below it: let it size itself.
      if (side && main) side.style.height = side.offsetTop === main.offsetTop ? `${main.offsetHeight}px` : "";
    });
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(view);

  // ---- controls -----------------------------------------------------------------------
  let simT = t0;
  let playing = opts.autoplay !== false;
  const speed = 8; // slow enough to follow every step
  let flash = 0;
  /** Real-time moment until which playback holds still, so a broken rule can be read. */
  let holdUntil = 0;
  const firstBad = verdict.findings[0];
  const allBroke = [...new Set(verdict.findings.map((f) => BROKE[f.rule] ?? f.rule))];
  const summary = verdict.breach
    ? { title: "Flight over: a rule was broken", body: `The operator ${firstBad ? allBroke.join(" and ") : "broke a safety rule"}. The signed record proves it, so the victim is paid from the operator's deposit.`, tone: "bad" }
    : recs.some((r) => r.k === "ACTION" && r.act === "SAFE_STOP")
      ? { title: "Flight over: signal lost, landed safely", body: "With no answer from its safety check, the drone didn't guess or drop the parcel. It landed where it was. No rule broken, nothing to pay.", tone: "ok" }
      : { title: "Flight over: every rule followed", body: "The drone asked before every risky move and obeyed every answer. Nothing to pay.", tone: "ok" };
  const play = q<HTMLButtonElement>(".arena-play");
  const slider = q<HTMLInputElement>(".arena-time");
  play.textContent = playing ? "Pause" : "Play";
  play.onclick = () => {
    if (simT >= t1) seek(t0);
    playing = !playing;
    play.textContent = playing ? "Pause" : "Play";
  };
  slider.oninput = () => seek(t0 + ((t1 - t0) * Number(slider.value)) / 1000);
  stepList.querySelectorAll<HTMLLIElement>("[data-step]").forEach((li) =>
    li.addEventListener("click", () => {
      seek(Math.max(t0, steps[Number(li.dataset.step)].t - 1500));
      playing = true;
      play.textContent = "Pause";
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
  setCaption("Start", "A parcel delivery", "Watch the drone ask its safety check before every risky move.", "info");

  function seek(t: number) {
    simT = t;
    holdUntil = 0;
    shownStep = -1;
    stepList.querySelectorAll("li").forEach((li) => li.classList.remove("now", "past"));
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
    if (holdUntil && now >= holdUntil) {
      holdUntil = 0;
      q<HTMLElement>(".arena-cap-k").textContent = "Rule broken here. Playing on…";
    }
    const slowWait = waits && simT > firstDeny!.t - 2000 && simT < (dropAct ? dropAct.t + 2500 : walkEnd);
    const slowmo = slowWait || (accident && simT > dropAct!.t - 2500 && simT < HIT_AT + 1500) || (windHit && simT > dropAct!.t - 2500 && simT < CAR_AT + 1500);
    if (playing && now >= holdUntil) simT = Math.min(t1, simT + dt * 1000 * (slowmo ? (slowWait ? 2.5 : 1) : speed));
    if (simT >= t1 && playing && now >= holdUntil && events.every((e) => e.done)) {
      playing = false;
      play.textContent = "Replay";
      setCaption("End of flight", summary.title, summary.body, summary.tone);
      opts.onEnd?.();
    }
    const { p, i } = at(simT);
    const flying = p.y > 0.3;
    drone.position.set(p.x, p.y + 1.6, p.z);
    const vel = p.clone().sub(prev);
    if (vel.lengthSq() > 1e-4) drone.rotation.y = Math.atan2(-vel.z, vel.x);
    drone.rotation.z = flying ? Math.min(0.18, vel.length() * 0.6) * -1 : 0;
    // Wind: the drone is pushed about, more as the wind grows; past the permit's limit it lurches in gusts.
    if (flying) {
      const w = track[Math.min(i, track.length - 1)].wind;
      const k = Math.max(0, (w - 5) / 10); // 0 when calm, ~1 at 15 m/s
      const over = w > permit.maxWindMs ? 1 : 0;
      const gust = over * Math.max(0, Math.sin(now / 900)) ** 6; // a sharp shove every few seconds
      const n1 = Math.sin(now / 97) + 0.6 * Math.sin(now / 41 + 1.3);
      const n2 = Math.sin(now / 113 + 2.1) + 0.6 * Math.sin(now / 37);
      drone.position.x += k * (0.5 * n1 + 3 * gust);
      drone.position.z += k * 0.5 * n2;
      drone.position.y += k * 0.4 * Math.sin(now / 71) - gust * 1.2;
      drone.rotation.z += k * (0.12 * n1) - gust * 0.45;
      drone.rotation.x = k * 0.12 * n2;
    } else drone.rotation.x = 0;
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
      if (windHit) {
        // blown sideways as it falls, landing on the car's roof
        const kk = Math.min(1, (simT - dropAct.t) / (CAR_AT - dropAct.t));
        const e = kk * kk;
        fallen.position.set(from.x + (parked.position.x - from.x) * e, Math.max(2.9, (from.y + 1.6 - 2.7) * (1 - e) + 2.9 * e), from.z + (parked.position.z - from.z) * e);
        fallen.rotation.set(kk * 5, kk * 3, kk * 4);
      }
    }
    if (windHit) {
      const smash = simT > CAR_AT;
      carCab.scale.y = smash ? 0.45 : 1;
      carCab.position.y = smash ? 1.7 : 1.9;
      hazards.forEach((l) => (l.visible = smash && Math.sin(now / 150) > 0));
      carSign.visible = smash;
      carSign.position.set(parked.position.x, 9, parked.position.z + 6);
      carRing.visible = smash;
      if (smash) {
        carRing.position.set(parked.position.x, 0.5, parked.position.z);
        (carRing.material as THREE.MeshBasicMaterial).color.setHex(C.bad);
        carRing.scale.setScalar(1.6 + 0.2 * Math.sin(now / 200));
      }
    }

    // The person at the drop pad leaves when the gate clears.
    if (dropPad) {
      if (waits) {
        // stands at the drop point, then walks clear (with a stepping bob) before the "Yes"
        atPad.visible = simT > t0 && simT < walkEnd + 8000;
        const k = Math.min(1, Math.max(0, (simT - walkStart) / (walkEnd - walkStart)));
        const walking = k > 0 && k < 1;
        atPad.position.set(dropPad.x + 1.5 + k * 16, 0.65 + (walking ? Math.abs(Math.sin(now / 120)) * 0.35 : 0), dropPad.z + 1 + k * 6);
        atPad.rotation.y = k > 0 ? -Math.PI / 2.5 : 0;
        const dp = drone.position;
        waitSign.visible = simT >= firstDeny!.t && simT < lastAllow!.t;
        waitSign.position.set(dp.x, dp.y + 8, dp.z);
        clearSign.visible = simT >= lastAllow!.t && (!dropAct || simT < dropAct.t + 2500);
        clearSign.position.set(dp.x, dp.y + 8, dp.z);
      } else {
        const leaving = simT >= personLeaves;
        atPad.visible = simT > t0 && (simT < personLeaves + 9000);
        if (leaving) {
          const k = Math.min(1, (simT - personLeaves) / 9000);
          atPad.position.set(dropPad.x + 2.5 + k * 22, 0.65, dropPad.z + 1.5 + k * 8);
          atPad.rotation.y = -Math.PI / 2.5;
        }
      }
    }
    // Person below: ring + label while they stand there; hit if the parcel lands on them.
    if (dropPad) {
      const there = atPad.visible && simT < (waits ? walkEnd : personLeaves);
      const hit = accident && simT > HIT_AT;
      const fall = hit ? Math.min(1, (simT - HIT_AT) / 900) : 0;
      padRing.visible = there || hit;
      padRing.position.set(atPad.position.x, 0.5, atPad.position.z);
      (padRing.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.5 * Math.sin(now / 180);
      personSign.visible = there && !hit;
      personSign.position.set(atPad.position.x + 6, 10, atPad.position.z);
      hitSign.visible = hit;
      hitSign.position.set(atPad.position.x, 7, atPad.position.z + 8);
      atPad.rotation.z = (-Math.PI / 2) * fall;
      atPad.position.y = 0.65 + 0.55 * fall;
      if (hit) {
        (padRing.material as THREE.MeshBasicMaterial).color.setHex(C.bad);
        padRing.scale.setScalar(1.3 + 0.2 * Math.sin(now / 200));
      }
    }
    // Wind: streaks and the windsock.
    const windNow = track[Math.min(i, track.length - 1)].wind;
    const gusty = windNow > permit.maxWindMs;
    sock.rotation.z = -Math.min(1, windNow / 15) * (Math.PI / 2.2) + Math.sin(now / 300) * 0.05 * windNow / 10;
    for (const m of streaks) {
      m.visible = gusty;
      if (!gusty) continue;
      const d = m.userData as { ox: number; oy: number; oz: number; v: number };
      d.ox += d.v * dt;
      if (d.ox > 60) d.ox -= 120;
      m.position.set(drone.position.x + d.ox, Math.max(1, drone.position.y - 15 + d.oy), drone.position.z + d.oz);
    }
    // Height limit: the ceiling turns red while the drone is above it.
    const tooHigh = track[Math.min(i, track.length - 1)].alt > permit.maxAltM;
    (ceiling.material as THREE.MeshBasicMaterial).color.setHex(tooHigh ? C.bad : C.violet);
    (ceiling.material as THREE.MeshBasicMaterial).opacity = tooHigh ? 0.22 : 0.06;
    // Safety link to home base.
    const lost = linkLostAt !== undefined && simT >= (recs.filter((r) => r.k === "DECISION").pop()?.t ?? t0) + 4000;
    linkGeo.setFromPoints([drone.position.clone(), new THREE.Vector3(track[0].p.x, 2, track[0].p.z)]);
    link.computeLineDistances();
    linkMat.color.setHex(lost ? C.bad : C.ok);
    linkMat.opacity = lost ? 0.35 + 0.35 * Math.sin(now / 150) : 0.5;
    lostSign.visible = lost && simT < t1;
    lostSign.position.set(drone.position.x, drone.position.y + 7, drone.position.z);
    // Cars.
    for (const c of cars) {
      c.u += c.s * dt;
      if (c.u > span) c.u = -span;
      if (c.u < -span) c.u = span;
      c.g.position.set(c.along === "x" ? c.u : c.v, 0, c.along === "x" ? c.v : c.u);
      c.g.rotation.y = (c.along === "z" ? Math.PI / 2 : 0) + (c.s < 0 ? Math.PI : 0);
    }
    for (const w of walkers) {
      w.a += w.w * dt;
      w.p.position.set(w.c.x + Math.cos(w.a) * w.r, 0.35, w.c.z + Math.sin(w.a) * w.r);
      w.p.rotation.y = -w.a;
    }

    for (const e of events) {
      if (now < holdUntil) break; // keep the broken rule on screen
      if (e.done || e.t > simT) continue;
      e.done = true;
      if (e.beacon) e.beacon.visible = true;
      if (e.cap) {
        setCaption(e.bad && e.hold !== 0 ? "Paused: this is the moment" : `${Math.round((e.t - t0) / 1000)} s into the flight`, e.cap.title, e.cap.body, e.cap.tone);
        markStep(e);
      }
      if (e.bad) {
        flash = 1;
        opts.onBreach?.();
        if (playing) holdUntil = now + (e.hold ?? 4000); // hold on the breach
        break;
      }
    }
    flash = Math.max(0, flash - dt * 0.7);
    glow.intensity = flash * 60;

    // Trail: draw the path flown so far.
    trailGeo.setDrawRange(0, i + 1);

    sun.position.set(drone.position.x + 60, 140, drone.position.z + 40);
    sun.target.position.copy(drone.position);

    const watchAccident = camMode === "follow" && (slowWait || (accident && simT > dropAct!.t - 2500 && simT < HIT_AT + 4000) || (windHit && simT > dropAct!.t - 2500 && simT < CAR_AT + 4000));
    if (watchAccident) {
      const pp = windHit ? parked.position : slowWait && dropPad ? dropPad : atPad.position;
      camera.position.lerp(new THREE.Vector3(pp.x + 26, pp.y + 34, pp.z + 26), 0.06); // from the side and above: the drone doesn't cover the person
      controls.target.lerp(new THREE.Vector3(pp.x, pp.y + 2, pp.z), 0.1);
    } else if (camMode === "follow") {
      if (vel.lengthSq() > 1e-4) heading.copy(vel).setY(0).normalize();
      const want = drone.position.clone().add(heading.clone().multiplyScalar(-30)).add(new THREE.Vector3(10, 18, 10));
      want.y = Math.max(want.y, SKYLINE + 8); // stay above the rooftops so the drone is never hidden
      camera.position.lerp(want, 0.05);
      controls.target.lerp(drone.position, 0.12);
    }
    const tr = track[Math.min(i, track.length - 1)];
    q<HTMLElement>(".arena-clock").textContent = `Time ${Math.round((simT - t0) / 1000)} s`;
    q<HTMLElement>(".arena-alt").textContent = `Height ${Math.round(tr.alt)} m${tr.alt > permit.maxAltM ? " ▲ too high" : ""}`;
    q<HTMLElement>(".arena-wind").textContent = `Wind ${tr.wind.toFixed(1)} m/s`;
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
