// Fixtures for random-map Vent mode: existing-valve routes, single-port
// collectors, turn-based valve rotation, mouth ownership and exact teardown.
// Run: node experiments/vent-fixtures.cjs
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const I = require("../prototype/shared/inlets.js");
const Game = require("../prototype/shared/game.js");

const N = G.N;
const SLOTS = N * N;

function ventGame(seed, players) {
	const sim = S.create(G.createLayout(seed));
	S.setPressure(sim, "grid");
	const game = Game.create(sim, { mode: "vent", botControl: true, players });
	return { sim, game };
}

function cellText(sim) {
	const out = [];
	for (let k = 0; k < SLOTS; k++) {
		const v = sim.layout.valves[k];
		out.push([
			G.typeOf(v).id,
			G.orientationOf(v),
			v.chamberR,
			sim.caseTint[k],
			sim.autoLocked[k],
			sim.goalOwner[k],
		].join(":"));
	}
	return out;
}

function portOpen(sim, cell, dir) {
	const v = sim.layout.valves[cell];
	const q = G.orientationOf(v);
	const mask = G.typeOf(v).mask;
	return !!(((mask << q) | (mask >> (4 - q))) & (1 << dir));
}

function stableReach(sim, seat) {
	const seen = new Set([seat.bottle]);
	const queue = [seat.bottle];
	for (const cell of queue) {
		const valve = sim.layout.valves[cell];
		const type = G.typeOf(valve);
		const q = G.orientationOf(valve);
		const mask = ((type.mask << q) | (type.mask >> (4 - q))) & 15;
		for (let d = 0; d < 4; d++) {
			if (!(mask & (1 << d))) continue;
			const x = cell % N + G.DX[d];
			const y = Math.floor(cell / N) + G.DY[d];
			if (x < 0 || x >= N || y < 0 || y >= N) continue;
			const next = y * N + x;
			if (seen.has(next) || !sim.autoLocked[next]) continue;
			const other = sim.layout.valves[next];
			const oq = G.orientationOf(other);
			const om = G.typeOf(other).mask;
			if (!((((om << oq) | (om >> (4 - oq))) & 15) & (1 << ((d + 2) & 3)))) continue;
			seen.add(next);
			queue.push(next);
		}
	}
	return seen;
}

function stepSeconds(sim, game, seconds) {
	for (let k = 0; k < Math.round(seconds / S.STEP); k++) {
		S.step(sim, S.STEP);
		Game.step(game, S.STEP);
	}
}

// The lowest unlocked valve: a cell the seat on turn may rotate.
function unlockedCell(game) {
	for (let k = 0; k < SLOTS; k++) if (!game.sim.autoLocked[k] && game.sim.goalOwner[k] < 0) return k;
	return -1;
}

function mouthCount(sim) {
	let count = 0;
	for (let k = 0; k < sim.inlets.count; k++) if (sim.inlets.present[k]) count++;
	return count;
}

