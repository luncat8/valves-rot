// Run: node experiments/calibration-fixtures.cjs
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const AIR = require("../prototype/shared/air.js");
const GAS = require("../prototype/shared/gas.js");
const C = require("../prototype/shared/calibration.js");

function near(actual, expected, tolerance, message) {
	assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
}

function chamber(capacity) {
	const layout = G.createLayout(7);
	layout.valves[44] = G.makeValve(4, 4, "hollow", [], 0, C.REF_RADIUS);
	const sim = S.create(layout, { turning: false });
	sim.pressure = AIR.create(sim, capacity);
	return sim;
}

// An actual elastic wall hit deposits exactly the normal impulse, in a fixed
// simulation-time window. Recovery and the unrelated speed cap are not hits.
const hit = chamber(1);
const v = hit.layout.valves[44];
const p = hit.pressure;
p.count = 1;
p.x[0] = v.cx + C.REF_RADIUS - AIR.RADIUS - 0.15;
p.y[0] = v.cy;
p.vx[0] = AIR.SPEED;
p.vy[0] = 0;
AIR.step(hit, S.STEP);
near(p.wallImpulse, AIR.MASS * (AIR.SPEED - p.vx[0]), 1e-8, "normal wall momentum");
near(p.wallImpulse, 2 * AIR.MASS * AIR.SPEED, 1e-8, "elastic impulse");
assert.equal(p.wallHits, 1);
p.vx[0] = p.vy[0] = 0;
for (let k = 1; k < 120; k++) AIR.step(hit, S.STEP);
assert.equal(p.wallWindows, 1);
near(p.lastWallTime, AIR.WALL_WINDOW, 1e-10, "first window duration");
near(p.lastWallImpulse, 2 * AIR.MASS * AIR.SPEED, 1e-8, "windowed impulse");
assert.equal(p.lastWallHits, 1);
for (let k = 0; k < 120; k++) AIR.step(hit, S.STEP);
assert.equal(p.wallWindows, 2);
assert.equal(p.lastWallImpulse, 0, "windows do not accumulate old impacts");

const repaired = chamber(1);
const recovered = repaired.pressure;
const rv = repaired.layout.valves[44];
recovered.count = 1;
recovered.x[0] = rv.cx + C.REF_RADIUS + 0.2;
recovered.y[0] = rv.cy;
recovered.vx[0] = AIR.SPEED;
recovered.vy[0] = 0;
AIR.step(repaired, S.STEP);
assert.equal(recovered.recoveries, 1);
assert.equal(recovered.wallHits, 0, "repair is not a measured wall impact");
assert.equal(recovered.wallImpulse, 0);

const blocked = chamber(1);
const bv = blocked.layout.valves[44];
assert.equal(S.addGrain(blocked, bv.cx + 12.1, bv.cy + 1.5, 2.7, 0), 0);
const bp = blocked.pressure;
bp.count = 1;
bp.x[0] = bv.cx + 14.2;
bp.y[0] = bv.cy;
bp.vx[0] = 150;
bp.vy[0] = 300;
AIR.step(blocked, 0.001);
assert.equal(bp.collisions, 1, "a grain intercepts the path to the wall");
assert.equal(bp.wallHits, 0, "a wall that the blocked particle never reached is not reflected or measured");
near(bp.x[0], bv.cx + 14.2, 1e-9, "the grain blocked the sweep");
bp.vx[0] = 50;
bp.vy[0] = 0;
AIR.step(blocked, 0.001);
assert.ok(bp.x[0] > bv.cx + 14.2, "a separating overlap does not pin the particle to a grain");

