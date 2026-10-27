// Low-resolution grid pressure field. Inlets pin the pour band high and the drain
// band low, and the pressure in between is the ratio of two porous path
// distances: how far the gas is from a source against how far it is from a vent.
// Air cells are cheap to cross and metal is expensive, so open passages become
// fast lanes that warp the field, a shut seam only leaks a trickle, and a
// standing bottom-to-top gradient survives while the rotors turn.
//
// Gas velocity is Darcy-like inside air only: proportional to the pressure
// gradient and throttled by grain-filled cells, so grains feel the induced flow
// as drag. This is a normalized relative potential, not a calibrated
// thermodynamic gas; momentum is supplied and absorbed by the pinned reservoirs,
// so grain drag is one-way.
const ValveGas = (() => {
	"use strict";
	const G = typeof ValveGeometry !== "undefined" ? ValveGeometry : require("./geometry.js");

	// One grid column per valve column keeps a band cell's owner unambiguous.
	const CELL = 6;
	const NX = Math.ceil(G.SIZE / CELL);
	const NY = Math.ceil((G.SIZE + 2 * G.POUR) / CELL);
	const COUNT = NX * NY;

	const L = 1;
	const R = 2;
	const U = 4;
	const D = 8;

	const MASK_DT = 1 / 30;
	const ANGLE_EPS = 0.02;
	const AIR_MIN = 0.75;
	// Relative cost of pushing the potential through a metal cell; a shut seam is
	// a shared wall, not a hole.
	const METAL = 6;
	const FILL_COST = 3;
	const SWEEPS = 2;
	const FAR = 1e9;
	// Pressure gradient -> gas speed, px^2/s. A full-field gradient is about
	// 1 / (SIZE + 2 * POUR), so a wide open shaft flows near GAS_MAX.
	const CONDUCTANCE = 60000;
	const GAS_MAX = 220;
	const DRAG = 3.2;
	const GRAIN_CAPACITY = 1.5;

	function index(x, y) {
		let gx = (x / CELL) | 0;
		let gy = ((y + G.POUR) / CELL) | 0;
		if (gx < 0) gx = 0;
		else if (gx >= NX) gx = NX - 1;
		if (gy < 0) gy = 0;
		else if (gy >= NY) gy = NY - 1;
		return gy * NX + gx;
	}

	function create(sim) {
		const gas = {
			kind: "grid",
			cell: CELL,
			nx: NX,
			ny: NY,
			p: new Float32Array(COUNT),
			air: new Uint8Array(COUNT),
			face: new Uint8Array(COUNT),
			pin: new Uint8Array(COUNT),
			cost: new Float32Array(COUNT),
			fill: new Float32Array(COUNT),
			gx: new Float32Array(COUNT),
			gy: new Float32Array(COUNT),
			list: new Int32Array(COUNT),
			count: 0,
			fromHigh: new Float32Array(COUNT),
			fromLow: new Float32Array(COUNT),
			band: new Int32Array(COUNT),
			bandSide: new Uint8Array(COUNT),
			bandColumn: new Uint8Array(COUNT),
			bandCount: 0,
			pins: 0,
			angles: new Float64Array(G.N * G.N),
			inletVersion: -1,
			clock: 0,
			maskClock: -1,
			updates: 0,
			rebuilds: 0,
			drags: 0,
			mean: 0,
			flow: 0,
		};
		gas.p.fill(0.5);
		rebuild(sim, gas);
		applyPins(sim, gas);
		update(sim, gas);
		return gas;
	}

	// Air mask and open faces. A face between two air cells is open only when the
	// wall between their centres is air too, so a rim thinner than a cell cannot
	// pass a jet.
	function rebuild(sim, gas) {
		const layout = sim.layout;
		const air = gas.air;
		const face = gas.face;
		air.fill(0);
		face.fill(0);
		gas.count = 0;
		for (let gy = 0; gy < NY; gy++) {
			const y = gy * CELL + CELL / 2 - G.POUR;
			for (let gx = 0; gx < NX; gx++) {
				if (G.airClearance(layout, gx * CELL + CELL / 2, y) < AIR_MIN) continue;
				const k = gy * NX + gx;
				air[k] = 1;
				gas.list[gas.count++] = k;
			}
		}
		const list = gas.list;
		for (let n = 0; n < gas.count; n++) {
			const k = list[n];
			const gx = k % NX;
			const gy = (k / NX) | 0;
			const x = gx * CELL + CELL / 2;
			const y = gy * CELL + CELL / 2 - G.POUR;
			if (gx + 1 < NX && air[k + 1] && G.airClearance(layout, x + CELL / 2, y) >= AIR_MIN) {
				face[k] |= R;
				face[k + 1] |= L;
			}
			if (gy + 1 < NY && air[k + NX] && G.airClearance(layout, x, y + CELL / 2) >= AIR_MIN) {
				face[k] |= D;
				face[k + NX] |= U;
			}
		}
		// Band cells are the reservoir mouths, the only cells an inlet pins.
		gas.bandCount = 0;
		for (let n = 0; n < gas.count; n++) {
			const k = list[n];
			const y = ((k / NX) | 0) * CELL + CELL / 2 - G.POUR;
			if (y < 0) addBand(gas, k, 0);
			else if (y > G.SIZE) addBand(gas, k, 1);
		}
		const valves = layout.valves;
		for (let k = 0; k < valves.length; k++) gas.angles[k] = valves[k].angle;
		gas.rebuilds++;
	}

	function addBand(gas, k, side) {
		if (gas.bandCount >= gas.band.length) return;
		const column = (((k % NX) * CELL + CELL / 2) / G.S) | 0;
		gas.band[gas.bandCount] = k;
		gas.bandSide[gas.bandCount] = side;
		gas.bandColumn[gas.bandCount] = column < 0 ? 0 : column > G.N - 1 ? G.N - 1 : column;
		gas.bandCount++;
	}

	function applyPins(sim, gas) {
		const inlets = sim.inlets;
		gas.pin.fill(0);
		gas.pins = 0;
		for (let n = 0; n < gas.bandCount; n++) {
			const k = gas.band[n];
			const inlet = gas.bandSide[n] * G.N + gas.bandColumn[n];
			if (!inlets.open[inlet]) continue;
			gas.pin[k] = inlets.level[inlet] + 1;
			gas.pins++;
		}
		gas.inletVersion = inlets.version;
	}

	function measureCost(sim, gas) {
		const fill = gas.fill;
		for (let n = 0; n < gas.count; n++) fill[gas.list[n]] = 0;
		for (let k = 0; k < sim.count; k++) {
			const idx = index(sim.x[k], sim.y[k]);
			if (gas.air[idx]) fill[idx]++;
		}
		const cost = gas.cost;
		for (let n = 0; n < gas.count; n++) {
			const k = gas.list[n];
			let f = fill[k] / GRAIN_CAPACITY;
			if (f > 1) f = 1;
			fill[k] = f;
			cost[k] = 1 + FILL_COST * f;
		}
		const air = gas.air;
		for (let k = 0; k < COUNT; k++) if (!air[k]) cost[k] = METAL;
	}

	// Fast sweeping for a porous path distance: alternating directional passes
	// carry a source's influence across the grid in a few sweeps, and every cell
	// pays its own crossing cost.
	function distances(gas, dist, level) {
		const pin = gas.pin;
		const cost = gas.cost;
		dist.fill(FAR);
		const want = level + 1;
		for (let n = 0; n < gas.count; n++) {
			const k = gas.list[n];
			if (pin[k] === want) dist[k] = 0;
		}
		for (let pass = 0; pass < SWEEPS; pass++) {
			for (let gy = 0; gy < NY; gy++) {
				for (let gx = 0; gx < NX; gx++) {
					const k = gy * NX + gx;
					const d = dist[k];
					if (d === 0) continue;
					const c = cost[k];
					let best = d;
					if (gx > 0) {
						const v = dist[k - 1] + c;
						if (v < best) best = v;
					}
					if (gy > 0) {
						const v = dist[k - NX] + c;
						if (v < best) best = v;
					}
					dist[k] = best;
				}
			}
			for (let gy = NY - 1; gy >= 0; gy--) {
				for (let gx = NX - 1; gx >= 0; gx--) {
					const k = gy * NX + gx;
					const d = dist[k];
					if (d === 0) continue;
					const c = cost[k];
					let best = d;
					if (gx + 1 < NX) {
						const v = dist[k + 1] + c;
						if (v < best) best = v;
					}
					if (gy + 1 < NY) {
						const v = dist[k + NX] + c;
						if (v < best) best = v;
					}
					dist[k] = best;
				}
			}
		}
	}

	// Pressure, then the porous velocity it implies.
	function update(sim, gas) {
		measureCost(sim, gas);
		if (!gas.pins) {
			gas.mean = 0;
			gas.flow = 0;
			gas.updates++;
			return;
		}
		distances(gas, gas.fromHigh, 1);
		distances(gas, gas.fromLow, 0);
		const p = gas.p;
		const fromHigh = gas.fromHigh;
		const fromLow = gas.fromLow;
		let sum = 0;
		for (let n = 0; n < gas.count; n++) {
			const k = gas.list[n];
			p[k] = fromLow[k] / (fromHigh[k] + fromLow[k]);
			sum += p[k];
		}
		const face = gas.face;
		const cost = gas.cost;
		const gx = gas.gx;
		const gy = gas.gy;
		// Central difference over two cells, so the gradient is per pixel.
		const scale = CONDUCTANCE / (2 * CELL);
		let flow = 0;
		for (let n = 0; n < gas.count; n++) {
			const k = gas.list[n];
			const f = face[k];
			const c = p[k];
			const open = 1 / cost[k];
			const ux = ((f & L ? p[k - 1] : c) - (f & R ? p[k + 1] : c)) * open;
			const uy = ((f & U ? p[k - NX] : c) - (f & D ? p[k + NX] : c)) * open;
			let vx = ux * scale;
			let vy = uy * scale;
			const speed = Math.sqrt(vx * vx + vy * vy);
			if (speed > GAS_MAX) {
				const s = GAS_MAX / speed;
				vx *= s;
				vy *= s;
				flow += GAS_MAX;
			} else {
				flow += speed;
			}
			gx[k] = vx;
			gy[k] = vy;
		}
		gas.mean = gas.count ? sum / gas.count : 0;
		gas.flow = gas.count ? flow / gas.count : 0;
		gas.updates++;
	}

	function maybeRebuild(sim, gas) {
		if (gas.clock - gas.maskClock < MASK_DT) return;
		const valves = sim.layout.valves;
		let moved = false;
		for (let k = 0; k < valves.length; k++) {
			if (Math.abs(valves[k].angle - gas.angles[k]) > ANGLE_EPS) {
				moved = true;
				break;
			}
		}
		if (!moved) return;
		rebuild(sim, gas);
		applyPins(sim, gas);
		update(sim, gas);
		gas.maskClock = gas.clock;
	}

	// Drag grains toward the local gas velocity; integrate() keeps the result
	// inside the grain speed ceiling.
	function drag(sim, gas, h) {
		if (!gas.count) return;
		for (let k = 0; k < sim.count; k++) {
			const idx = index(sim.x[k], sim.y[k]);
			if (!gas.air[idx]) continue;
			const gvx = gas.gx[idx];
			const gvy = gas.gy[idx];
			if (gvx === 0 && gvy === 0) continue;
			sim.vx[k] += DRAG * (gvx - sim.vx[k]) * h;
			sim.vy[k] += DRAG * (gvy - sim.vy[k]) * h;
			gas.drags++;
		}
	}

	// Re-pin and re-solve now: a paused page changes a mouth or a rotor while the
	// clock is stopped, and the overlay should answer immediately.
	function refresh(sim) {
		const gas = sim.pressure;
		rebuild(sim, gas);
		applyPins(sim, gas);
		update(sim, gas);
		gas.maskClock = gas.clock;
	}

	function step(sim, h) {
		const gas = sim.pressure;
		gas.clock += h;
		maybeRebuild(sim, gas);
		if (gas.inletVersion !== sim.inlets.version) {
			applyPins(sim, gas);
			update(sim, gas);
		}
		drag(sim, gas, h);
	}

	return { create, step, refresh, index, CELL, NX, NY, AIR_MIN, DRAG, CONDUCTANCE, METAL };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveGas;