// ---- two random-map routes and one hollow-single collector per seat ---------
{
	const seed = 7;
	const baseLayout = G.createLayout(seed);
	const before = S.create(baseLayout);
	const beforeCells = cellText(before);
	const { sim, game } = ventGame(seed, 2);
	assert.equal(game.vent.count, 2);
	assert.equal(sim.autoRotate, 0.05, "the mode keeps five percent of valves on automatic rotation");
	assert.equal(sim.pressureMode, "grid");
	assert.equal(sim.count, 0, "grains cannot pack the gas routes");
	assert.equal(mouthCount(sim), 8, "each of two seats owns two source and two vent mouths");

	const mouths = new Set();
	const bottles = new Set();
	for (let s = 0; s < game.vent.count; s++) {
		const seat = game.vent.seats[s];
		assert.equal(seat.player, s);
		assert.ok(seat.bottle >= 0 && seat.bottle < SLOTS, "every seat gets a collector");
		assert.ok(!bottles.has(seat.bottle), "collectors are distinct");
		bottles.add(seat.bottle);
		const sourceColumns = new Set();
		const ventColumns = new Set();
		for (let k = 0; k < 2; k++) {
			const source = seat.inMouths[k];
			const vent = seat.outMouths[k];
			assert.ok(source >= N && source < 2 * N, "each source is a random bottom-band mouth");
			assert.ok(vent >= 0 && vent < N, "each vent is a random top-band mouth");
			assert.ok(!mouths.has(source) && !mouths.has(vent), "all mouth controls are distinct");
			assert.ok(!sourceColumns.has(source % N), "a player's two random sources use different columns");
			assert.ok(!ventColumns.has(vent % N), "a player's two random vents use different columns");
			sourceColumns.add(source % N);
			ventColumns.add(vent % N);
			mouths.add(source);
			mouths.add(vent);
			assert.equal(sim.inlets.owner[source], s);
			assert.equal(sim.inlets.owner[vent], s);
			assert.equal(sim.inlets.level[source], I.HIGH, "the player's in mouth is high pressure");
			assert.equal(sim.inlets.level[vent], I.LOW, "the player's out mouth is low pressure");
		}

		const reachable = stableReach(sim, seat);
		assert.ok(seat.inMouths.some(mouth => reachable.has((N - 1) * N + mouth % N) && portOpen(sim, (N - 1) * N + mouth % N, 1)), "a stable source route reaches the bottle");
		assert.ok(seat.outMouths.some(mouth => reachable.has(mouth % N) && portOpen(sim, mouth % N, 3)), "a stable vent route reaches the bottle");
		const target = sim.layout.valves[seat.bottle];
		assert.equal(G.typeOf(target).id, "hollow-single", "the collector has exactly one hollow port");
		assert.ok(G.orientationOf(target) >= 0 && G.orientationOf(target) < 4, "the single port gets a random quarter-turn");
		assert.equal(target.chamberR, Game.GOAL_CHAMBER);
		assert.equal(sim.autoLocked[seat.bottle], 1, "the collector cannot rotate away from its route");
		assert.equal(sim.goalOwner[seat.bottle], s);
		assert.equal(sim.caseTint[seat.bottle], s);

		const span = seat.spanHi - seat.spanLo;
		assert.ok(span > 0.02, "the four mouths affect the collector, span " + span.toFixed(2));
		assert.ok(seat.hi > seat.lo, "the pressure task has a range");
		assert.ok(seat.lo >= seat.spanLo - 1e-6 && seat.hi <= seat.spanHi + 1e-6, "the range fits reachable pressure");
		assert.equal(seat.tag, seat.lo.toFixed(2) + "–" + seat.hi.toFixed(2));
	}

	let changed = 0;
	for (let k = 0; k < SLOTS; k++) {
		const v = sim.layout.valves[k];
		const old = before.layout.valves[k];
		if (game.vent.used[k]) assert.equal(sim.autoLocked[k], 1, "every planned route valve stays aligned");
		assert.equal(G.typeOf(v).id, k === game.vent.seats[0].bottle || k === game.vent.seats[1].bottle ? "hollow-single" : G.typeOf(old).id,
			"routes reuse each map valve's random type");
		if (cellText(sim)[k] !== beforeCells[k]) {
			changed++;
			assert.equal(game.vent.used[k], 1, "only the collector or its route changes");
		}
		if (k !== game.vent.seats[0].bottle && k !== game.vent.seats[1].bottle) {
			assert.equal(sim.caseTint[k], before.caseTint[k], "route valves are not recolored as player-owned controls");
			assert.equal(sim.goalOwner[k], before.goalOwner[k]);
		}
	}
	assert.ok(changed < 55, "the mode routes through the map instead of replacing whole columns");
}

// ---- seeded route placement and random direction are repeatable ------------
{
	const a = ventGame(21, 2).game.vent.seats;
	const b = ventGame(21, 2).game.vent.seats;
	for (let s = 0; s < 2; s++) {
		assert.equal(a[s].bottle, b[s].bottle);
		assert.deepEqual([...a[s].inMouths], [...b[s].inMouths]);
		assert.deepEqual([...a[s].outMouths], [...b[s].outMouths]);
		assert.equal(a[s].tag, b[s].tag);
		assert.equal(a[s].column, (a[s].bottle % N), "the reported collector column is its actual map position");
	}
}

