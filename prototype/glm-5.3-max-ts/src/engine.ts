/* ------------------------------------------------------------------
   Rotary Valve Matrix — geometry, air-domain queries and particles
   All sizes are in logical pixels on a SIZE x SIZE square canvas.
-------------------------------------------------------------------*/

export const N = 10; // grid is N x N cells
export const S = 72; // cell (housing) size
export const SIZE = N * S;

export const RV = S * 0.435; // valve radius
export const CW = RV * 0.44; // air channel width (identical in valve + housing)
export const WALL = RV * 0.135; // material thickness of tube / chamber walls
export const EDGE = 1.95; // dark cut outline thickness
export const ELBOW = RV * 0.5; // radius of the rounded L-elbow centreline
export const TAU = Math.PI * 2;

export const DX = [1, 0, -1, 0]; // E, S, W, N
export const DY = [0, 1, 0, -1];
export const PORT_ANG = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

/** A piece of the air (flow) region, expressed in the valve's local frame. */
export type Prim =
  | { t: 0; ax: number; ay: number; bx: number; by: number } // straight tube
  | { t: 1; r: number; mid: number; span: number } // arc tube (rounded elbow)
  | { t: 2; r: number }; // circular cavity (hollow valve)

export interface Valve {
  i: number;
  j: number;
  cx: number;
  cy: number;
  kind: "solid" | "hollow";
  ports: number[];
  prims: Prim[];
  path: Path2D;
  chamberR: number; // 0 for solid valves
  solidCenter: boolean;
  // rotation state
  angle: number;
  from: number;
  delta: number;
  t: number;
  dur: number;
  dwell: number;
  omega: number;
  // colours
  bodyHi: string;
  bodyLo: string;
  tileHi: string;
  tileLo: string;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
  rim: string;
  stuck: number;
}

export interface World {
  valves: Valve[];
  particles: Particle[];
}

/* ----------------------------- helpers ---------------------------- */

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(arr: T[]): T => arr[(Math.random() * arr.length) | 0];

function hsl(h: number, s: number, l: number) {
  return `hsl(${h.toFixed(1)}, ${s.toFixed(1)}%, ${l.toFixed(1)}%)`;
}

function rot(x: number, y: number, a: number) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: x * c - y * s, y: x * s + y * c };
}

/* --------------------------- valve shapes ------------------------- */
/*
  Port indices: 0 = East(+x) 1 = South(+y) 2 = West(-x) 3 = North(-y)
  Solid valve  : metal disc, only a tube machined through it.
  Hollow valve : metal disc with an empty cavity (ball/flask) inside,
                 plus a number of outlets running from cavity to rim.
*/

const SOLID_SHAPES: number[][] = [
  [0, 2], // straight through
  [0, 3], // L
  [0, 1, 2], // T
  [0, 1, 2, 3], // X
  [0], // blind pocket
  [], // blank plug
  [0], // (extra weight on pocket)
];

const HOLLOW_SHAPES: number[][] = [
  [0], // one outlet
  [0, 2], // two opposite
  [0, 3], // two adjacent
  [0, 1, 2], // three
  [0, 1, 2, 3], // four
  [0, 1, 2, 3],
];

const adjacent = (a: number, b: number) => {
  const d = Math.abs(a - b);
  return d === 1 || d === 3;
};

