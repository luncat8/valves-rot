// Liveliness probe for the grain solver: two-grain stacks, three-grain pyramids,
// inertial rolling on a flat floor, sliding through an elbow bend and column
// spread are measured on the combined solver and on the GLM prototype engine as
// a behavioural reference. Run: node experiments/behavior-probe.cjs
// The `glm*` rows are not comparable between runs: the reference engine seeds itself
// randomly. Only the combined-solver rows are deterministic and usable as a gate.
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");

const N = G.N;
const STEP = S.STEP;
const R = 2.6;

function field(spec) {
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			const e = spec[i + "," + j];
			valves.push(G.makeValve(i, j, e ? e[0] : "solid", e ? e[1] : [], 0, e && e[2] ? e[2] : 0));
		}
	}
	return { seed: 3, valves };
}

function center(i, j) {
	return { cx: (i + 0.5) * G.S, cy: (j + 0.5) * G.S };
}

function run(sim, seconds, watch) {
	const n = Math.round(seconds * 120);
	for (let k = 0; k < n; k++) {
		S.step(sim, STEP);
		if (watch && watch(sim, k / 120)) return (k + 1) / 120;
	}
	return seconds;
}

const out = {};

// A: a grain balanced on top of another must not be a stable equilibrium.
function stackCase() {
	const spec = { "5,5": ["solid", [0], 0] };
	const sim = S.create(field(spec), { turning: false });
	const { cx, cy } = center(5, 5);
	const floor = cy + G.HALF - R;
	S.addGrain(sim, cx + 16, floor, R, 0);
	S.addGrain(sim, cx + 16 + 0.15, floor - 2 * R, R, 1);
	let fell = 0;
	run(sim, 3, (s, t) => {
		if (!fell && (Math.abs(s.x[1] - s.x[0]) > R || s.y[1] > s.y[0] - R * 0.8)) fell = t;
		return false;
	});
	out.stackFellAt = fell || "stable";
	out.stackFinalDx = Math.abs(sim.x[1] - sim.x[0]).toFixed(2);
}

// B: a three-grain pyramid must push itself apart sideways.
function pyramidCase() {
	const spec = { "5,5": ["solid", [0], 0] };
	const sim = S.create(field(spec), { turning: false });
	const { cx, cy } = center(5, 5);
	const floor = cy + G.HALF - R;
	const x0 = cx + 10;
	S.addGrain(sim, x0, floor, R, 0);
	S.addGrain(sim, x0 + 2 * R, floor, R, 1);
	S.addGrain(sim, x0 + R, floor - Math.sqrt(3) * R, R, 2);
	let fell = 0;
	run(sim, 3, (s, t) => {
		if (!fell && s.y[2] > floor - R * 1.1) fell = t;
		return false;
	});
	out.pyramidFellAt = fell || "stable";
	out.pyramidSpread = (Math.max(sim.x[0], sim.x[1], sim.x[2]) - Math.min(sim.x[0], sim.x[1], sim.x[2])).toFixed(2);
}

// C: a grain launched along a flat floor must keep rolling by inertia.
function rollCase() {
	const spec = { "3,5": ["solid", [0, 2], 0], "4,5": ["solid", [0, 2], 0], "5,5": ["solid", [0, 2], 0] };
	const sim = S.create(field(spec), { turning: false });
	const { cx, cy } = center(4, 5);
	const floor = cy + G.HALF - R;
	S.addGrain(sim, cx - 20, floor, R, 0);
	sim.vx[0] = 70;
	const x0 = sim.x[0];
	let stopped = 0;
	run(sim, 4, (s, t) => {
		if (!stopped && Math.hypot(s.vx[0], s.vy[0]) < 3) stopped = t;
		return false;
	});
	out.rollDistance = (sim.x[0] - x0).toFixed(1);
	out.rollStoppedAt = stopped || ">4";
}

// D: a grain parked on an elbow bend must slide around it, not sit mid-arc.
function elbowCase() {
	const spec = { "5,5": ["solid", [0, 1], 0], "5,6": ["solid", [0, 2], 0] };
	const sim = S.create(field(spec), { turning: false });
	const { cx, cy } = center(5, 5);
	const rad = G.ELBOW - G.HALF + R;
	const k = Math.SQRT1_2;
	S.addGrain(sim, cx + G.ELBOW - k * rad, cy + G.ELBOW - k * rad, R, 0);
	const x0 = sim.x[0];
	const y0 = sim.y[0];
	run(sim, 3);
	const left = Math.hypot(sim.x[0] - x0, sim.y[0] - y0);
	out.elbowTravel = left.toFixed(1);
	out.elbowExited = sim.y[0] > cy + G.RV || sim.x[0] > cx + G.RV;
}

