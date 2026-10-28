// Regression checks for pressure exchange in disconnected casing pipes and
// through short-lived openings of a rotating valve.
// Run: node experiments/pressure-propagation-fixtures.cjs
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const GAS = require("../prototype/shared/gas.js");
const S = require("../prototype/shared/simulation.js");

const SEGMENTS = (GAS.SLOTS - GAS.RSLOTS) / (4 * GAS.LANES);
const CENTER = 44;
const NEIGHBOR = 45;

function casing(tile, side, lane) {
	return tile * GAS.SLOTS + GAS.RSLOTS + side * SEGMENTS * GAS.LANES + lane;
}

function blankLayout() {
	const valves = [];
	for (let j = 0; j < G.N; j++) {
		for (let i = 0; i < G.N; i++) valves.push(G.makeValve(i, j, "solid", [], 0, 0));
	}
	return { seed: 1, valves };
}

function closeMouths(sim) {
	for (let k = 0; k < sim.inlets.count; k++) {
		if (sim.inlets.open[k]) S.toggleInlet(sim, k, false);
	}
}

function corridorNodes() {
	const nodes = [];
	for (let lane = 0; lane < GAS.LANES; lane++) {
		nodes.push(casing(CENTER, 0, lane), casing(NEIGHBOR, 2, lane));
	}
	return nodes;
}

function sum(net, nodes) {
	let total = 0;
	for (const k of nodes) total += net.p[k];
	return total;
}

function corridorAverage(net, tile, side) {
	let total = 0;
	for (let lane = 0; lane < GAS.LANES; lane++) total += net.p[casing(tile, side, lane)];
	return total / GAS.LANES;
}

function testCasing(sealed) {
	const sim = S.create(blankLayout(), { turning: false });
	S.setPressure(sim, "grid");
	if (sealed) closeMouths(sim);
	const gas = sim.pressure;
	const net = gas.net;
	const nodes = corridorNodes();
	for (let lane = 0; lane < GAS.LANES; lane++) {
		net.p[casing(CENTER, 0, lane)] = 1;
		net.p[casing(NEIGHBOR, 2, lane)] = 0;
	}
	GAS.refresh(sim, sealed);
	assert.equal(net.comp[nodes[0]], net.comp[nodes[1]], "adjacent casing halves share a pipe");
	assert.equal(net.active[nodes[0]], 0, "the pipe is isolated from all open mouths");
	assert.equal(gas.pins === 0, sealed, "cover both open and fully sealed machines");
	const before = sum(net, nodes);
	const other = casing(CENTER, 1, 1);
	const otherBefore = net.p[other];
	S.step(sim);
	const right = corridorAverage(net, NEIGHBOR, 2);
	assert.ok(right > 0.05, `an unpinned casing pipe exchanges pressure on the next tick (${right.toFixed(3)})`);
	assert.ok(corridorAverage(net, CENTER, 0) < 0.95, "the source half loses the air the other half receives");
	assert.ok(Math.abs(sum(net, nodes) - before) < 1e-3, "an isolated pipe conserves its air");
	assert.equal(net.p[other], otherBefore, "air cannot escape into a separate pipe through a blank rotor");
	let projected = false;
	for (let n = 0; n < gas.count; n++) {
		const k = gas.list[n];
		if (gas.map[k] !== nodes[1]) continue;
		assert.equal(gas.p[k], net.p[nodes[1]], "the casing overlay shows the exchanged pressure");
		projected = true;
	}
	assert.ok(projected, "the receiving casing has display texels");
	for (let k = 0; k < 60; k++) S.step(sim);
	assert.ok(Math.abs(sum(net, nodes) - before) < 1e-3, "the pipe remains conservative as it settles");
	assert.ok(Math.abs(corridorAverage(net, CENTER, 0) - corridorAverage(net, NEIGHBOR, 2)) < 0.01,
		"the two halves equalize without a reservoir");
}

function testIndependentPockets() {
	const sim = S.create(blankLayout(), { turning: false });
	S.setPressure(sim, "grid");
	closeMouths(sim);
	const net = sim.pressure.net;
	const a = corridorNodes();
	const b = [];
	for (let lane = 0; lane < GAS.LANES; lane++) {
		b.push(casing(22, 0, lane), casing(23, 2, lane));
		net.p[casing(CENTER, 0, lane)] = 1;
		net.p[casing(22, 0, lane)] = 0.9;
		net.p[casing(23, 2, lane)] = 0.2;
	}
	GAS.refresh(sim, false);
	assert.notEqual(net.comp[a[0]], net.comp[b[0]], "separate corridors belong to separate pockets");
	const beforeA = sum(net, a);
	const beforeB = sum(net, b);
	for (let k = 0; k < 48; k++) S.step(sim);
	assert.ok(Math.abs(sum(net, a) - beforeA) < 1e-3, "the first pocket conserves its own air");
	assert.ok(Math.abs(sum(net, b) - beforeB) < 1e-3, "the second pocket conserves its own air");
	assert.ok(Math.abs(corridorAverage(net, 22, 0) - corridorAverage(net, 23, 2)) < 0.01,
		"the second isolated pocket also equalizes");
}