// SI conversion: impulse × kg/unit × m/px ÷ seconds/step; area is
// wall length × m/px × depth. Simulation time must be converted twice.
const units = { metresPerPixel: 0.02, secondsPerSimSecond: 0.5, kgPerMassUnit: 0.001, depthMetres: 0.2 };
near(C.wallPressure(20, 4, 5, units), 0.02, 1e-12, "SI impulse / area / time");
near(C.wallPressure(40, 4, 5, units), 0.04, 1e-12, "impulse scales pressure");
near(C.wallPressure(20, 4, 5, { ...units, depthMetres: 0.4 }), 0.01, 1e-12, "depth scales area");
near(C.wallPressure(20, 4, 5, { ...units, secondsPerSimSecond: 1 }), 0.005, 1e-12, "time scale squared");
near(C.equivalentPressure(0, C.DEFAULT_SPAN), 0, 1e-12, "gauge low");
near(C.equivalentPressure(0.5, C.DEFAULT_SPAN), C.DEFAULT_SPAN / 2, 1e-12, "mid-ramp mapping");
near(C.equivalentPressure(1, C.DEFAULT_SPAN), C.DEFAULT_SPAN, 1e-12, "gauge high");
assert.equal(C.format(C.DEFAULT_SPAN), "0.7125");
assert.equal(C.format(0.00105), "0.00105");
assert.equal(C.format(0.000001), "1.00e-6");
assert.equal(C.format(2.5), "2.5");

// Independent kinetic-theory check on the real particle solver. The accessible
// centre radius is R - particle radius; pressure is averaged over the physical
// wall at R, not over the smaller centre path.
function reference(count, speed, seconds) {
	const sim = chamber(count);
	const air = sim.pressure;
	const valve = sim.layout.valves[44];
	const random = G.rng(0x4a71);
	air.count = count;
	for (let k = 0; k < count; k++) {
		const r = (C.REF_RADIUS - AIR.RADIUS - 0.05) * Math.sqrt(random());
		const a = random() * G.TAU;
		const d = random() * G.TAU;
		air.x[k] = valve.cx + r * Math.cos(a);
		air.y[k] = valve.cy + r * Math.sin(a);
		air.vx[k] = speed * Math.cos(d);
		air.vy[k] = speed * Math.sin(d);
	}
	let impulse = 0;
	let elapsed = 0;
	let hits = 0;
	let windows = 0;
	for (let k = 0; k < Math.round(seconds / S.STEP); k++) {
		AIR.step(sim, S.STEP);
		if (air.wallWindows === windows) continue;
		windows = air.wallWindows;
		near(air.lastWallTime, AIR.WALL_WINDOW, 1e-10, "reference window");
		impulse += air.lastWallImpulse;
		elapsed += air.lastWallTime;
		hits += air.lastWallHits;
	}
	assert.equal(windows, seconds);
	assert.equal(air.recoveries, 0);
	for (let k = 0; k < count; k++) near(Math.hypot(air.vx[k], air.vy[k]), speed, 1e-6, "static-wall energy");
	return { impulse, elapsed, hits, pa: C.wallPressure(impulse, elapsed, 2 * Math.PI * C.REF_RADIUS) };
}
const ref = reference(100, AIR.SPEED, C.REF_SECONDS);
near(ref.impulse, C.REF_IMPULSE, C.REF_IMPULSE * 1e-6, "stored wall calibration must match the current solver");
near(ref.pa, C.DEFAULT_SPAN, 1e-8, "default span is the measured flux");
assert.ok(ref.hits > 10000, "reference samples enough wall impacts");
const u = C.UNITS;
const wallRadius = C.REF_RADIUS * u.metresPerPixel;
const accessibleRadius = (C.REF_RADIUS - AIR.RADIUS) * u.metresPerPixel;
const speed = AIR.SPEED * u.metresPerPixel / u.secondsPerSimSecond;
const theory = 100 * AIR.MASS * u.kgPerMassUnit * speed * speed / (2 * Math.PI * accessibleRadius * wallRadius * u.depthMetres);
near(ref.pa, theory, theory * 0.02, "mean isotropic circular-chamber wall flux");
const slow = reference(100, AIR.SPEED / 2, C.REF_SECONDS);
near(slow.pa / ref.pa, 0.25, 0.012, "wall flux scales with speed squared");
const denser = reference(200, AIR.SPEED, C.REF_SECONDS);
near(denser.pa / ref.pa, 2, 0.08, "wall flux scales with population");

