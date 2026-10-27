// Low-resolution grid pressure field. Inlets pin the pour band high and the drain
// band low, and the pressure in between is the ratio of two porous path
// distances: how far the gas is from a source against how far it is from a vent.
// Air cells are cheap to cross and metal is expensive, so open passages become
// fast lanes that warp the field, a shut rim only leaks a trickle, and a standing
// bottom-to-top gradient survives while the rotors turn.
//
// The potential needs a difference: one open source and one open vent. A sealed
// side is a dead end, so the field is unanchored there and reports nothing rather
// than a flat slab of one colour. Between changes the displayed value relaxes
// toward the solved one, so a mouth click or a rotor turn reads as a moving front
// instead of a repaint.
//
// Gas velocity is Darcy-like: proportional to the potential gradient divided by
// crossing cost, concentrating the drop at mouths, seams and grain piles. Grains
// feel empirical drag and lift along the flow, both scaled by air force. This is a
// normalized relative potential, not a calibrated thermodynamic gas. Occupancy
// feeds the potential on the mask clock even while the rotors are still, so a pile
// drops pressure across its thickness. Gas velocity is state: it relaxes toward
// Darcy and pays the impulse it delivers to grains, and pinned mouths restore it,
// so a dense pile damps the flow it sits in.
const ValveGas = (() => {
	"use strict";
	const G = typeof ValveGeometry !== "undefined" ? ValveGeometry : require("./geometry.js");
	const INL = typeof ValveInlets !== "undefined" ? ValveInlets : require("./inlets.js");

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
	// Relative cost of pushing the potential through a metal cell; a shut rim is a
	// shared wall, not a hole. High enough that a cell's value is set by the leak
	// nearest to it, which is what keeps the overlay local and readable.
	const METAL = 12;
	const FILL_COST = 3;
	const SWEEPS = 3;
	const FAR = 1e9;
	// Gradient to gas speed, px/s per unit pressure-per-px. A passage crossing the
	// field pays a gradient near 1.3e-3, so it flows around 150 px/s and a jet
	// through an open seam is two or three times faster.
	const SPEED_SCALE = 200000;
	const GAS_MAX = 460;
	// Grain coupling. Drag is a relaxation rate toward the gas; LIFT is pressure
	// force per unit gas velocity, in px/s^2 per px/s, so a passage lifting at
	// 150 px/s adds about a quarter of gravity.
	const DRAG = 1.35;
	const LIFT = 1.5;
	const GRAIN_CAPACITY = 1.5;
	// Blend toward Darcy each mask tick, and the air mass of one cell in grain
	// units. A falling grain keeps meeting fresh cells, so it still feels the
	// lift; a sitting pile drains the same cells until the mouths restore them.
	const RELAX = 0.2;
	const CELL_MASS = 1;
	// Share of the gap between the shown potential and the solved one that closes
	// per mask tick. Pinned mouths answer at once; the rest of the field takes a
	// few tenths of a second, which is what makes a change readable.
	const P_RELAX = 0.3;

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
			pTarget: new Float32Array(COUNT),
			air: new Uint8Array(COUNT),
			face: new Uint8Array(COUNT),
			pin: new Uint8Array(COUNT),
			cost: new Float32Array(COUNT),
			open: new Float32Array(COUNT),
			fill: new Float32Array(COUNT),
			fillNow: new Uint16Array(COUNT),
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
			sources: 0,
			vents: 0,
			anchored: false,
			angles: new Float64Array(G.N * G.N),
			inletVersion: -1,
			clock: 0,
			maskClock: 0,
			updates: 0,
			solves: 0,
			rebuilds: 0,
			drags: 0,
			mean: 0,
			flow: 0,
			gain: 0,
		};
		gas.p.fill(0.5);
		gas.pTarget.fill(0.5);
		rebuild(sim, gas);
		applyPins(sim, gas);
		update(sim, gas, true, true);
		return gas;
	}

	// Endpoints must also be air cells. Sampling the whole link catches a thin
	// rim that lies between the midpoint and either endpoint.
	function openFace(layout, x, y, dx, dy) {
		const hx = dx * 0.5;
		const hy = dy * 0.5;
		const middle = G.airClearance(layout, x + hx, y + hy);
		if (middle < AIR_MIN) return false;
		const length = Math.max(Math.abs(dx), Math.abs(dy));
		if (middle >= AIR_MIN + length * 0.5 || length <= AIR_MIN) return true;
		return openFace(layout, x, y, hx, hy) && openFace(layout, x + hx, y + hy, hx, hy);
	}

	// Air mask and open faces, with the entire centre-to-centre link checked.
	function rebuild(sim, gas) {
		const layout = sim.layout;
		const air = gas.air;
		const face = gas.face;
		const cost = gas.cost;
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
				const o = open > 1 ? 1 : open < OPEN_MIN ? OPEN_MIN : open;
				gas.open[k] = o;
				gas.cost[k] = (1 + FILL_COST * gas.fill[k]) / o;
			}
		}
		const list = gas.list;
		for (let n = 0; n < gas.count; n++) {
			const k = list[n];
			const gx = k % NX;
			const gy = (k / NX) | 0;
			const x = gx * CELL + CELL / 2;
			const y = gy * CELL + CELL / 2 - G.POUR;
			if (gx + 1 < NX && air[k + 1] && openFace(layout, x, y, CELL, 0)) {
				face[k] |= R;
				face[k + 1] |= L;
			}
			if (gy + 1 < NY && air[k + NX] && openFace(layout, x, y, 0, CELL)) {
				face[k] |= D;
				face[k + NX] |= U;
			}
		}
		// Metal never changes cost between rebuilds.
		for (let k = 0; k < COUNT; k++) if (!air[k]) cost[k] = METAL;
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

	// A mouth pins its cell at the source (high) or vent (low) level. Both levels
	// must exist before the field means anything, which is what `anchored` reports.
	function applyPins(sim, gas) {
		const inlets = sim.inlets;
		gas.pin.fill(0);
		gas.pins = 0;
		gas.sources = 0;
		gas.vents = 0;
		for (let n = 0; n < gas.bandCount; n++) {
			const k = gas.band[n];
			const inlet = gas.bandSide[n] * G.N + gas.bandColumn[n];
			if (!inlets.open[inlet]) continue;
			const high = inlets.level[inlet] === INL.HIGH;
			gas.pin[k] = high ? 2 : 1;
			if (high) gas.sources++;
			else gas.vents++;
			gas.pins++;
		}
		gas.inletVersion = inlets.version;
	}

	// Occupancy throttles the crossing cost. Reports whether any cell's fill
	// actually moved, so a settled machine can skip re-solving the whole field.
	function measureCost(sim, gas) {
		const now = gas.fillNow;
		const fill = gas.fill;
		const air = gas.air;
		for (let n = 0; n < gas.count; n++) now[gas.list[n]] = 0;
		for (let k = 0; k < sim.count; k++) {
			const idx = index(sim.x[k], sim.y[k]);
			if (air[idx]) now[idx]++;
		}
		const cost = gas.cost;
		const open = gas.open;
		let changed = false;
		for (let n = 0; n < gas.count; n++) {
			const k = gas.list[n];
			let f = now[k] / GRAIN_CAPACITY;
			if (f > 1) f = 1;
			if (fill[k] !== f) {
				fill[k] = f;
				cost[k] = (1 + FILL_COST * f) / open[k];
				changed = true;
			}
		}
		return changed;
	}

	// Crossing cost into `to`. Two air cells only connect through an open face, so
	// a shut rim has to leak around through metal instead of acting like a hole.
	function crossing(dist, from, to, bit, cost, air, face) {
		const d = dist[from];
		if (d === FAR) return FAR;
		if (air[from] && air[to] && !(face[from] & bit)) return FAR;
		return d + cost[to];
	}

	// Fast sweeping for a porous path distance: alternating directional passes
	// carry a source's influence across the grid in a few sweeps, and every cell
	// pays its own crossing cost. Metal stays traversable, at METAL, so the field
	// is continuous while passages remain fast lanes.
	function distances(gas, dist, level) {
		const pin = gas.pin;
		const cost = gas.cost;
		const air = gas.air;
		const face = gas.face;
		const nx = gas.nx;
		const ny = gas.ny;
		dist.fill(FAR);
		const want = level + 1;
		for (let n = 0; n < gas.count; n++) {
			const k = gas.list[n];
			if (pin[k] === want) dist[k] = 0;
		}
		for (let pass = 0; pass < SWEEPS; pass++) {
			for (let gy = 0; gy < ny; gy++) {
				for (let gx = 0; gx < nx; gx++) {
					const k = gy * nx + gx;
					let best = dist[k];
					if (best === 0) continue;
					if (gx > 0) {
						const v = crossing(dist, k - 1, k, R, cost, air, face);
						if (v < best) best = v;
					}
					if (gy > 0) {
						const v = crossing(dist, k - nx, k, D, cost, air, face);
						if (v < best) best = v;
					}
					dist[k] = best;
				}
			}
			for (let gy = ny - 1; gy >= 0; gy--) {
				for (let gx = nx - 1; gx >= 0; gx--) {
					const k = gy * nx + gx;
					let best = dist[k];
					if (best === 0) continue;
					if (gx + 1 < nx) {
						const v = crossing(dist, k + 1, k, L, cost, air, face);
						if (v < best) best = v;
					}
					if (gy + 1 < ny) {
						const v = crossing(dist, k + nx, k, U, cost, air, face);
						if (v < best) best = v;
					}
					dist[k] = best;
				}
			}
		}
	}

	// Bounded relative potential from the two path distances. A cell without a path
	// to either boundary has no difference to show and stays neutral.
	function solvePotential(gas, target) {
		distances(gas, gas.fromHigh, 1);
		distances(gas, gas.fromLow, 0);
		const out = target || gas.p;
		const fromHigh = gas.fromHigh;
		const fromLow = gas.fromLow;
		let sum = 0;
		let n = 0;
		for (let i = 0; i < gas.count; i++) {
			const k = gas.list[i];
			const hi = fromHigh[k];
			const lo = fromLow[k];
			if (hi + lo >= FAR) {
				out[k] = 0.5;
				continue;
			}
			const p = lo / (hi + lo);
			out[k] = p;
			sum += p;
			n++;
		}
		return n ? sum / n : 0;
	}

	// Pinned mouths answer at once; the rest of the field approaches the solution,
	// so a click or a rotor turn reads as a moving front instead of a repaint.
	function relaxPotential(gas, snap) {
		const p = gas.p;
		const target = gas.pTarget;
		const pin = gas.pin;
		for (let n = 0; n < gas.count; n++) {
			const k = gas.list[n];
			p[k] = snap || pin[k] ? target[k] : p[k] + (target[k] - p[k]) * P_RELAX;
		}
	}

	// The potential is solved instantaneously; snap or relax its shown value and
	// its velocity state. Nothing is re-swept while the mask, the mouths and the
	// occupancy all stand still.
	function update(sim, gas, snap, force) {
		const changed = measureCost(sim, gas);
		const wasAnchored = gas.anchored;
		gas.anchored = gas.sources > 0 && gas.vents > 0;
		if (!gas.anchored) {
			gas.gx.fill(0);
			gas.gy.fill(0);
			gas.mean = 0;
			gas.flow = 0;
			gas.updates++;
			return;
		}
		// A field that was undefined has nothing to ease from.
		const fresh = !wasAnchored;
		if (changed || force || snap || fresh || gas.solves === 0) {
			gas.mean = solvePotential(gas, gas.pTarget);
			gas.solves++;
		}
		relaxPotential(gas, snap || fresh);
		const p = gas.p;
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
			const scale = SPEED_SCALE / (2 * CELL) / cost[k];
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
		update(sim, gas, false, moved);
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

	// Two empirical couplings: drag toward the gas and lift along its velocity.
	// The cell pays that impulse unless it is a pinned mouth. Air is left out of the
	// reservoir bands: a grain waiting in a pour slot is not yet in the machine,
	// and holding it there would stop the field from being fed.
	// integrate() keeps the result inside the grain speed ceiling.
	function drag(sim, gas, h) {
		if (!gas.anchored) return;
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

	// Solve a hypothetical mouth set into the target buffer, where every mouth of
	// the side that lifts the goal is open and the only reference left is the
	// farthest mouth of the other side. That is the strongest potential a goal can
	// reach by toggling mouths alone, and it is what a pressure quest must fit in.
	// The caller restores the live field with refresh().
	function probeMouths(sim, wantHigh, column) {
		const gas = sim.pressure;
		if (!gas || gas.kind !== "grid" || !gas.count) return false;
		const far = column <= G.N / 2 ? G.N - 1 : 0;
		gas.pin.fill(0);
		gas.sources = 0;
		gas.vents = 0;
		for (let n = 0; n < gas.bandCount; n++) {
			const k = gas.band[n];
			const high = gas.bandSide[n] === 1;
			// Open the whole side that pushes the goal towards the quest polarity and
			// keep a single mouth of the other side, far away, as the reference.
			if (wantHigh !== high && gas.bandColumn[n] !== far) continue;
			gas.pin[k] = high ? 2 : 1;
			if (high) gas.sources++;
			else gas.vents++;
		}
		gas.anchored = gas.sources > 0 && gas.vents > 0;
		const solved = gas.anchored;
		if (solved) solvePotential(gas, gas.pTarget);
		// The probe only writes pTarget: put the live mouths and counts back.
		applyPins(sim, gas);
		gas.anchored = gas.sources > 0 && gas.vents > 0;
		return solved;
	}

	// Re-pin and re-solve now: a paused page changes a mouth or a rotor while the
	// clock is stopped, and the overlay should answer immediately. `snap` settles
	// the whole field at once instead of letting it ease toward the solution.
	function refresh(sim, snap) {
		const gas = sim.pressure;
		rebuild(sim, gas);
		applyPins(sim, gas);
		update(sim, gas, !!snap, true);
		gas.maskClock = gas.clock;
	}

	// Settle the field without moving grains: a page paused on the overlay still
	// answers mouth clicks and rotor turns.
	function settle(sim, dt) {
		const gas = sim.pressure;
		gas.clock += dt;
		maybeSolve(sim, gas);
		if (gas.inletVersion !== sim.inlets.version) {
			applyPins(sim, gas);
			update(sim, gas, false, true);
		}
	}

	function step(sim, h) {
		const gas = sim.pressure;
		gas.clock += h;
		maybeSolve(sim, gas);
		if (gas.inletVersion !== sim.inlets.version) {
			applyPins(sim, gas);
			update(sim, gas, false, true);
		}
		drag(sim, gas, h);
	}

	return {
		create,
		step,
		settle,
		refresh,
		probeMouths,
		index,
		sampleCell,
		openFace,
		solvePotential,
		CELL,
		NX,
		NY,
		AIR_MIN,
		DRAG,
		LIFT,
		SPEED_SCALE,
		GAS_MAX,
		RELAX,
		P_RELAX,
		CELL_MASS,
	};
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveGas;