function rotorAndCorridor(net) {
	const nodes = corridorNodes();
	const base = CENTER * GAS.SLOTS;
	for (let slot = 0; slot < GAS.RSLOTS; slot++) {
		const k = base + slot;
		if (net.air[k]) nodes.push(k);
	}
	return nodes;
}

function seamLinks(net) {
	let count = 0;
	const base = CENTER * GAS.SLOTS;
	for (let slot = 0; slot < GAS.RSLOTS; slot++) {
		const k = base + slot;
		for (let m = 0; m < net.nbrCount[k]; m++) {
			const j = net.nbr[k * net.slots + m];
			if (j >= base + GAS.RSLOTS && j < base + GAS.SLOTS) count++;
		}
	}
	return count;
}

function spinPastOpening(direction, phase) {
	const layout = blankLayout();
	const valve = layout.valves[CENTER] = G.makeValve(4, 4, "solid", [0], 0, 0);
	G.setAngle(valve, -direction * 0.3);
	const sim = S.create(layout, { turning: false, speed: 3 });
	S.setPressure(sim, "grid");
	const gas = sim.pressure;
	const net = gas.net;
	const nodes = rotorAndCorridor(net);
	for (let k = CENTER * GAS.SLOTS; k < CENTER * GAS.SLOTS + GAS.RSLOTS; k++) {
		if (net.air[k]) net.p[k] = 1;
	}
	GAS.refresh(sim, false);
	const before = sum(net, nodes);
	assert.equal(seamLinks(net), 0, "the starting rim is closed");
	for (let k = 0; k < phase; k++) S.step(sim);
	assert.equal(corridorAverage(net, CENTER, 0), 0, "a shut rim does not leak");
	sim.rate[CENTER] = 5;
	sim.target[CENTER] = direction * 0.3;
	S.step(sim);
	assert.ok(valve.seam[0] > GAS.AIR_MIN, "the first turn tick opens the port");
	assert.ok(Math.abs(gas.angles[CENTER] - valve.angle) < 1e-8, "the seam graph follows the current angle on that tick");
	assert.ok(seamLinks(net) > 0, "the open seam is linked on that tick");
	const first = corridorAverage(net, CENTER, 0);
	assert.ok(first > 0.001, `pressure enters the casing as soon as the port opens (${first.toFixed(4)})`);
	for (let k = 0; k < 5; k++) S.step(sim);
	assert.ok(Math.abs(valve.angle - direction * 0.3) < 1e-8, "the rotor has crossed the port");
	assert.equal(seamLinks(net), 0, "the graph closes again without waiting for a mask tick");
	const transferred = corridorAverage(net, NEIGHBOR, 2);
	assert.ok(transferred > 0.05, `a short opening transports pressure before it closes (${transferred.toFixed(3)})`);
	assert.ok(Math.abs(sum(net, nodes) - before) < 1e-3, "rotation and exchange conserve isolated air");
	for (let k = 0; k < 12; k++) S.step(sim);
	assert.ok(Math.abs(sum(net, nodes) - before) < 1e-3, "a shut rim retains air on both sides");
	return transferred;
}