// Open seam: an ideal 1-D serial resistance with a narrow section has an exact
// piecewise-linear pressure. The production steady kernel must reproduce that
// resistance on the same face-conductance graph at two grid resolutions.
function seamChain(cell, aperture) {
	const nx = 120 / cell + 1;
	const f = GAS.blankField(nx, 1, cell);
	f.air.fill(1);
	f.face.fill(15);
	f.open.fill(1);
	for (let k = 0; k < nx; k++) {
		f.list[k] = k;
		if (k * cell >= 48 && k * cell < 72) f.open[k] = aperture;
	}
	f.pin[0] = 2;
	f.pin[nx - 1] = 1;
	GAS.link(f);
	GAS.components(f);
	GAS.conductance(f);
	GAS.steady(f, f.p);
	const resistance = new Float64Array(nx);
	for (let k = 1; k < nx; k++) resistance[k] = resistance[k - 1] + 1 / GAS.faceConductance(f, k - 1, k);
	let error = 0;
	for (let k = 0; k < nx; k++) {
		const exact = 1 - resistance[k] / resistance[nx - 1];
		error = Math.max(error, Math.abs(f.p[k] - exact));
		near(C.equivalentPressure(f.p[k], C.DEFAULT_SPAN), f.p[k] * C.DEFAULT_SPAN, 1e-6, "ramp preserves linear gauge mapping");
	}
	near(f.p[0], 1, 1e-8, "source pin");
	near(f.p[nx - 1], 0, 1e-8, "vent pin");
	const drop = f.p[48 / cell] - f.p[72 / cell];
	return { f, error, drop };
}
const coarse = seamChain(6, 0.25);
const fine = seamChain(3, 0.25);
const open = seamChain(3, 1);
assert.ok(coarse.error < 1e-4 && fine.error < 1e-4, `serial-seam profile matches its analytical resistance (${coarse.error.toExponential(2)} / ${fine.error.toExponential(2)})`);
assert.ok(fine.drop > open.drop * 2, "a narrow seam concentrates the pressure drop");

// The measured face aperture is a serial resistance too: a chain whose fifth
// of the links is a quarter-open face must show the same profile as one whose
// cells are a quarter as conductive, so a closing port throttles the solve.
function apertureChain(ap) {
	const nx = 61;
	const f = GAS.blankField(nx, 1, 6);
	f.air.fill(1);
	f.face.fill(15);
	f.open.fill(1);
	for (let k = 0; k < nx; k++) f.list[k] = k;
	for (let k = 10; k < 22; k++) f.apR[k] = ap;
	f.pin[0] = 2;
	f.pin[nx - 1] = 1;
	GAS.link(f);
	GAS.components(f);
	GAS.conductance(f);
	GAS.steady(f, f.p);
	return f;
}
const throttled = apertureChain(0.25);
const fullBore = apertureChain(1);
let apertureProfile = 0;
const resistance = new Float64Array(throttled.nx);
for (let k = 1; k < throttled.nx; k++) resistance[k] = resistance[k - 1] + 1 / GAS.faceConductance(throttled, k - 1, k);
for (let k = 0; k < throttled.nx; k++) apertureProfile = Math.max(apertureProfile, Math.abs(throttled.p[k] - (1 - resistance[k] / resistance[throttled.nx - 1])));
assert.ok(apertureProfile < 1e-4, `a throttled face obeys its serial resistance (${apertureProfile.toExponential(2)})`);
assert.ok(throttled.p[30] < fullBore.p[30] - 0.1, "a quarter-open face throttles the flow instead of switching it off");

// A huge implicit step is stable and lands on the same equilibrium: pressure
// never overshoots a constant-pressure boundary.
const jump = seamChain(6, 1).f;
jump.p.fill(0);
jump.p[0] = 1;
GAS.diffuse(jump, 1e6);
let jumpError = 0;
for (let k = 0; k < jump.nx; k++) {
	assert.ok(jump.p[k] >= 0 && jump.p[k] <= 1, "an implicit step stays normalized");
	jumpError = Math.max(jumpError, Math.abs(jump.p[k] - (1 - k / (jump.nx - 1))));
}
assert.ok(jumpError < 1e-3, `a large implicit step converges to the same profile (${jumpError.toExponential(2)})`);