// ---- mouth ownership and valve input ----------------------------------------
{
	const { sim, game } = ventGame(7, 2);
	const mine = game.vent.seats[0];
	const rival = game.vent.seats[1];
	for (const mouth of [...mine.inMouths, ...mine.outMouths]) assert.equal(Game.pressActor(game, mouth), 0);
	for (const mouth of [...rival.inMouths, ...rival.outMouths]) assert.equal(Game.pressActor(game, mouth), -1, "a bot seat's mouths refuse a human click");
	Game.setPlayerBot(game, 1, false);
	for (const mouth of [...rival.inMouths, ...rival.outMouths]) assert.equal(Game.pressActor(game, mouth), 1, "handed-over mouths answer their human");
	// Turn-based valve play: route valves and collectors stay locked, every other
	// valve answers the seat that holds the turn.
	for (const seat of game.vent.seats) assert.equal(Game.canTurn(game, seat.bottle), false, "a collector never turns");
	for (let k = 0; k < SLOTS; k++) if (game.vent.used[k]) assert.equal(Game.canTurn(game, k), false, "a route valve never turns");
	assert.ok(Game.canTurn(game, unlockedCell(game)), "an unlocked valve answers the seat on turn");
	for (const mouth of [...mine.inMouths, ...mine.outMouths]) assert.equal(sim.inlets.open[mouth], 1);
}

// ---- unlinked mouths are dealt as owner marks ------------------------------
{
	const { sim, game } = ventGame(7, 2);
	for (let s = 0; s < game.vent.count; s++) {
		const seat = game.vent.seats[s];
		assert.equal(sim.inlets.linked[seat.inMouths[0]], 1, "the routed source reads as a pipe");
		assert.equal(sim.inlets.linked[seat.outMouths[0]], 1, "the routed vent reads as a pipe");
		for (let k = 0; k < 2; k++) {
			assert.equal(sim.inlets.linked[seat.inMouths[k]], seat.inLinked[k], "a source mouth is marked when it has no route");
			assert.equal(sim.inlets.linked[seat.outMouths[k]], seat.outLinked[k], "a vent mouth is marked when it has no route");
		}
	}
	Game.setMode(game, "lab");
	for (let k = 0; k < sim.inlets.count; k++) assert.equal(sim.inlets.linked[k], 1, "Lab mode restores every pipe");
}

// ---- turn-based valve rotation --------------------------------------------
{
	const { sim, game } = ventGame(7, 2);
	Game.setPlayerBot(game, 1, false);
	const vent = game.vent;
	assert.equal(vent.turn, 0, "the first seat opens the match");
	assert.equal(Game.ventCanRotate(game), true, "a person may rotate on their turn");
	const cell = unlockedCell(game);
	const collector = game.vent.seats[vent.turn].bottle;
	const before = G.quarterOf(sim.target[cell]);
	assert.equal(Game.ventTurn(game, collector, 1), false, "the collector stays fixed");
	assert.equal(Game.ventTurn(game, cell, -1), true, "one quarter turn spends the turn");
	assert.equal(G.quarterOf(sim.target[cell]), (before + 3) & 3, "the rotation is exactly 90 degrees");
	assert.equal(vent.turn, 1, "the turn passes to the other seat");
	assert.equal(Game.ventTurn(game, cell, 1), false, "the hand-off clock refuses an immediate second rotation");
	assert.ok(Game.ventRefusal(game, cell).length > 0, "a refused click explains itself");
	stepSeconds(sim, game, 1.2);
	assert.equal(Game.canTurn(game, cell), true, "after the hand-off the other person may rotate");
	// A bot seat spends or passes its turn by itself, so a person is never stuck.
	Game.setPlayerBot(game, 1, true);
	stepSeconds(sim, game, 4);
	assert.equal(vent.turn, 0, "a bot hands the turn back to the person");
	assert.equal(Game.passVentTurn(game), true, "a person may pass the turn");
	assert.equal(vent.turn, 1, "passing hands the turn on");
	Game.setMode(game, "lab");
	Game.setMode(game, "vent");
	assert.equal(game.vent.turn, 0, "a fresh rig opens with the first seat");
}

// ---- an idle turn passes on its own ---------------------------------------
{
	const { sim, game } = ventGame(7, 2);
	Game.setPlayerBot(game, 1, false);
	assert.equal(game.vent.turn, 0, "the first seat opens the match");
	stepSeconds(sim, game, Game.VENT_TURN_TIME + 2);
	assert.equal(game.vent.turn, 1, "a seat that does nothing loses the turn to the clock");
}