function testValveCatalogue() {
	const layout = blankLayout();
	const types = G.TYPES.filter(type => type.ports.length);
	const tiles = [];
	for (let i = 0; i < types.length; i++) {
		const col = 1 + 2 * (i % 4);
		const row = 2 + 2 * Math.floor(i / 4);
		const tile = row * G.N + col;
		const type = types[i];
		const valve = G.makeValve(col, row, type.kind, type.ports, 0, G.RV * 0.8);
		G.setAngle(valve, -0.3);
		layout.valves[tile] = valve;
		tiles.push(tile);
	}
	const sim = S.create(layout, { turning: false, speed: 3 });
	S.setPressure(sim, "grid");
	const net = sim.pressure.net;
	const samples = 720;
	const angleStep = G.TAU / samples;
	const states = types.map(() => Array.from({ length: 4 }, () => new Uint8Array(samples)));
	const sideSlots = (GAS.SLOTS - GAS.RSLOTS) / 4;
	for (let n = 0; n < samples; n++) {
		for (const tile of tiles) G.setAngle(layout.valves[tile], n * angleStep);
		GAS.refresh(sim, false);
		for (let i = 0; i < types.length; i++) {
			const base = tiles[i] * GAS.SLOTS;
			for (let slot = 0; slot < GAS.RSLOTS; slot++) {
				const k = base + slot;
				for (let m = 0; m < net.nbrCount[k]; m++) {
					const edge = k * net.slots + m;
					const casingSlot = net.nbr[edge] - base - GAS.RSLOTS;
					if (casingSlot < 0 || casingSlot >= 4 * sideSlots || net.gw[edge] <= 0) continue;
					states[i][(casingSlot / sideSlots) | 0][n] = 1;
				}
			}
		}
	}
	// The UI's fastest scheduled turn advances less than this per fixed tick.
	const maxAdvance = 1.6 * Math.PI * 3 * S.STEP;
	for (let i = 0; i < types.length; i++) {
		for (const state of states[i]) {
			const closed = state.indexOf(0);
			assert.ok(closed >= 0, `${types[i].id} has shut intervals`);
			let run = 0;
			let openings = 0;
			for (let n = 1; n <= samples; n++) {
				if (state[(closed + n) % samples]) run++;
				else if (run) {
					assert.ok((run - 1) * angleStep > maxAdvance, `${types[i].id} opening cannot be skipped at speed 3`);
					openings++;
					run = 0;
				}
			}
			assert.equal(openings, types[i].ports.length, `${types[i].id} exposes each port when it passes a casing side`);
		}
	}
	for (const tile of tiles) G.setAngle(layout.valves[tile], -0.3);
	GAS.refresh(sim, false);
	for (const tile of tiles) {
		for (let k = tile * GAS.SLOTS; k < tile * GAS.SLOTS + GAS.RSLOTS; k++) {
			if (net.air[k]) net.p[k] = 1;
		}
		sim.rate[tile] = 5;
		sim.target[tile] = 0.3;
	}
	GAS.refresh(sim, false);
	S.step(sim);
	for (let i = 0; i < types.length; i++) {
		const transferred = corridorAverage(net, tiles[i], 0);
		assert.ok(transferred > 0.05, `${types[i].id} transfers pressure on its opening tick (${transferred.toFixed(3)})`);
	}
}

function testBoundaryOpening(side) {
	const layout = blankLayout();
	const row = side === 1 ? G.N - 1 : 0;
	const tile = row * G.N + 4;
	const valve = layout.valves[tile] = G.makeValve(4, row, "solid", [side], 0, 0);
	G.setAngle(valve, -0.3);
	const sim = S.create(layout, { turning: false, speed: 3 });
	S.setPressure(sim, "grid");
	const gas = sim.pressure;
	const net = gas.net;
	const base = tile * GAS.SLOTS;
	const initial = side === 1 ? 0 : 1;
	const rotor = [];
	for (let k = base; k < base + GAS.RSLOTS; k++) {
		if (!net.air[k]) continue;
		rotor.push(k);
		net.p[k] = initial;
	}
	GAS.refresh(sim, false);
	assert.equal(net.active[rotor[0]], 0, "a shut rotor is initially separated from the reservoir");
	sim.rate[tile] = 5;
	sim.target[tile] = 0.3;
	S.step(sim);
	assert.equal(net.active[rotor[0]], 1, "the open seam connects to the reservoir on the next tick");
	const average = sum(net, rotor) / rotor.length;
	assert.ok(Math.abs(average - initial) > 0.05, "the reservoir immediately changes pressure inside the turning rotor");
	for (let n = 0; n < net.count; n++) {
		const k = net.list[n];
		if (net.pin[k]) assert.equal(net.p[k], net.pin[k] === 2 ? 1 : 0, "reservoir nodes stay pinned");
	}
	for (let k = 0; k < 5; k++) S.step(sim);
	assert.equal(net.active[rotor[0]], 0, "the rotor disconnects again when its rim closes");
}

function clockMachine(spin) {
	const layout = blankLayout();
	for (let j = 0; j < G.N; j++) layout.valves[j * G.N + 4] = G.makeValve(4, j, "solid", [1, 3], 0, 0);
	const sim = S.create(layout, { turning: false, speed: 3 });
	S.setPressure(sim, "grid");
	closeMouths(sim);
	const net = sim.pressure.net;
	for (let n = 0; n < net.count; n++) {
		const k = net.list[n];
		net.p[k] = net.owner[k] % G.N === 4 && net.wy[k] > G.SIZE * 0.6 ? 1 : 0;
	}
	GAS.refresh(sim, false);
	if (spin) {
		sim.rate[99] = 5;
		sim.target[99] = 8;
	}
	return sim;
}