// Closed wall: a metal cell splits the row into two components. Each half takes
// exactly its own boundary value, and a half with no mouth keeps its own air.
function splitChain(rightPin) {
	const nx = 7;
	const f = GAS.blankField(nx, 1, 6);
	f.air.fill(1);
	f.face.fill(15);
	f.open.fill(1);
	f.air[3] = 0;
	f.face[3] = 0;
	f.face[2] &= ~2;
	f.face[4] &= ~1;
	f.count = 0;
	for (let k = 0; k < nx; k++) if (f.air[k]) f.list[f.count++] = k;
	f.p.fill(0.25);
	f.pin[0] = 2;
	if (rightPin) f.pin[nx - 1] = 1;
	GAS.link(f);
	GAS.components(f);
	GAS.conductance(f);
	GAS.steady(f, f.p);
	return f;
}
const sealedWall = splitChain(true);
assert.equal(sealedWall.compCount, 2, "a metal cell splits the air graph");
for (let k = 0; k < 3; k++) near(sealedWall.p[k], 1, 1e-6, "high half cannot leak through the wall");
for (let k = 4; k < 7; k++) near(sealedWall.p[k], 0, 1e-6, "low half cannot leak through the wall");
const trapped = splitChain(false);
for (let k = 4; k < 7; k++) near(trapped.p[k], 0.25, 1e-6, "a compartment with no mouth keeps its air");

// Analytical chord aperture vs the real clearance/face stencil. A sub-cell
// opening can disappear at 6 px; the 3 px stencil resolves it. Both converge
// within one cell of the accessible chord in these rim-aligned samples.
const layout = G.createLayout(7);
const valve = layout.valves[44] = G.makeValve(4, 4, "solid", [0, 2], 0, 0);
function stencilWidth(cell) {
	let width = 0;
	const x = valve.cx + G.RV - cell / 2;
	for (let lat = -G.HALF + cell / 2; lat < G.HALF; lat += cell) {
		const y = valve.cy + lat;
		if (G.airClearance(layout, x, y) < GAS.AIR_MIN) continue;
		if (G.airClearance(layout, x + cell, y) < GAS.AIR_MIN) continue;
		if (GAS.openFace(layout, x, y, cell, 0)) width += cell;
	}
	return width;
}
let coarseError = 0;
let fineError = 0;
for (const angle of [0, 0.03, 0.06, 0.09, 0.12, 0.15, 0.18, 0.21, 0.24]) {
	G.setAngle(valve, angle);
	const chord = Math.max(0, Math.min(G.HALF, (G.HALF - G.RV * Math.sin(angle)) / Math.cos(angle)));
	near(valve.seam[0], chord, 1e-9, "analytical seam half-width");
	const accessible = 2 * Math.max(0, chord - GAS.AIR_MIN);
	const a = stencilWidth(6);
	const b = stencilWidth(3);
	assert.ok(Math.abs(a - accessible) <= 6.01 && Math.abs(b - accessible) <= 3.01, "face stencil resolves the analytical aperture to a cell");
	coarseError += Math.abs(a - accessible);
	fineError += Math.abs(b - accessible);
	if (angle === 0.15) assert.ok(a === 0 && b > 0, "a sub-cell seam needs the finer grid");
	if (angle === 0.24) assert.equal(a + b, 0, "closed seam has no open face");
}
assert.ok(fineError < coarseError, "refining the face stencil reduces aperture error");

// Test the actual 6 px runtime mask, not just a rim-aligned stencil. In this
// layout the shut rim lies between the midpoint and an endpoint of a link.
const live = S.create(layout, { turning: false });
S.setPressure(live, "grid");
	// The live display field is a projection, so the runtime face test reads the
	// projection itself: two texels share an open face exactly when both resolve
	// to air nodes inside one component of the network.
	function joined(field, k) {
		const map = field.map;
		const a = map[k];
		const b = map[k + 1];
		if (a < 0 || b < 0) return false;
		const net = field.net;
		return net.comp[a] === net.comp[b];
	}