function buildPrims(ports: number[], kind: "solid" | "hollow", base: number, chamberR: number) {
  const prims: Prim[] = [];
  const path = new Path2D();

  const addSeg = (ax: number, ay: number, bx: number, by: number) => {
    const a = rot(ax, ay, base);
    const b = rot(bx, by, base);
    prims.push({ t: 0, ax: a.x, ay: a.y, bx: b.x, by: b.y });
    path.moveTo(a.x, a.y);
    path.lineTo(b.x, b.y);
  };

  if (kind === "hollow") {
    prims.push({ t: 2, r: chamberR });
    for (const p of ports) addSeg(0, 0, DX[p] * RV, DY[p] * RV);
    return { prims, path };
  }

  const has = (p: number) => ports.indexOf(p) >= 0;
  const two = ports.length === 2;

  if (two && adjacent(ports[0], ports[1])) {
    /* ---- rounded L: two legs + an arc concentric with the valve ---- */
    const [p, q] = ports;
    const angP = PORT_ANG[p] + base;
    const angQ = PORT_ANG[q] + base;
    // the arc sweeps the short way between the two port directions
    let d = angQ - angP;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    const ccw = d < 0;
    const mid = angP + d / 2;

    const a1 = rot(DX[p] * RV, DY[p] * RV, base);
    const a2 = rot(DX[p] * ELBOW, DY[p] * ELBOW, base);
    const b2 = rot(DX[q] * ELBOW, DY[q] * ELBOW, base);
    const b1 = rot(DX[q] * RV, DY[q] * RV, base);

    prims.push({ t: 0, ax: a1.x, ay: a1.y, bx: a2.x, by: a2.y });
    prims.push({ t: 1, r: ELBOW, mid, span: Math.PI / 2 });
    prims.push({ t: 0, ax: b2.x, ay: b2.y, bx: b1.x, by: b1.y });

    path.moveTo(a1.x, a1.y);
    path.lineTo(a2.x, a2.y);
    path.arc(0, 0, ELBOW, angP, angQ, ccw);
    path.lineTo(b1.x, b1.y);
    return { prims, path };
  }

  /* ---- straight pairs (I / T / X) and blind pockets ---- */
  if (has(0) || has(2)) {
    const x0 = has(2) ? -RV : 0;
    const x1 = has(0) ? RV : 0;
    if (x1 !== x0) addSeg(x0, 0, x1, 0);
  }
  if (has(1) || has(3)) {
    const y0 = has(3) ? -RV : 0;
    const y1 = has(1) ? RV : 0;
    if (y1 !== y0) addSeg(0, y0, 0, y1);
  }
  return { prims, path };
}

/** Does the opening of a valve cover the point (x,y) in its own frame? */
function primCovers(prims: Prim[], x: number, y: number, h: number) {
  for (const pr of prims) {
    if (pr.t === 2) {
      if (Math.hypot(x, y) <= pr.r) return true;
    } else if (pr.t === 1) {
      if (Math.abs(Math.hypot(x, y) - pr.r) <= h) return true;
    } else if (distSeg(x, y, pr.ax, pr.ay, pr.bx, pr.by) <= h) {
      return true;
    }
  }
  return false;
}

function makeValve(i: number, j: number): Valve {
  const kind: "solid" | "hollow" = Math.random() < 0.4 ? "hollow" : "solid";
  const shape = kind === "hollow" ? pick(HOLLOW_SHAPES) : pick(SOLID_SHAPES);
  // rotate the whole shape by a random multiple of 90 degrees
  const base = ((Math.random() * 4) | 0) * (Math.PI / 2);
  const chamberR = kind === "hollow" ? RV * rnd(0.3, 0.42) : 0;
  const { prims, path } = buildPrims(shape, kind, base, chamberR);

  const hv = rnd(-12, 12);
  const hs = rnd(5, 11);
  const hl = rnd(43, 56);
  const vh = rnd(-10, 10);
  const vl = rnd(23, 31);

  return {
    i,
    j,
    cx: (i + 0.5) * S,
    cy: (j + 0.5) * S,
    kind,
    ports: shape,
    prims,
    path,
    chamberR,
    solidCenter: !primCovers(prims, 0, 0, CW / 2),
    angle: 0,
    from: 0,
    delta: 0,
    t: 1,
    dur: 1,
    dwell: rnd(0.2, 3.4),
    omega: 0,
    bodyHi: hsl(214 + vh, hs, vl + 8),
    bodyLo: hsl(214 + vh, hs, vl),
    tileHi: hsl(210 + hv, hs, hl + 5),
    tileLo: hsl(210 + hv, hs, hl - 5),
  };
}

export function createWorld(): World {
  const valves: Valve[] = [];
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) valves.push(makeValve(i, j));
  return { valves, particles: [] };
}

