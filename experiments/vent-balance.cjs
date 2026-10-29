// Balance measurements for Vent mode: what a prebuilt rig can do to its own
// pocket, how well a seat holds its band against a rival, and what entering and
// leaving the mode costs the field.
// Run: node experiments/vent-balance.cjs [seconds] [seeds...]
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const I = require("../prototype/shared/inlets.js");
const GAS = require("../prototype/shared/gas.js");
const Game = require("../prototype/shared/game.js");

const N = G.N;
const SECONDS = Number(process.argv[2] || 45);
const EXTRA = process.argv.slice(3).map(Number);
const SEEDS = EXTRA.length ? EXTRA : [7, 21, 99];
const SETTLE_HZ = 30;

function settle(sim, seconds) {
	const ticks = Math.round(seconds * SETTLE_HZ);
	for (let k = 0; k < ticks; k++) GAS.settle(sim, 1 / SETTLE_HZ);
}

// The pocket a seat reads, sampled exactly like the game samples it.
function pocket(sim, index) {
	const gas = sim.pressure;
	const v = sim.layout.valves[index];
	const r2 = (Math.max(v.chamberR, 8) + 2) ** 2;
	const c0 = GAS.index(v.cx, v.cy);
	const gx0 = c0 % gas.nx;
	const gy0 = (c0 / gas.nx) | 0;
	let sum = 0;
	let n = 0;
	for (let oy = gy0 - 3; oy <= gy0 + 3; oy++) {
		if (oy < 0 || oy >= gas.ny) continue;
		for (let ox = gx0 - 3; ox <= gx0 + 3; ox++) {
			if (ox < 0 || ox >= gas.nx) continue;
			const k = oy * gas.nx + ox;
			if (!gas.air[k]) continue;
			const wx = (ox + 0.5) * gas.cell;
			const wy = (oy + 0.5) * gas.cell - G.POUR;
			if ((wx - v.cx) ** 2 + (wy - v.cy) ** 2 > r2) continue;
			sum += gas.p[k];
			n++;
		}
	}
	return n > 0 ? sum / n : 0.5;
}

function rig(sim, column, row) {
	const pipe = G.typeById("solid-straight");
	const bottle = G.typeById("hollow-straight");
	for (let j = 0; j < N; j++) {
		const idx = j * N + column;
		const isBottle = j === row;
		S.installValve(sim, idx, isBottle ? bottle : pipe, 1, isBottle ? Game.GOAL_CHAMBER : undefined, true);
		sim.autoLocked[idx] = 1;
	}
	GAS.refresh(sim);
	return row * N + column;
}

// 1. Authority of one rig, and how still its pocket stands once both mouths are
// sealed. The second number is what makes a band holdable at all.
function authority(seed, rows) {
	const sim = S.create(G.createLayout(seed));
	S.setPressure(sim, "grid");
	I.clearAll(sim.inlets);
	const out = [];
	for (let column = 0; column < N; column++) {
		for (const row of rows) {
			const bottle = rig(sim, column, row);
			const inMouth = I.BOTTOM * N + column;
			const outMouth = I.TOP * N + column;
			sim.inlets.open[inMouth] = 1;
			sim.inlets.open[outMouth] = 0;
			GAS.repin(sim);
			settle(sim, 3);
			const charge = pocket(sim, bottle);
			sim.inlets.open[inMouth] = 0;
			sim.inlets.open[outMouth] = 1;
			GAS.repin(sim);
			settle(sim, 3);
			const drain = pocket(sim, bottle);
			sim.inlets.open[outMouth] = 0;
			GAS.repin(sim);
			const sealed = pocket(sim, bottle);
			settle(sim, 4);
			out.push({ column, row, span: Math.abs(charge - drain), charge, drain, leak: Math.abs(pocket(sim, bottle) - sealed) / 4 });
		}
	}
	return out;
}

// 2. One played match: how much of the time each seat sits inside its band, how
// often it has to move a mouth to stay there, and what it scores.
function match(seed, players, bots, seconds) {
	const sim = S.create(G.createLayout(seed));
	S.setPressure(sim, "grid");
	const t0 = Date.now();
	const game = Game.create(sim, { mode: "vent", botControl: true, players });
	const setup = Date.now() - t0;
	for (let p = 0; p < players; p++) Game.setPlayerBot(game, p, bots[p]);
	const seats = game.vent.seats;
	const held = new Float64Array(players);
	const switched = new Float64Array(players);
	const open = sim.inlets.open.slice();
	let samples = 0;
	const t1 = Date.now();
	const steps = Math.round(seconds / S.STEP);
	for (let k = 0; k < steps; k++) {
		S.step(sim, S.STEP);
		Game.step(game, S.STEP);
		if (k % 8) continue;
		samples++;
		for (let s = 0; s < game.vent.count; s++) if (seats[s].ok) held[s]++;
		for (let m = 0; m < sim.inlets.count; m++) {
			if (sim.inlets.open[m] === open[m]) continue;
			open[m] = sim.inlets.open[m];
			if (sim.inlets.owner[m] >= 0) switched[sim.inlets.owner[m]]++;
		}
	}
	const played = Date.now() - t1;
	const rows = [];
	for (let s = 0; s < game.vent.count; s++) {
		const seat = seats[s];
		rows.push({
			seat: s,
			column: seat.column,
			row: seat.row,
			band: seat.lo.toFixed(2) + "-" + seat.hi.toFixed(2),
			held: held[s] / samples,
			switches: switched[s] / seconds,
			rounds: seat.rounds,
			score: game.players[s].score,
			lost: game.players[s].failed,
		});
	}
	return { setup, played, seconds, rows };
}