function runtimeRimWidth(angle) {
	G.setAngle(valve, angle);
	GAS.refresh(live);
	const field = live.pressure;
	const cell = field.cell;
	let width = 0;
	for (let gy = 0; gy < field.ny; gy++) {
		const y = (gy + 0.5) * cell - G.POUR;
		if (Math.abs(y - valve.cy) > G.HALF + cell) continue;
		for (let gx = 0; gx < field.nx - 1; gx++) {
			const x = (gx + 0.5) * cell;
			if (x < valve.cx || x > valve.cx + G.RV + cell) continue;
			const dy = y - valve.cy;
			const a = (x - valve.cx) ** 2 + dy * dy;
			const b = (x + cell - valve.cx) ** 2 + dy * dy;
			if (a >= G.RV ** 2 || b < G.RV ** 2) continue;
			if (joined(field, gy * field.nx + gx)) width += cell;
		}
	}
	return width;
}
assert.ok(runtimeRimWidth(0) > 0, "aligned seam admits grid faces");
assert.equal(runtimeRimWidth(0.24), 0, "a shut rim cannot hide between face samples");

// Rotor passages are sampled once in valve-local coordinates, casing pipes
// are static, and a turn only rewrites seam links plus the rim texels. An
// incremental mask must still be identical to one built from scratch at the
// same angles — otherwise the cache would trade correctness for speed.
// The projection is the cache: a rim texel that resolved to a different network
// node, or landed in a different component, means an incremental rebuild
// disagrees with one built from scratch.
function maskDiff(incremental, fresh) {
	let diff = 0;
	for (let k = 0; k < incremental.size; k++) {
		if (incremental.air[k] !== fresh.air[k]) diff++;
		else if (incremental.map[k] !== fresh.map[k]) diff++;
		else if (incremental.active[k] !== fresh.active[k]) diff++;
	}
	return diff;
}
let cacheDiff = 0;
for (const seed of [7, 11, 42]) {
	const machine = G.createLayout(seed);
	const sim = S.create(machine, { turning: false });
	S.setPressure(sim, "grid");
	for (const step of [0.09, 0.17, 0.02, 0.31, 0.055, 0.5, 0.12]) {
		for (let k = 0; k < machine.valves.length; k++) {
			if ((k + seed) % 3 === ((step * 100) | 0) % 3 || k % 7 === 0) G.setAngle(machine.valves[k], G.hashUnit(seed, k, 91) * step);
		}
		GAS.refresh(sim, false);
		const fresh = S.create(machine, { turning: false });
		S.setPressure(fresh, "grid");
		cacheDiff += maskDiff(sim.pressure, fresh.pressure);
	}
}
assert.equal(cacheDiff, 0, "an incremental mask matches one built from scratch");
// A replaced valve must invalidate its cached cells and faces.
{
	const machine = G.createLayout(42);
	const sim = S.create(machine, { turning: false });
	S.setPressure(sim, "grid");
	G.setAngle(machine.valves[44], 0.21);
	GAS.refresh(sim, false);
	S.installValve(sim, 44, G.typeById("hollow-cross"), 0, G.RV * 0.8);
	const fresh = S.create(machine, { turning: false });
	S.setPressure(fresh, "grid");
	assert.equal(maskDiff(sim.pressure, fresh.pressure), 0, "a replaced valve invalidates its cached geometry");
}