/* --------------------------- air queries -------------------------- */
/*
  "Air" = everything a particle may occupy:
    * the four channels milled through a housing (outside the bore)
    * the tube bores of solid valves
    * the cavity + outlets of hollow valves
  `s` erodes the region by the particle radius so a point is only air
  when the whole particle fits.
*/

function distSeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy);
}

export function isAir(w: World, x: number, y: number, s: number): boolean {
  if (x < 0.5 || x > SIZE - 0.5 || y < -30 || y > SIZE + 30) return false;
  const h0 = CW / 2 - s;
  if (h0 <= 0.35) return false;
  if (y < 0.5 || y > SIZE - 0.5) {
    // above / below the matrix only the vertical channels stay open,
    // so the grains can be poured in at the top and drain out below
    const i = Math.min(N - 1, Math.max(0, (x / S) | 0));
    const v = w.valves[(y < 0.5 ? 0 : N - 1) * N + i];
    return Math.abs(x - v.cx) <= h0;
  }
  const i = Math.min(N - 1, Math.max(0, (x / S) | 0));
  const j = Math.min(N - 1, Math.max(0, (y / S) | 0));
  const v = w.valves[j * N + i];
  const lx = x - v.cx;
  const ly = y - v.cy;
  const h = CW / 2 - s;
  if (h <= 0.35) return false;
  const r = Math.hypot(lx, ly);

  if (r < RV + s) {
    // inside (or touching) the rotating valve -> test its own openings
    const c = Math.cos(-v.angle);
    const sn = Math.sin(-v.angle);
    const px = lx * c - ly * sn;
    const py = lx * sn + ly * c;
    for (let k = 0; k < v.prims.length; k++) {
      const pr = v.prims[k];
      if (pr.t === 0) {
        if (distSeg(px, py, pr.ax, pr.ay, pr.bx, pr.by) <= h) return true;
      } else if (pr.t === 1) {
        if (Math.abs(Math.hypot(px, py) - pr.r) <= h) {
          let d = Math.atan2(py, px) - pr.mid;
          while (d > Math.PI) d -= TAU;
          while (d < -Math.PI) d += TAU;
          if (Math.abs(d) <= pr.span / 2 + 0.05) return true;
        }
      } else if (Math.hypot(px, py) <= pr.r - s) {
        return true;
      }
    }
    return false; // the valve body blocks the channel
  }

  // housing: the two milled slots of this cell
  return Math.abs(lx) <= h || Math.abs(ly) <= h;
}

/* ---------------------------- particles --------------------------- */

const G = 820;
const DRAG = 2.4;
const VMAX = 250;
const SUB = 3;

const PALETTE = [
  [4, 78, 58],
  [24, 88, 60],
  [42, 92, 62],
  [160, 72, 52],
  [190, 80, 55],
  [205, 82, 60],
  [268, 70, 64],
  [300, 72, 62],
  [336, 80, 62],
];

function newParticle(x: number, y: number): Particle {
  const c = pick(PALETTE);
  const r = rnd(2.2, 3.0);
  return {
    x,
    y,
    vx: rnd(-12, 12),
    vy: rnd(-10, 20),
    r,
    color: hsl(c[0], c[1], c[2]),
    rim: hsl(c[0], Math.min(90, c[1] + 10), Math.max(12, c[2] - 34)),
    stuck: 0,
  };
}

/** A random air point inside a valve (used for the "near the top" seeding). */
function airPointInValve(w: World, v: Valve, s: number) {
  for (let tries = 0; tries < 40; tries++) {
    const pr = v.prims[(Math.random() * v.prims.length) | 0];
    let lx = 0;
    let ly = 0;
    if (pr.t === 0) {
      const u = Math.random();
      lx = pr.ax + (pr.bx - pr.ax) * u;
      ly = pr.ay + (pr.by - pr.ay) * u;
    } else if (pr.t === 1) {
      const a = pr.mid + (Math.random() - 0.5) * pr.span * 0.8;
      lx = Math.cos(a) * pr.r;
      ly = Math.sin(a) * pr.r;
    } else {
      const a = Math.random() * TAU;
      const rr = Math.sqrt(Math.random()) * Math.max(1, pr.r - s - 1.5);
      lx = Math.cos(a) * rr;
      ly = Math.sin(a) * rr;
    }
    lx += rnd(-1.2, 1.2);
    ly += rnd(-1.2, 1.2);
    const p = rot(lx, ly, v.angle);
    const x = v.cx + p.x;
    const y = v.cy + p.y;
    if (isAir(w, x, y, s)) return { x, y };
  }
  return null;
}