// ---- a bot spends or passes its turn by itself ----------------------------
{
	const { sim, game } = ventGame(7, 2);
	Game.setPlayerBot(game, 0, true);
	const seat = game.vent.seats[1];
	// An unreachable band keeps the seat out of regulation, so it spends turns.
	seat.lo = 0.9;
	seat.hi = 0.95;
	let rotations = 0;
	const turn = S.turn;
	S.turn = (...args) => {
		const done = turn(...args);
		if (done) rotations++;
		return done;
	};
	stepSeconds(sim, game, 25);
	S.turn = turn;
	assert.ok(rotations > 0, "a bot out of its band rotates a valve on its turn");
	assert.ok(rotations <= 25 / 1.6, "a bot turn stays on the turn cadence, got " + rotations);
}

// ---- bot control works on the same four mouths a person can operate --------
{
	const { sim, game } = ventGame(7, 2);
	Game.setPlayerBot(game, 0, false);
	const userSeat = game.vent.seats[0];
	const openBefore = sim.inlets.open.slice();
	for (let k = 0; k < Math.round(20 / S.STEP); k++) {
		S.step(sim, S.STEP);
		Game.step(game, S.STEP);
	}
	for (const seat of game.vent.seats) {
		const reachable = stableReach(sim, seat);
		assert.ok(seat.inMouths.some(m => reachable.has((N - 1) * N + m % N) && portOpen(sim, (N - 1) * N + m % N, 1)));
		assert.ok(seat.outMouths.some(m => reachable.has(m % N) && portOpen(sim, m % N, 3)));
	}
	assert.equal(userSeat.drive, 0, "an unplayed human seat is never driven");
	for (const mouth of [...userSeat.inMouths, ...userSeat.outMouths]) assert.equal(sim.inlets.open[mouth], openBefore[mouth]);
	assert.equal(game.players[0].score, 0, "a human-controlled seat is not scored by the bot");
	assert.ok(game.vent.seats[1].pressure >= 0 && game.vent.seats[1].pressure <= 1);
	assert.equal(sim.injected, sim.count + sim.drained + sim.purged);
}

// ---- roster changes, exact restore and fresh-match handling -----------------
{
	const sim = S.create(G.createLayout(7));
	S.setPressure(sim, "grid");
	const before = cellText(sim);
	const game = Game.create(sim, { mode: "vent", botControl: true, players: 2 });
	assert.equal(Game.removePlayer(game, 0), false, "the local seat stays");
	assert.equal(Game.removePlayer(game, 1), true);
	assert.equal(game.players.length, 1);
	assert.equal(game.vent.count, 1);
	assert.equal(mouthCount(sim), 4);
	assert.equal(Game.addPlayer(game), true);
	assert.equal(game.vent.count, 2);
	assert.equal(Game.addPlayer(game), false, "Vent mode caps at two seats");

	Game.setMode(game, "lab");
	assert.deepEqual(cellText(sim), before, "every changed map valve is restored exactly");
	assert.equal(mouthCount(sim), sim.inlets.count, "Lab mode restores all mouths");
	assert.equal(sim.autoRotate, Game.LAB_AUTO);

	Game.setMode(game, "vent");
	assert.equal(game.vent.count, 2);
	Game.setMode(game, "game");
	assert.equal(Game.addPlayer(game), true, "the roster can grow again outside Vent mode");
	assert.ok(game.players.length <= Game.MAX_SEATS);
}

{
	const { sim, game } = ventGame(42, 2);
	Game.resetMatch(game, sim);
	assert.equal(game.players[0].score + game.players[1].score, 0);
	assert.equal(game.vent.count, 2);
	for (const seat of game.vent.seats) {
		assert.ok(seat.bottle >= 0);
		assert.equal(seat.rounds, 0);
	}
	const fresh = S.create(G.createLayout(42));
	Game.resetMatch(game, fresh);
	assert.equal(game.sim, fresh);
	assert.equal(game.vent.count, 2);
}

console.log("OK  Vent mode: random-map routes, hollow-single targets, turn-based rotation, deterministic setup, roster changes and exact restore");