// 3. Leaving the mode has to give the lab back the field it lent. Angles are
// compared through their quarter: a rotor caught mid-turn is restored to the
// position it was turning to, which is the orientation the lab plays by.
function fieldState(sim) {
	const state = [];
	for (let k = 0; k < sim.layout.valves.length; k++) {
		const v = sim.layout.valves[k];
		// World ports, sorted: a rotor's own port list is bookkeeping, and only the
		// direction it faces the field with is a promise to the lab.
		state.push(v.kind + G.worldPorts(v).slice().sort().join("") + v.chamberR.toFixed(3) + sim.caseTint[k] + sim.autoLocked[k] + sim.goalOwner[k]);
	}
	return state;
}

function openMouths(sim) {
	let n = 0;
	for (let m = 0; m < sim.inlets.count; m++) if (sim.inlets.open[m]) n++;
	return n;
}

function restore(seed, players) {
	const sim = S.create(G.createLayout(seed));
	S.setPressure(sim, "grid");
	const before = fieldState(sim);
	const game = Game.create(sim, { mode: "vent", botControl: true, players });
	const inVent = { rigs: game.vent.count, mouths: openMouths(sim), auto: sim.autoRotate };
	Game.setMode(game, "lab");
	const after = fieldState(sim);
	let diffs = 0;
	for (let k = 0; k < after.length; k++) if (after[k] !== before[k]) diffs++;
	return { rigs: inVent.rigs, ventMouths: inVent.mouths, auto: inVent.auto, backAuto: sim.autoRotate, diffs, mouths: openMouths(sim) };
}

console.log("vent rig authority: span is what the two mouths can do to the pocket, leak is");
console.log("how fast the pocket still moves 4 s after both mouths are sealed.");
for (const seed of SEEDS.slice(0, 2)) {
	const rows = authority(seed, [3, 5, 7]);
	const spans = rows.map(r => r.span);
	const leaks = rows.map(r => r.leak);
	const byRow = {};
	for (const r of rows) {
		const e = byRow[r.row] || (byRow[r.row] = []);
		e.push(r);
	}
	const detail = Object.keys(byRow).sort().map(row => {
		const e = byRow[row];
		const mean = e.reduce((a, r) => a + r.charge - r.drain, 0) / e.length;
		return `row ${row}: charge ${e[0].charge.toFixed(2)} drain ${e[0].drain.toFixed(2)} mean span ${mean.toFixed(2)}`;
	});
	console.log(`  seed ${seed}: span ${Math.min(...spans).toFixed(2)}..${Math.max(...spans).toFixed(2)}, leak ${Math.max(...leaks).toFixed(4)}/s max`);
	for (const line of detail) console.log("   ", line);
}

console.log(`\nvent matches, ${SECONDS} s each: held is the share of samples inside the band,`);
console.log("switches is mouth moves per second, rounds is bands held for the full hold time.");
for (const seed of SEEDS) {
	for (const players of [1, 2]) {
		const bots = players === 1 ? [true] : [true, true];
		const r = match(seed, players, bots, SECONDS);
		const seats = r.rows.map(x => `seat${x.seat} col${x.column}/row${x.row} band ${x.band} held ${(x.held * 100).toFixed(0)}% ${x.switches.toFixed(1)} sw/s rounds ${x.rounds} ${x.score} pts lost ${x.lost}`).join("\n           ");
		console.log(`  seed ${seed}, ${players} player${players > 1 ? "s" : ""}: setup ${r.setup} ms, ${r.seconds} s played in ${(r.played / 1000).toFixed(1)} s`);
		console.log("           " + seats);
	}
	const idle = match(seed, 2, [true, false], SECONDS);
	const x = idle.rows[0];
	console.log(`  seed ${seed}, 1 bot + 1 idle seat: held ${(x.held * 100).toFixed(0)}% ${x.switches.toFixed(1)} sw/s rounds ${x.rounds} ${x.score} pts lost ${x.lost}`);
}

console.log("\nleaving vent mode: the lab has to get its own field back.");
for (const seed of SEEDS.slice(0, 2)) {
	const r = restore(seed, 2);
	console.log(`  seed ${seed}: ${r.rigs} rigs torn down, ${r.ventMouths} vent mouths back to ${r.mouths}, auto-rotate ${r.auto} back to ${r.backAuto}, cell state diffs ${r.diffs}`);
}
