// Aperture diagnostics: the network's mouth-connected air against a 1.5 px
// reference at several rotor angles, whether every seam link crosses no metal,
// and what a rebuild costs.
// Run: node experiments/aperture-probe.cjs
const G = require("../prototype/shared/geometry.js");
const GAS = require("../prototype/shared/gas.js");
const S = require("../prototype/shared/simulation.js");

// Reference flood fill on a 1.5 px grid: area of air whose component reaches a
// band mouth, against all air. This is the geometry the 6 px mask approximates.
function reference(layout, step) {
	const x0 = -G.POUR;
	const y0 = -G.POUR;
	const nx = Math.ceil((G.SIZE + 2 * G.POUR) / step);
	const ny = nx;
	const air = new Uint8Array(nx * ny);
	for (let gy = 0; gy < ny; gy++) {
		const y = y0 + (gy + 0.5) * step;
		for (let gx = 0; gx < nx; gx++) {
			if (G.airClearance(layout, x0 + (gx + 0.5) * step, y) >= GAS.AIR_MIN) air[gy * nx + gx] = 1;
		}
	}
	const comp = new Int32Array(nx * ny).fill(-1);
	const stack = new Int32Array(nx * ny);
	let total = 0;
	let live = 0;
	for (let k = 0; k < air.length; k++) {
		if (!air[k] || comp[k] >= 0) continue;
		let top = 0;
		stack[top++] = k;
		comp[k] = k;
		let area = 0;
		let band = false;
		while (top) {
			const c = stack[--top];
			area++;
			const cx = c % nx;
			const cy = (c / nx) | 0;
			const wy = y0 + (cy + 0.5) * step;
			if (wy < 0 || wy > G.SIZE) band = true;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const xx = cx + dx;
					const yy = cy + dy;
					if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
					const n = yy * nx + xx;
					if (!air[n] || comp[n] >= 0) continue;
					comp[n] = k;
					stack[top++] = n;
				}
			}
		}
		total += area;
		if (band) live += area;
	}
	return { live: live / total, total };
}

function maskLive(gas) {
	let total = 0;
	let live = 0;
	for (let n = 0; n < gas.count; n++) {
		const k = gas.list[n];
		const weight = gas.open[k] * gas.cell * gas.cell;
		total += weight;
		if (gas.active[k] && !gas.pin[k]) live += weight;
	}
	return { live: live / total, comps: gas.compCount };
}

const sweep = { x: 0, y: 0, hit: false };
function laneHits(layout, x, y, dx, dy) {
	G.sweep(layout, x, y, x + dx, y + dy, GAS.AIR_MIN, sweep);
	return sweep.hit;
}
// An open face needs a lane across it that crosses no metal. The centre lane
// answers most faces; a seam aperture that opens off-centre needs a lateral one.
function hasLane(layout, x, y, dx, dy) {
	if (!laneHits(layout, x, y, dx, dy)) return true;
	const cell = Math.abs(dx) || Math.abs(dy);
	for (let q = -15; q <= 15; q++) {
		const s = (q / 33) * cell;
		if (Math.abs(s) > cell * 0.47) continue;
		const ox = dx === 0 ? s : 0;
		const oy = dy === 0 ? s : 0;
		if (!laneHits(layout, x + ox, y + oy, dx, dy)) return true;
	}
	return false;
}

console.log("mask vs 1.5 px reference (mouth-connected share of the air)");
for (const seed of [7, 42, 1234]) {
	const layout = G.createLayout(seed);
	for (const spin of [0, 0.12, 0.2, 0.3, 0.4]) {
		for (let k = 0; k < layout.valves.length; k++) G.setAngle(layout.valves[k], G.hashUnit(seed, k, 77) * spin);
		const ref = reference(layout, 1.5);
		const sim = S.create(layout, { turning: false });
		S.setPressure(sim, "grid");
		const mask = maskLive(sim.pressure);
		console.log(
			`  seed ${seed} spin ${String(spin).padEnd(4)} reference ${(ref.live * 100).toFixed(1)}% | ` +
				`mask ${(mask.live * 100).toFixed(1)}%, ${mask.comps} components`,
		);
	}
}

console.log("seam links (seed 7, four rotation states)");
{
	const layout = G.createLayout(7);
	const sim = S.create(layout, { turning: false });
	S.setPressure(sim, "grid");
	let links = 0;
	let offCentre = 0;
	let dead = 0;
	let conductance = 0;
	for (const spin of [0, 0.12, 0.3, 0.7]) {
		for (let k = 0; k < layout.valves.length; k++) G.setAngle(layout.valves[k], G.hashUnit(7, k, 77) * spin);
		GAS.refresh(sim, false);
		const net = sim.pressure.net;
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
				links++;
				conductance += net.gw[e];
				if (((sb - GAS.RSLOTS) % GAS.LANES) !== 1) offCentre++;
				G.sweep(layout, net.wx[a], net.wy[a], net.wx[b], net.wy[b], GAS.AIR_MIN, sweep);
				if (sweep.hit) dead++;
			}
		}
	}
	console.log(`  ${links} seam links, ${offCentre} on an off-centre lane, ${dead} blocked, conductance ${conductance.toFixed(1)}`);
}

console.log("rebuild cost");
function rebuildCost(label, turner) {
	const layout = G.createLayout(7);
	const sim = S.create(layout, { turning: false });
	S.setPressure(sim, "grid");
	for (let n = 0; n < 30; n++) {
		turner(layout, n);
		GAS.refresh(sim, false);
	}
	const t0 = performance.now();
	for (let n = 0; n < 30; n++) {
		turner(layout, n);
		GAS.refresh(sim, false);
	}
	console.log(`  ${label}: ${((performance.now() - t0) / 30).toFixed(3)} ms per rebuild, ${sim.pressure.count} air cells`);
}
rebuildCost("nothing changed", () => {});
rebuildCost("one rotor turning", (layout, n) => G.setAngle(layout.valves[44], 0.0016 * n));
rebuildCost("every rotor turning", (layout, n) => {
	for (let k = 0; k < layout.valves.length; k++) G.setAngle(layout.valves[k], n * 0.0016 + (k % 7) * 0.02);
});
