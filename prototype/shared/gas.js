// Low-resolution grid pressure field. Inlets pin the pour band high and the drain
// band low, and the pressure in between is the ratio of two porous path
// distances: how far the gas is from a source against how far it is from a vent.
// Air cells are cheap to cross and metal is expensive, so open passages become
// fast lanes that warp the field, a shut seam only leaks a trickle, and a
// standing bottom-to-top gradient survives while the rotors turn.
//
// Gas velocity is Darcy-like: proportional to the local pressure gradient divided
// by the cell's openness, so the pressure drop concentrates at the tight places
// (valve mouths, seam gaps, grain-packed cells) and the gas streams through them
// like a nozzle while open chambers stay nearly isobaric. That is what makes the
// air punctuate a fall instead of breathing on the whole field at once. Grains
// feel two couplings: drag toward the local gas velocity, and the pressure force
// itself, which lifts a grain against gravity wherever the field points up. Both
// scale with the page's air-force control. This is a normalized relative
// potential, not a calibrated thermodynamic gas. Occupancy feeds the potential
// on the mask clock even while the rotors are still, so a pile drops pressure
// across its thickness. Gas velocity is state: it relaxes toward Darcy and pays
// the impulse it delivers to grains, and pinned mouths restore it, so a dense
// pile damps the flow it sits in.
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
	// Openness of a cell from its clearance: a corridor cell is about half a cell
	// free, so it counts as fully open and a mouth a fraction of that is a nozzle.
	const OPEN_CLEAR = CELL * 0.5;
	const OPEN_MIN = 0.12;
	// Relative cost of pushing the potential through a metal cell; a shut seam is
	// a shared wall, not a hole.
	const METAL = 6;
	const FILL_COST = 3;
	const SWEEPS = 2;
	const FAR = 1e9;
	// Gradient to gas speed, px/s per unit pressure-per-px. A passage crossing the
	// field pays a gradient near 1.3e-3, so it flows around 150 px/s and a jet
	// through an open seam is two or three times faster.
	const SPEED_SCALE = 180000;
	const GAS_MAX = 460;
	// Grain coupling. Drag is a relaxation rate toward the gas; LIFT is pressure
	// force per unit gas velocity, in px/s^2 per px/s, so a passage lifting at
	// 150 px/s adds about a quarter of gravity.
	const DRAG = 1.35;
	const LIFT = 1.15;
	const GRAIN_CAPACITY = 1.5;
	// Blend toward Darcy each mask tick, and the air mass of one cell in grain
	// units. A falling grain keeps meeting fresh cells, so it still feels the
	// lift; a sitting pile drains the same cells until the mouths restore them.
	const RELAX = 0.2;
	const CELL_MASS = 1;

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
			open: new Float32Array(COUNT),
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
			maskClock: 0,
			updates: 0,
			rebuilds: 0,
			drags: 0,
			mean: 0,
			flow: 0,
			gain: 0,
		};
		gas.p.fill(0.5);
		rebuild(sim, gas);
		applyPins(sim, gas);
		update(sim, gas, true);
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
				const clear = G.airClearance(layout, gx * CELL + CELL / 2, y);
				if (clear < AIR_MIN) continue;
				const k = gy * NX + gx;
				air[k] = 1;
				gas.list[gas.count++] = k;
				const open = clear / OPEN_CLEAR;
				gas.open[k] = open > 1 ? 1 : open < OPEN_MIN ? OPEN_MIN : open;
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
		const open = gas.open;
		for (let n = 0; n < gas.count; n++) {
			const k = gas.list[n];
			let f = fill[k] / GRAIN_CAPACITY;
			if (f > 1) f = 1;
			fill[k] = f;
			cost[k] = (1 + FILL_COST * f) / open[k];
		}
		const air = gas.air;
		for (let k = 0; k < COUNT; k++) if (!air[k]) cost[k] = METAL;
	}

	// Fast sweeping for a porous path distance: alternating directional passes
	// carry a source's influence across the grid in a few sweeps, and every cell
	// pays its own crossing cost.
	function distances(gas, dist, level) {
		const pin = gas.pin;
		const face = gas.face;
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

	// Pressure, then the porous velocity it implies. `snap` writes Darcy
	// straight into the velocity state (new mask, new pins); otherwise the
	// interior relaxes toward it so grain impulses can persist.
	function update(sim, gas, snap) {
		measureCost(sim, gas);
		if (!gas.pins) {
			gas.gx.fill(0);
			gas.gy.fill(0);
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
		const pin = gas.pin;
		let flow = 0;
		for (let n = 0; n < gas.count; n++) {
			const k = gas.list[n];
			const f = face[k];
			const c = p[k];
			// Darcy flux from the gradient, then the interstitial speed that same flux
			// has to reach through a cell this tight. Central difference over two
			// cells, so this is a gradient per pixel.
			const scale = (SPEED_SCALE / (2 * CELL)) / cost[k];
			const ux = ((f & L ? p[k - 1] : c) - (f & R ? p[k + 1] : c)) * scale;
			const uy = ((f & U ? p[k - NX] : c) - (f & D ? p[k + NX] : c)) * scale;
			let vx = ux;
			let vy = uy;
			const speed = Math.sqrt(vx * vx + vy * vy);
			if (speed > GAS_MAX) {
				const s = GAS_MAX / speed;
				vx *= s;
				vy *= s;
			}
			if (snap || pin[k]) {
				gx[k] = vx;
				gy[k] = vy;
			} else {
				gx[k] += (vx - gx[k]) * RELAX;
				gy[k] += (vy - gy[k]) * RELAX;
			}
			flow += Math.sqrt(gx[k] * gx[k] + gy[k] * gy[k]);
		}
		gas.mean = gas.count ? sum / gas.count : 0;
		gas.flow = gas.count ? flow / gas.count : 0;
		gas.updates++;
	}

	function maybeSolve(sim, gas) {
		if (gas.clock - gas.maskClock < MASK_DT) return;
		const valves = sim.layout.valves;
		let moved = false;
		for (let k = 0; k < valves.length; k++) {
			if (Math.abs(valves[k].angle - gas.angles[k]) > ANGLE_EPS) {
				moved = true;
				break;
			}
		}
		if (moved) {
			rebuild(sim, gas);
			applyPins(sim, gas);
		}
		update(sim, gas, moved);
		gas.maskClock = gas.clock;
	}

	// A grain resting on a wall or a rim sits in a cell whose centre is metal, so
	// the nearest air cell stands in for the flow around it; without this the
	// grains that are actually visible in a pile feel no air at all.
	function sampleCell(gas, x, y) {
		const k = index(x, y);
		if (gas.air[k]) return k;
		const gx = k % NX;
		const gy = (k / NX) | 0;
		let best = -1;
		let bestD = Infinity;
		for (let oy = gy - 1; oy <= gy + 1; oy++) {
			if (oy < 0 || oy >= NY) continue;
			for (let ox = gx - 1; ox <= gx + 1; ox++) {
				if (ox < 0 || ox >= NX) continue;
				const j = oy * NX + ox;
				if (!gas.air[j]) continue;
				const dx = (ox + 0.5) * CELL - x;
				const dy = (oy + 0.5) * CELL - (y + G.POUR);
				const d = dx * dx + dy * dy;
				if (d >= bestD) continue;
				bestD = d;
				best = j;
			}
		}
		return best;
	}

	// Two couplings: drag toward the local gas velocity, and the pressure force
	// itself, which lifts a still grain wherever the field points up. The cell
	// pays that impulse unless it is a pinned mouth. Air is left out of the
	// reservoir bands: a grain waiting in a pour slot is not yet in the machine,
	// and holding it there would stop the field from being fed.
	// integrate() keeps the result inside the grain speed ceiling.
	function drag(sim, gas, h) {
		if (!gas.count) return;
		const force = sim.airForce;
		if (force <= 0) return;
		const drag = DRAG * force;
		const lift = LIFT * force;
		const invMass = 1 / CELL_MASS;
		const gx = gas.gx;
		const gy = gas.gy;
		const pin = gas.pin;
		for (let k = 0; k < sim.count; k++) {
			const y = sim.y[k];
			if (y < 0 || y > G.SIZE) continue;
			const idx = sampleCell(gas, sim.x[k], y);
			if (idx < 0) continue;
			const gvx = gx[idx];
			const gvy = gy[idx];
			if (gvx === 0 && gvy === 0) continue;
			const jx = (drag * (gvx - sim.vx[k]) + lift * gvx) * h;
			const jy = (drag * (gvy - sim.vy[k]) + lift * gvy) * h;
			sim.vx[k] += jx;
			sim.vy[k] += jy;
			if (!pin[idx]) {
				gx[idx] -= jx * invMass;
				gy[idx] -= jy * invMass;
				const sp = Math.sqrt(gx[idx] * gx[idx] + gy[idx] * gy[idx]);
				if (sp > GAS_MAX) {
					const s = GAS_MAX / sp;
					gx[idx] *= s;
					gy[idx] *= s;
				}
			}
			gas.gain += (jx < 0 ? -jx : jx) + (jy < 0 ? -jy : jy);
			gas.drags++;
		}
	}

	// Re-pin and re-solve now: a paused page changes a mouth or a rotor while the
	// clock is stopped, and the overlay should answer immediately.
	function refresh(sim) {
		const gas = sim.pressure;
		rebuild(sim, gas);
		applyPins(sim, gas);
		update(sim, gas, true);
		gas.maskClock = gas.clock;
	}

	function step(sim, h) {
		const gas = sim.pressure;
		gas.clock += h;
		maybeSolve(sim, gas);
		if (gas.inletVersion !== sim.inlets.version) {
			applyPins(sim, gas);
			update(sim, gas, true);
		}
		drag(sim, gas, h);
	}

	return { create, step, refresh, index, sampleCell, CELL, NX, NY, AIR_MIN, DRAG, LIFT, SPEED_SCALE, GAS_MAX, RELAX, CELL_MASS };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveGas;