function spawnTop(w: World, p: Particle) {
  const i = (Math.random() * N) | 0;
  const cx = (i + 0.5) * S;
  p.x = cx + rnd(-1, 1) * (CW / 2 - p.r - 0.4);
  // just above the matrix, inside the vertical channel: always air
  p.y = rnd(-9, -1.5);
  p.vx = rnd(-8, 8);
  p.vy = rnd(0, 30);
  p.stuck = 0;
  if (!isAir(w, p.x, p.y, p.r)) {
    p.x = cx;
    p.y = -3;
  }
}

/** Bring the particle population to `count`. */
export function setParticleCount(w: World, count: number) {
  while (w.particles.length > count) w.particles.pop();
  let guard = 0;
  while (w.particles.length < count && guard++ < count * 40) {
    const p = newParticle(0, 0);
    // 60%: pour in from the top, 40%: already sitting inside a valve
    if (Math.random() < 0.6) {
      spawnTop(w, p);
      w.particles.push(p);
    } else {
      const top = w.valves.filter((v) => v.j < 4 && v.prims.length > 0);
      const any = w.valves.filter((v) => v.prims.length > 0);
      if (!any.length) {
        spawnTop(w, p);
        w.particles.push(p);
        continue;
      }
      const v = Math.random() < 0.75 && top.length ? pick(top) : pick(any);
      const pt = airPointInValve(w, v, p.r);
      if (pt) {
        p.x = pt.x;
        p.y = pt.y;
        w.particles.push(p);
      }
    }
  }
}

/** Pour every existing grain back in at the top of the matrix. */
export function dropAll(w: World) {
  for (const p of w.particles) spawnTop(w, p);
}

/* ------------------------- valve animation ------------------------ */

function nextMove(v: Valve) {
  const q = 1 + ((Math.random() * 3) | 0); // 1..3 quarter turns
  const sign = Math.random() < 0.5 ? -1 : 1;
  v.from = v.angle;
  v.delta = (sign * q * Math.PI) / 2;
  v.t = 0;
  v.dur = rnd(1.0, 2.3);
}

export function stepValves(w: World, dt: number) {
  for (const v of w.valves) {
    const prev = v.angle;
    if (v.t < 1) {
      v.t = Math.min(1, v.t + dt / v.dur);
      const u = v.t;
      const e = u * u * (3 - 2 * u); // smooth start/stop
      v.angle = v.from + v.delta * e;
    } else {
      v.dwell -= dt;
      if (v.dwell <= 0) {
        nextMove(v);
        v.dwell = rnd(0.9, 4.2);
      }
    }
    v.omega = dt > 0 ? (v.angle - prev) / dt : 0;
  }
}

/* --------------------- particle collision solving ----------------- */

function findEscape(w: World, x: number, y: number, r: number) {
  const DIRS = 14;
  for (let ring = 1; ring <= 5; ring++) {
    const d = ring * 1.5;
    let sx = 0;
    let sy = 0;
    let cnt = 0;
    const cand: number[] = [];
    for (let k = 0; k < DIRS; k++) {
      const a = (k / DIRS) * TAU + ring * 0.31;
      const ax = Math.cos(a);
      const ay = Math.sin(a);
      if (isAir(w, x + ax * d, y + ay * d, r)) {
        cand.push(a);
        sx += ax;
        sy += ay;
        cnt++;
      }
    }
    if (cnt) {
      const ml = Math.hypot(sx, sy) || 1;
      let best = cand[0];
      let score = -2;
      for (const a of cand) {
        const dot = (Math.cos(a) * sx + Math.sin(a) * sy) / ml;
        if (dot > score) {
          score = dot;
          best = a;
        }
      }
      return { nx: Math.cos(best), ny: Math.sin(best), d };
    }
  }
  return null;
}