function testPausedSettling() {
	const sim = S.create(blankLayout(), { turning: false });
	S.setPressure(sim, "grid");
	const gas = sim.pressure;
	const net = gas.net;
	for (let lane = 0; lane < GAS.LANES; lane++) net.p[casing(CENTER, 0, lane)] = 1;
	GAS.refresh(sim, false);
	S.settlePressure(sim, 0);
	assert.equal(corridorAverage(net, NEIGHBOR, 2), 0, "zero elapsed time does not diffuse");
	assert.ok(gas.fastPending, "a zero-time call does not consume the pending update");
	S.settlePressure(sim, S.STEP);
	assert.ok(corridorAverage(net, NEIGHBOR, 2) > 0.05, "a paused field exchanges air on the next elapsed tick");
}

function testClockScaling() {
	const still = clockMachine(false);
	const spinning = clockMachine(true);
	for (let k = 0; k < 12; k++) {
		S.step(still);
		S.step(spinning);
	}
	const a = still.pressure.net;
	const b = spinning.pressure.net;
	let max = 0;
	let total = 0;
	let count = 0;
	for (let n = 0; n < a.count; n++) {
		const k = a.list[n];
		if (a.owner[k] % G.N !== 4) continue;
		const diff = Math.abs(a.p[k] - b.p[k]);
		max = Math.max(max, diff);
		total += diff;
		count++;
	}
	assert.ok(spinning.pressure.solves > still.pressure.solves, "the unrelated rotor forces more frequent updates");
	assert.ok(max < 0.08 && total / count < 0.04,
		"more frequent updates use elapsed time rather than diffusing the unrelated pipe several times faster");
}

function testSealedRotation() {
	for (const seed of [7, 42]) {
		const sim = S.create(G.createLayout(seed), { speed: 3 });
		S.setPressure(sim, "grid");
		closeMouths(sim);
		const gas = sim.pressure;
		const net = gas.net;
		const nodes = Array.from(net.list.subarray(0, net.count));
		const before = sum(net, nodes);
		for (let step = 0; step < 240; step++) {
			S.step(sim);
			for (const k of nodes) assert.ok(Number.isFinite(net.p[k]) && net.p[k] >= 0 && net.p[k] <= 1, "turning air stays bounded");
		}
		assert.ok(gas.rebuilds > 50, "many rotating seams were sampled");
		assert.ok(Math.abs(sum(net, nodes) - before) < 0.01, "a sealed rotating machine conserves its total air");
	}
}

function testWallOccupancy() {
	const layout = G.createLayout(7);
	for (let k = 0; k < layout.valves.length; k++) G.setAngle(layout.valves[k], G.hashUnit(7, k, 14) * 1.5);
	const sim = S.create(layout, { turning: false });
	S.setPressure(sim, "grid");
	const gas = sim.pressure;
	let x0 = 0;
	let y0 = 0;
	let sample = -1;
	for (let y = 1; y < G.SIZE && sample < 0; y += 1.5) {
		for (let x = 1; x < G.SIZE; x += 1.5) {
			if (gas.air[GAS.index(x, y)] || G.airClearance(layout, x, y) < 2.7) continue;
			sample = GAS.sampleCell(gas, x, y);
			if (sample < 0) continue;
			x0 = x;
			y0 = y;
			break;
		}
	}
	assert.ok(sample >= 0, "a valid grain can overlap a metal-centred display texel");
	const node = gas.map[sample];
	assert.notEqual(node, sample, "display texel indices and network node indices are distinct");
	S.addGrain(sim, x0, y0, 2.7, 0);
	GAS.step(sim, 1 / 30);
	assert.ok(gas.net.fill[node] > 0, "a grain near a wall throttles the mapped air node");
}

testCasing(false);
testCasing(true);
testIndependentPockets();
let lowestTransfer = 1;
for (const direction of [-1, 1]) {
	for (let phase = 0; phase < 4; phase++) lowestTransfer = Math.min(lowestTransfer, spinPastOpening(direction, phase));
}
testValveCatalogue();
testBoundaryOpening(1);
testBoundaryOpening(3);
testPausedSettling();
testClockScaling();
testSealedRotation();
testWallOccupancy();
console.log(`OK pressure propagation: isolated casing equalizes and conserves air with mouths open or sealed; fast turns transfer at least ${lowestTransfer.toFixed(3)} pressure in both directions at all four mask phases; all valve types, elapsed-time scaling, sealed rotation and wall occupancy verified`);