// The live graph has static edges inside rotors and casings plus seam edges
// that join a rotor cell to a static corridor cell for the current rotation.
// A seam edge is a link through the rim, so a small disc must be able to
// travel between its endpoints; a shut seam must produce no links at all.
const sweep = { x: 0, y: 0, hit: false };
function liveSeams(gas) {
	const net = gas.net;
	const list = [];
	let conductance = 0;
	for (let n = 0; n < net.count; n++) {
		const a = net.list[n];
		const sa = a % GAS.SLOTS;
		const e0 = a * net.slots;
		for (let m = 0; m < net.nbrCount[a]; m++) {
			const e = e0 + m;
			const b = net.nbr[e];
			if (b < a || net.gw[e] <= 0) continue;
			const sb = b % GAS.SLOTS;
			if ((sa < GAS.RSLOTS) === (sb < GAS.RSLOTS)) continue;
			list.push({ a, b, lane: (sb - GAS.RSLOTS) % GAS.LANES, g: net.gw[e] });
			conductance += net.gw[e];
		}
	}
	return { list, conductance };
}
let links = 0;
let offCentreLinks = 0;
for (const seed of [7, 11, 42, 1234]) {
	const machine = G.createLayout(seed);
	for (let k = 0; k < machine.valves.length; k++) G.setAngle(machine.valves[k], G.hashUnit(seed, k, 77) * G.TAU);
	const sim = S.create(machine, { turning: false });
	S.setPressure(sim, "grid");
	GAS.refresh(sim, false);
	const net = sim.pressure.net;
	const { list } = liveSeams(sim.pressure);
	assert.ok(list.length > 50, `rotation builds seam links: seed ${seed} (${list.length})`);
	for (const link of list) {
		assert.equal(((link.a - link.a % GAS.SLOTS) / GAS.SLOTS) | 0, ((link.b - link.b % GAS.SLOTS) / GAS.SLOTS) | 0,
			"a seam link stays inside one valve");
		G.sweep(machine, net.wx[link.a], net.wy[link.a], net.wx[link.b], net.wy[link.b], GAS.AIR_MIN, sweep);
		assert.ok(!sweep.hit, `a seam link crosses metal: seed ${seed}, cell ${link.a}`);
		if (link.lane !== 1) offCentreLinks++;
	}
	links += list.length;
}
assert.ok(links > 300, `validate a representative set of live seam links (${links})`);
assert.ok(offCentreLinks > 20, `there are real off-centre seam links to validate (${offCentreLinks})`);

// A shut rotor has no seam links, and a turning rotor throttles the ones it
// has. The rotor's own air cells are sampled once and never resampled.
{
	const machine = G.createLayout(7);
	const blank = { seed: 7, valves: [] };
	for (let j = 0; j < G.N; j++) {
		for (let i = 0; i < G.N; i++) blank.valves.push(G.makeValve(i, j, "solid", [], 0, 0));
	}
	const solid = S.create(blank, { turning: false });
	S.setPressure(solid, "grid");
	assert.equal(liveSeams(solid.pressure).list.length, 0, "a solid blank has no seam links");

	const sim = S.create(machine, { turning: false });
	S.setPressure(sim, "grid");
	const net = sim.pressure.net;
	const rotorAir = Uint8Array.from(net.air);
	const widths = [];
	for (const angle of [0, 0.09, 0.18, 0.24]) {
		G.setAngle(machine.valves[44], angle);
		GAS.refresh(sim, false);
		let g = 0;
		for (const link of liveSeams(sim.pressure).list) {
			if ((((link.a - link.a % GAS.SLOTS) / GAS.SLOTS) | 0) === 44) g += link.g;
		}
		widths.push(g);
		for (let k = 0; k < rotorAir.length; k++) assert.equal(rotorAir[k], net.air[k], "a turn never resamples rotor clearance");
	}
	assert.ok(widths[0] > widths[1] && widths[1] > widths[2] && widths[2] >= widths[3],
		`a narrowing seam throttles its links (${widths.map(v => v.toFixed(2)).join(" / ")})`);
	assert.ok(widths[3] < widths[0] * 0.2, "a nearly shut seam leaves no wide open link");
}

console.log(
	`OK calibration: ${ref.hits} wall hits, ${ref.pa.toFixed(4)} Pa vs ${theory.toFixed(4)} Pa theory; ` +
	`steady serial seam errors ${coarse.error.toExponential(2)} / ${fine.error.toExponential(2)} (6/3 px); ` +
	`aperture errors ${coarseError.toFixed(2)} / ${fineError.toFixed(2)} px; a quarter-open face throttles its link; ` +
	`${links} seam links clear (${offCentreLinks} off-centre); ` +
	`closed wall isolates both halves and a pinless half keeps its air. The grid is a conservative relative pressure.`,
);