function collideWorld(w: World, p: Particle) {
  if (isAir(w, p.x, p.y, p.r)) {
    p.stuck = 0;
    return;
  }
  const esc = findEscape(w, p.x, p.y, p.r);
  if (!esc) {
    p.stuck++;
    return;
  }
  // walk back to the surface along the escape direction
  let lo = 0;
  let hi = esc.d;
  for (let k = 0; k < 7; k++) {
    const m = (lo + hi) * 0.5;
    if (isAir(w, p.x + esc.nx * m, p.y + esc.ny * m, p.r)) hi = m;
    else lo = m;
  }
  p.x += esc.nx * hi;
  p.y += esc.ny * hi;

  // velocity of the wall that touched us (a rotating valve carries the grain)
  let wvx = 0;
  let wvy = 0;
  const i = Math.min(N - 1, Math.max(0, (p.x / S) | 0));
  const j = Math.min(N - 1, Math.max(0, (p.y / S) | 0));
  const v = w.valves[j * N + i];
  const lx = p.x - v.cx;
  const ly = p.y - v.cy;
  if (v.omega !== 0 && Math.hypot(lx, ly) < RV + p.r) {
    wvx = -v.omega * ly;
    wvy = v.omega * lx;
  }

  let rvx = p.vx - wvx;
  let rvy = p.vy - wvy;
  const vn = rvx * esc.nx + rvy * esc.ny;
  if (vn < 0) {
    const rest = 0.14;
    rvx -= (1 + rest) * vn * esc.nx;
    rvy -= (1 + rest) * vn * esc.ny;
    // tangential friction
    const tx = -esc.ny;
    const ty = esc.nx;
    const vt = rvx * tx + rvy * ty;
    rvx -= vt * 0.14 * tx;
    rvy -= vt * 0.14 * ty;
    p.vx = rvx + wvx;
    p.vy = rvy + wvy;
  }

  // resting grains get a tiny shake so arches above a valve break up
  if (Math.abs(p.vx) < 6 && Math.abs(p.vy) < 14 && Math.random() < 0.035) {
    p.vx += rnd(-16, 16);
  }
  p.stuck = 0;
}

function collideParticles(ps: Particle[]) {
  for (let a = 0; a < ps.length; a++) {
    const p = ps[a];
    for (let b = a + 1; b < ps.length; b++) {
      const q = ps[b];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const rr = p.r + q.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr || d2 <= 0.0001) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;
      const push = (rr - d) * 0.5;
      p.x -= nx * push;
      p.y -= ny * push;
      q.x += nx * push;
      q.y += ny * push;
      const rvx = q.vx - p.vx;
      const rvy = q.vy - p.vy;
      const vn = rvx * nx + rvy * ny;
      if (vn < 0) {
        const imp = -vn * 0.55;
        p.vx -= nx * imp;
        p.vy -= ny * imp;
        q.vx += nx * imp;
        q.vy += ny * imp;
      }
    }
  }
}

export function stepParticles(w: World, dt: number) {
  const ps = w.particles;
  const h = dt / SUB;
  for (let s = 0; s < SUB; s++) {
    const drag = Math.exp(-DRAG * h);
    for (const p of ps) {
      p.vy += G * h;
      p.vx *= drag;
      p.vy *= drag;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > VMAX) {
        p.vx *= VMAX / sp;
        p.vy *= VMAX / sp;
      }
      p.x += p.vx * h;
      p.y += p.vy * h;
      collideWorld(w, p);
    }
    collideParticles(ps);
    for (const p of ps) if (!isAir(w, p.x, p.y, p.r)) collideWorld(w, p);
  }
  for (const p of ps) {
    if (p.y > SIZE + 6 || p.x < -6 || p.x > SIZE + 6 || p.stuck > 45) {
      spawnTop(w, p);
    }
  }
}