// E: a column dropped through a top pour spout must spread along the channel.
function columnCase() {
	const spec = { "5,0": ["solid", [0, 2, 3], 0] };
	const sim = S.create(field(spec), { turning: false });
	const { cx } = center(5, 0);
	for (let k = 0; k < 8; k++) S.addGrain(sim, cx, -G.POUR + 4 + 2 * R * k, R, k % 6);
	run(sim, 4);
	const floor = (0 + 0.5) * G.S + G.HALF - R;
	let lo = Infinity;
	let hi = -Infinity;
	let high = 0;
	for (let k = 0; k < sim.count; k++) {
		lo = Math.min(lo, sim.x[k]);
		hi = Math.max(hi, sim.x[k]);
		if (sim.y[k] < floor - 1.5 * R) high++;
	}
	out.columnSpread = (hi - lo).toFixed(1);
	out.columnAboveFloor = high;
}

// F: full machine sanity: conservation, stalls and contact quality.
function fieldCase() {
	const layout = G.createLayout(7);
	const sim = S.create(layout);
	S.seed(sim);
	const injected = sim.injected;
	run(sim, 20);
	out.fieldActive = sim.count;
	out.fieldInjected = injected;
	out.fieldDrained = sim.drained;
	out.fieldStalls = sim.stalls;
	out.fieldPushed = sim.pushed;
	out.fieldRecovered = sim.recovered;
	out.fieldMaxOverlap = sim.maxOverlap.toFixed(2);
	out.fieldMaxPen = sim.maxPen.toFixed(3);
}

// GLM reference: same stack / pyramid / roll scenarios on the prototype engine.
function glmReference() {
	global.Path2D = class {
		moveTo() {}
		lineTo() {}
		arc() {}
	};
	const GLM = require("../prototype/glm-5.3-max/engine.js");
	let world = null;
	let straight = null;
	for (let attempt = 0; attempt < 40 && !straight; attempt++) {
		world = GLM.createWorld();
		straight = world.valves.find(
			(v) => v.kind === "solid" && v.ports.length === 2 && v.ports[0] === 0 && v.ports[1] === 2 && v.angle === 0,
		);
	}
	if (!straight) return;
	for (const v of world.valves) {
		v.t = 1;
		v.dwell = 1e9;
	}
	const grain = (x, y, vx) => {
		world.particles.push({ x, y, vx: vx || 0, vy: 0, r: R, color: "", rim: "", stuck: 0 });
		return world.particles.length - 1;
	};
	const step = (seconds) => {
		const n = Math.round(seconds * 60);
		for (let k = 0; k < n; k++) GLM.stepParticles(world, 1 / 60);
	};
	const floor = straight.cy + GLM.CW / 2 - R;
	world.particles.length = 0;
	grain(straight.cx + 16, floor);
	grain(straight.cx + 16 + 0.15, floor - 2 * R);
	let fell = 0;
	for (let k = 0; k < 180; k++) {
		GLM.stepParticles(world, 1 / 60);
		const [a, b] = world.particles;
		if (!fell && (Math.abs(b.x - a.x) > R || b.y > a.y - R * 0.8)) fell = (k + 1) / 60;
	}
	out.glmStackFellAt = fell || "stable";
	world.particles.length = 0;
	const x0 = straight.cx + 10;
	grain(x0, floor);
	grain(x0 + 2 * R, floor);
	grain(x0 + R, floor - Math.sqrt(3) * R);
	let pfell = 0;
	for (let k = 0; k < 180; k++) {
		GLM.stepParticles(world, 1 / 60);
		if (!pfell && world.particles[2].y > floor - R * 1.1) pfell = (k + 1) / 60;
	}
	out.glmPyramidFellAt = pfell || "stable";
	world.particles.length = 0;
	grain(straight.cx - 20, floor, 70);
	const rx = world.particles[0].x;
	step(4);
	out.glmRollDistance = (world.particles[0].x - rx).toFixed(1);
}

stackCase();
pyramidCase();
rollCase();
elbowCase();
columnCase();
fieldCase();
glmReference();
for (const key of Object.keys(out)) console.log(key.padEnd(18), out[key]);
