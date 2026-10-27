// Probe v5: front visibility per tick at candidate DIFFUSE_DT values, and the
// long-corridor case that starved under Jacobi preconditioning.
// Run: node experiments/front-probe.cjs
const G = require("../prototype/shared/geometry.js");
const GAS = require("../prototype/shared/gas.js");
const S = require("../prototype/shared/simulation.js");
const I = require("../prototype/shared/inlets.js");

function crossLayout() {
	const valves = [];
	for (let j = 0; j < G.N; j++) for (let i = 0; i < G.N; i++) valves.push(G.makeValve(i, j, "solid", [0, 1, 2, 3], 0, 0));
	return { seed: 42, valves };
}

function coverage(gas, tol) {
	let near = 0;
	let active = 0;
	for (let n = 0; n < gas.count; n++) {
		const k = gas.list[n];
		if (!gas.active[k] || gas.pin[k]) continue;
		active++;
		if (Math.abs(gas.p[k] - gas.pTarget[k]) <= tol) near++;
	}
	return active ? near / active : 1;
}

function prepared(layout, dt) {
	const sim = S.create(layout, { turning: false });
	S.setPressure(sim, "grid");
	const gas = sim.pressure;
	for (let k = 0; k < sim.inlets.count; k++) if (sim.inlets.open[k]) S.toggleInlet(sim, k, false);
	for (let k = 0; k < 20; k++) GAS.diffuse(gas, dt);
	S.toggleInlet(sim, I.TOP * G.N + 0, false);
	S.toggleInlet(sim, I.BOTTOM * G.N + (G.N - 1), false);
	GAS.steady(gas, gas.pTarget);
	return { sim, gas };
}

// Per-tick coverage: front visibility (how far the first ticks get).
for (const dt of [600, 1200, 2400]) {
	const { gas } = prepared(crossLayout(), dt);
	const row = [];
	for (let t = 1; t <= 14; t++) {
		GAS.diffuse(gas, dt);
		row.push(`${(coverage(gas, 0.02) * 100) | 0}`);
	}
	console.log(`cross dt=${String(dt).padStart(4)} cover% by tick: ${row.join(" ")} (iters ${gas.pcgIters} res ${gas.pcgResidual.toExponential(1)})`);
}

// Long serpentine corridor: the case that hit the 400-iteration cap.
function serpentine() {
	const valves = [];
	for (let j = 0; j < G.N; j++) {
		for (let i = 0; i < G.N; i++) valves.push(G.makeValve(i, j, "solid", [1, 3], 0, 0));
	}
	for (let i = 0; i < G.N; i++) valves[i] = G.makeValve(i, 0, "solid", [0, 1, 2, 3], 0, 0);
	const sim = S.create({ seed: 3, valves }, { turning: false });
	S.setPressure(sim, "grid");
	const gas = sim.pressure;
	for (let k = 0; k < sim.inlets.count; k++) if (sim.inlets.open[k]) S.toggleInlet(sim, k, false);
	for (let k = 0; k < 20; k++) GAS.diffuse(gas, 2400);
	S.toggleInlet(sim, I.BOTTOM * G.N + 0, false);
	S.toggleInlet(sim, I.TOP * G.N + (G.N - 1), false);
	GAS.steady(gas, gas.pTarget);
	let cap = 0;
	let maxIters = 0;
	let maxRes = 0;
	let t = 0;
	for (; t < 300; t++) {
		const delta = GAS.diffuse(gas, 2400);
		if (gas.pcgIters >= 400) cap++;
		if (gas.pcgIters > maxIters) maxIters = gas.pcgIters;
		if (gas.pcgResidual > maxRes) maxRes = gas.pcgResidual;
		if (delta < 2e-4 && t > 2) break;
	}
	console.log(`serpentine dt=2400: settled@t${t} cap=${cap} maxIters=${maxIters} maxRes=${maxRes.toExponential(1)} cover=${(coverage(gas, 0.02) * 100).toFixed(1)}%`);
}
serpentine();

// 1-D chain: IC(0) should be exact, so a 121-cell pipe converges in a few
// iterations instead of one per cell.
const chain = GAS.blankField(121, 1, 6);
chain.air.fill(1);
chain.face.fill(15);
chain.open.fill(1);
for (let k = 0; k < 121; k++) chain.list[k] = k;
chain.pin[0] = 2;
chain.pin[120] = 1;
GAS.link(chain);
GAS.components(chain);
GAS.conductance(chain);
chain.p.fill(0.5);
GAS.steady(chain, chain.p);
console.log(`chain steady: iters=${chain.pcgIters} res=${chain.pcgResidual.toExponential(1)}`);
GAS.diffuse(chain, 40);
console.log(`chain step dt=40: iters=${chain.pcgIters} res=${chain.pcgResidual.toExponential(1)}`);

// Startup cost of the steady snap on a real layout (quest probes use this).
{
	const t0 = performance.now();
	for (let k = 0; k < 20; k++) {
		const sim = S.create(G.createLayout(7), { turning: false });
		S.setPressure(sim, "grid");
	}
	console.log(`create+steady x20: ${((performance.now() - t0) / 20).toFixed(3)} ms each`);
}
