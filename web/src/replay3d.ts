/**
 * 3D replay of a flight record (three.js): a city block, the permit's area,
 * no-fly zone and altitude ceiling, the drone flying the recorded path, the
 * safety gate's decisions as beacons, a person at the drop pad while the gate
 * says DENY, and a red flash at every breach the judge found.
 *
 * Units: 1 scene unit = 10 m. x = east, y = up, z = south.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Permit, Verdict } from "../../rollup/src/rules";

export type Rec = { seq: number; t: number; k: string; lat?: number; lon?: number; alt?: number; wind?: number; act?: string; ok?: boolean; req?: string };

const U = 10; // metres per unit
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";

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

export interface ReplayHandle {
  dispose(): void;
}

export function mountReplay(root: HTMLElement, recs: Rec[], permit: Permit, verdict: Verdict): ReplayHandle {
  root.innerHTML = `<div class="r3d">
      <div class="r3d-view"></div>
      <div class="r3d-hud"><b class="r3d-clock">0 s</b><span class="r3d-alt"></span><span class="r3d-event"></span></div>
      <div class="r3d-bar">
        <button class="r3d-play primary">Pause</button>
        <input class="r3d-time" type="range" min="0" max="1000" value="0" aria-label="Timeline" />
        <select class="r3d-speed" aria-label="Speed"><option value="4">4×</option><option value="10" selected>10×</option><option value="25">25×</option></select>
        <label class="r3d-follow"><input type="checkbox" class="r3d-chase" checked /> Follow drone</label>
      </div>
      <ol class="r3d-log"></ol>
    </div>`;
  const view = root.querySelector<HTMLElement>(".r3d-view")!;
  const q = <T extends Element>(s: string) => root.querySelector<T>(s)!;

  // ---- geometry from the record -------------------------------------------------
  const o = permit.area;
  const toXZ = (lat: number, lon: number) =>
    [((lon - o.lon) * 111_320 * Math.cos((o.lat * Math.PI) / 180)) / U, (-(lat - o.lat) * 111_320) / U] as const;
  const samples = recs.filter((r) => r.k === "SAMPLE" && r.lat !== undefined);
  const track = samples.map((s) => ({ t: s.t, p: new THREE.Vector3(toXZ(s.lat!, s.lon!)[0], (s.alt ?? 0) / U, toXZ(s.lat!, s.lon!)[1]), alt: s.alt ?? 0 }));
  if (track.length === 0) {
    view.textContent = "No position samples in this record.";
    return { dispose() {} };
  }
  const t0 = recs[0].t;
  const t1 = recs[recs.length - 1].t;
  const posAt = (t: number) => {
    if (t <= track[0].t) return track[0].p.clone();
    for (let i = 1; i < track.length; i++)
      if (t <= track[i].t) return track[i - 1].p.clone().lerp(track[i].p, (t - track[i - 1].t) / Math.max(1, track[i].t - track[i - 1].t));
    return track[track.length - 1].p.clone();
  };
  const dropRec = recs.find((r) => r.k === "ACTION" && r.act === "DROP");
  const dropDecisions = recs.filter((r) => r.k === "DECISION" && r.act === "DROP");
  const padDrop = dropRec ? posAt(dropRec.t) : dropDecisions[0] ? posAt(dropDecisions[0].t) : undefined;
  const lastAllow = [...dropDecisions].reverse().find((d) => d.ok);
  const personUntil = dropDecisions.some((d) => !d.ok) ? (lastAllow ? lastAllow.t : Infinity) : -Infinity;

  // ---- scene ---------------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(css("--panel"));
  scene.fog = new THREE.Fog(scene.background as THREE.Color, 300, 900);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 3000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  view.appendChild(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.48;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(150, 300, 100);
  scene.add(sun);

  const R = o.r / U;
  const ground = new THREE.Mesh(new THREE.CircleGeometry(R * 1.25, 96), new THREE.MeshLambertMaterial({ color: css("--bg") }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const ring = new THREE.Mesh(new THREE.RingGeometry(R - 0.6, R + 0.6, 128), new THREE.MeshBasicMaterial({ color: css("--ok"), side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  scene.add(ring);

  const ceilY = permit.maxAltM / U;
  const ceiling = new THREE.Mesh(new THREE.CircleGeometry(R, 96), new THREE.MeshBasicMaterial({ color: css("--accent"), transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }));
  ceiling.rotation.x = -Math.PI / 2;
  ceiling.position.y = ceilY;
  scene.add(ceiling);

  for (const z of permit.noFly) {
    const [x, zz] = toXZ(z.lat, z.lon);
    const col = new THREE.Mesh(
      new THREE.CylinderGeometry(z.r / U, z.r / U, ceilY * 1.6, 64, 1, true),
      new THREE.MeshBasicMaterial({ color: css("--bad"), transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
    );
    col.position.set(x, (ceilY * 1.6) / 2, zz);
    scene.add(col);
  }

  // City: seeded blocks, kept clear of the flight path and the pads.
  const rand = rng(42);
  const pathPts = track.map((s) => s.p);
  const nearPath = (x: number, z: number, d: number) => pathPts.some((p) => Math.hypot(p.x - x, p.z - z) < d);
  const blockMat = new THREE.MeshLambertMaterial({ color: css("--line") });
  for (let gx = -R; gx <= R; gx += 18)
    for (let gz = -R; gz <= R; gz += 18) {
      const x = gx + (rand() - 0.5) * 6;
      const z = gz + (rand() - 0.5) * 6;
      if (Math.hypot(x, z) > R * 0.97 || nearPath(x, z, 14) || rand() < 0.25) continue;
      const h = 1.5 + rand() * 5;
      const b = new THREE.Mesh(new THREE.BoxGeometry(7 + rand() * 5, h, 7 + rand() * 5), blockMat);
      b.position.set(x, h / 2, z);
      scene.add(b);
    }

  const pad = (p: THREE.Vector3, color: string) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 0.3, 32), new THREE.MeshLambertMaterial({ color }));
    m.position.set(p.x, 0.15, p.z);
    scene.add(m);
  };
  pad(track[0].p, css("--ok"));
  if (padDrop) pad(padDrop, css("--warn"));

  // Planned/recorded path, drawn as the drone flies it.
  const lineGeo = new THREE.BufferGeometry().setFromPoints(pathPts);
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: css("--accent") }));
  scene.add(line);

  // Drone: body + four rotors.
  const drone = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.6, 2.2), new THREE.MeshLambertMaterial({ color: css("--ink") }));
  drone.add(body);
  const rotors: THREE.Mesh[] = [];
  for (const [dx, dz] of [[1.6, 1.6], [-1.6, 1.6], [1.6, -1.6], [-1.6, -1.6]]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.15, 2.4), body.material);
    arm.position.set(dx / 2, 0, dz / 2);
    arm.lookAt(new THREE.Vector3(dx, 0, dz));
    drone.add(arm);
    const r = new THREE.Mesh(new THREE.BoxGeometry(2, 0.06, 0.25), new THREE.MeshLambertMaterial({ color: css("--accent") }));
    r.position.set(dx, 0.4, dz);
    drone.add(r);
    rotors.push(r);
  }
  const glow = new THREE.PointLight(0xff3b30, 0, 60);
  drone.add(glow);
  drone.scale.setScalar(2.2); // a real drone is under a metre: drawn larger so it reads at city scale
  scene.add(drone);

  // Person at the drop pad (while the gate says DENY).
  const person = new THREE.Group();
  const pm = new THREE.MeshLambertMaterial({ color: css("--warn") });
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.4, 16), pm);
  torso.position.y = 0.9;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 12), pm);
  head.position.y = 2;
  person.add(torso, head);
  person.scale.setScalar(1.6);
  if (padDrop) person.position.set(padDrop.x + 5, 0, padDrop.z + 3);
  person.visible = false;
  scene.add(person);

  // Decisions and breaches as timed events.
  const bad = new Map(verdict.findings.filter((f) => f.seq !== undefined).map((f) => [f.seq!, f]));
  type Ev = { t: number; text: string; cls: string; at: THREE.Vector3; mark?: THREE.Object3D; breach: boolean; shown: boolean };
  const events: Ev[] = [];
  for (const r of recs) {
    const f = bad.get(r.seq);
    if (r.k === "DECISION" || r.k === "ACTION" || f) {
      const at = posAt(r.t);
      const text = f ? `${f.rule.replace("_", " ")}: ${f.detail}` : r.k === "DECISION" ? `gate: ${r.act} ${r.ok ? "ALLOW" : "DENY"}` : `action: ${r.act}`;
      const cls = f ? "bad" : r.k === "DECISION" ? (r.ok ? "ok" : "warn") : "";
      let mark: THREE.Object3D | undefined;
      if (r.k === "DECISION" || f) {
        const color = f ? css("--bad") : r.ok ? css("--ok") : css("--warn");
        mark = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, Math.max(at.y, 1) + 6, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }));
        mark.position.set(at.x + (f ? 0.6 : 0), (Math.max(at.y, 1) + 6) / 2, at.z);
        mark.visible = false;
        scene.add(mark);
      }
      events.push({ t: r.t, text, cls, at, mark, breach: !!f, shown: false });
    }
  }
  // Findings without a record number (e.g. a withheld segment) are listed up front.
  for (const f of verdict.findings.filter((x) => x.seq === undefined)) events.push({ t: t0, text: `${f.rule.replace("_", " ")}: ${f.detail}`, cls: "bad", at: track[0].p, breach: true, shown: false });

  // ---- camera, resize, playback -----------------------------------------------------
  // Frame the route, not the whole permitted area.
  const box = new THREE.Box3().setFromPoints(pathPts);
  const centre = box.getCenter(new THREE.Vector3());
  const span = Math.max(40, box.getSize(new THREE.Vector3()).length());
  camera.position.set(centre.x + span * 0.55, span * 0.55, centre.z + span * 0.75);
  controls.target.copy(centre);
  const chase = q<HTMLInputElement>(".r3d-chase");
  const chaseOffset = new THREE.Vector3(22, 26, 22); // above the no-fly column, so the view never sits inside it
  const resize = () => {
    const w = view.clientWidth || 600;
    const h = Math.max(320, Math.round(w * 0.6));
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(view);

  let simT = t0;
  let playing = true;
  let flash = 0;
  const play = q<HTMLButtonElement>(".r3d-play");
  const slider = q<HTMLInputElement>(".r3d-time");
  const speed = q<HTMLSelectElement>(".r3d-speed");
  const log = q<HTMLOListElement>(".r3d-log");
  play.onclick = () => {
    if (simT >= t1) seek(t0);
    playing = !playing;
    play.textContent = playing ? "Pause" : "Play";
  };
  slider.oninput = () => seek(t0 + ((t1 - t0) * Number(slider.value)) / 1000);

  function seek(t: number) {
    simT = t;
    log.innerHTML = "";
    for (const e of events) {
      e.shown = false;
      if (e.mark) e.mark.visible = false;
    }
  }

  let last = performance.now();
  let raf = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing) simT = Math.min(t1, simT + dt * 1000 * Number(speed.value));
    if (simT >= t1 && playing) {
      playing = false;
      play.textContent = "Replay";
    }
    const p = posAt(simT);
    drone.position.copy(p).setY(p.y + 0.4);
    const spin = p.y > 0.2 ? 0.9 : 0.05;
    rotors.forEach((r, i) => (r.rotation.y += spin * (i % 2 ? 1 : -1)));
    person.visible = !!padDrop && simT < personUntil && simT > t0;

    for (const e of events) {
      if (e.shown || e.t > simT) continue;
      e.shown = true;
      if (e.mark) e.mark.visible = true;
      if (e.breach) flash = 1;
      const li = document.createElement("li");
      li.className = e.cls;
      li.textContent = `${Math.round((e.t - t0) / 1000)} s · ${e.text}`;
      log.prepend(li);
      q<HTMLElement>(".r3d-event").textContent = e.text;
    }
    flash = Math.max(0, flash - dt * 0.8);
    glow.intensity = flash * 40;
    (body.material as THREE.MeshLambertMaterial).emissive.setRGB(flash, 0, 0);

    q<HTMLElement>(".r3d-clock").textContent = `${Math.round((simT - t0) / 1000)} s`;
    q<HTMLElement>(".r3d-alt").textContent = `alt ${Math.round(p.y * U)} m${p.y * U > permit.maxAltM ? " (above ceiling)" : ""}`;
    if (document.activeElement !== slider) slider.value = String(Math.round(((simT - t0) / Math.max(1, t1 - t0)) * 1000));
    if (chase.checked) {
      // Ease the camera behind the drone, keeping the orbit controls usable when it is off.
      controls.target.lerp(drone.position, 0.12);
      camera.position.lerp(drone.position.clone().add(chaseOffset), 0.06);
    }
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
      renderer.dispose();
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
      });
      root.innerHTML = "";
    },
  };
}
