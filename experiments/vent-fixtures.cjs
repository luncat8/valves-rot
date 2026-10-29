// Fixtures for Vent mode: what a prebuilt rig has to look like, what a seat may
// touch, how a band is scored, and what the mode gives back when it is left.
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
		// World ports, sorted: a rotor's own port list is bookkeeping, and only the
		// direction it faces the field with is a promise to the lab.
		out.push(v.kind + G.worldPorts(v).slice().sort().join("") + v.chamberR.toFixed(3) + sim.caseTint[k] + sim.autoLocked[k] + sim.goalOwner[k]);
	}
	return out;
}

// ---- one rig per seat, and nothing else in the bands ------------------------
{
	const { sim, game } = ventGame(7, 2);
	assert.equal(game.vent.count, 2, "two seats borrow two columns");
	assert.equal(sim.autoRotate, Game.VENT_AUTO, "vent mode runs its own auto-rotate share");
	assert.equal(sim.pressureMode, "grid", "a seat reads the grid gas");
	assert.equal(sim.count, 0, "grains would pack the pipe being regulated");

	let present = 0;
	for (let m = 0; m < sim.inlets.count; m++) if (sim.inlets.present[m]) present++;
	assert.equal(present, 4, "only the rigs' mouths are in the bands");

	const columns = [];
	for (let s = 0; s < game.vent.count; s++) {
		const seat = game.vent.seats[s];
		assert.equal(seat.player, s, "a seat belongs to its own player");
		assert.equal(game.players[s].id, s, "seat ids stay dense");
		assert.ok(seat.column >= 0 && seat.column < N, "the rig borrows a column");
		assert.ok(seat.row >= 4 && seat.row <= 6, "the bottle sits mid-column, got row " + seat.row);
		assert.equal(seat.bottle, seat.row * N + seat.column, "the bottle is on the rig");
		assert.equal(seat.inMouth, I.BOTTOM * N + seat.column, "the source mouth is at the bottom");
		assert.equal(seat.outMouth, I.TOP * N + seat.column, "the vent mouth is at the top");
		columns.push(seat.column);

		for (let j = 0; j < N; j++) {
			const idx = j * N + seat.column;
			const v = sim.layout.valves[idx];
			assert.equal(sim.autoLocked[idx], 1, "a rig cell never turns on its own");
			assert.equal(sim.goalOwner[idx], s, "a rig cell is owned by its seat");
			assert.equal(sim.caseTint[idx], s, "a rig cell wears its seat's color");
			if (j === seat.row) {
				assert.equal(v.kind, "hollow", "the bottle is a chamber");
				assert.equal(v.chamberR, Game.GOAL_CHAMBER, "the bottle is a goal-sized chamber");
			} else {
				assert.equal(v.kind, "solid", "the shaft is a pipe");
				assert.equal(v.chamberR, 0, "the shaft holds no bulb");
			}
			assert.deepEqual(G.worldPorts(v).slice().sort(), [1, 3], "every rig cell runs north-south");
		}

		const span = seat.spanHi - seat.spanLo;
		assert.ok(span >= Game.VENT_MIN_SPAN, "a rig keeps authority over its pocket, span " + span.toFixed(2));
		assert.ok(seat.hi > seat.lo, "a band has a range");
		assert.ok(seat.half >= 0.03 && seat.half <= 0.12, "a band is narrow enough to be a task, got " + seat.half.toFixed(3));
		assert.ok(seat.lo >= seat.spanLo && seat.hi <= seat.spanHi, "the band stays inside what the mouths can reach");
		assert.equal(seat.points, seat.half >= 0.1 ? 10 : seat.half >= 0.08 ? 25 : 50, "a narrower band scores more");
		assert.equal(seat.tag, seat.lo.toFixed(2) + "–" + seat.hi.toFixed(2), "the field tag names the band");
	}
	assert.ok(Math.abs(columns[0] - columns[1]) >= 2, "two bottles do not share one weather");
}

// ---- the same seed always builds the same field ----------------------------
{
	const a = ventGame(21, 2).game.vent.seats;
	const b = ventGame(21, 2).game.vent.seats;
	for (let s = 0; s < 2; s++) {
		assert.equal(a[s].column, b[s].column, "the column is chosen by the seed");
		assert.equal(a[s].row, b[s].row, "the bottle row is chosen by the seed");
		assert.equal(a[s].tag, b[s].tag, "the band is fitted by the seed");
	}
}

// ---- what a seat may touch --------------------------------------------------
{
	const { sim, game } = ventGame(7, 2);
	const mine = game.vent.seats[0];
	const rival = game.vent.seats[1];
	assert.equal(Game.pressActor(game, mine.inMouth), 0, "your own mouths answer you");
	assert.equal(Game.pressActor(game, mine.outMouth), 0);
	assert.equal(Game.pressActor(game, rival.inMouth), -1, "a bot seat keeps its own mouths");
	assert.equal(Game.pressActor(game, I.BOTTOM * N + ((mine.column + 1) % N)), -1, "an unborrowed column has no mouth");
	Game.setPlayerBot(game, 1, false);
	assert.equal(Game.pressActor(game, rival.inMouth), 1, "a handed-over seat answers its person");
	for (let k = 0; k < SLOTS; k++) assert.equal(Game.canTurn(game, k), false, "no valve is the player's in vent mode");
	assert.equal(sim.inlets.open[mine.inMouth], 1, "a rig starts with both mouths open");
	assert.equal(sim.inlets.open[mine.outMouth], 1);
}

// ---- play: a bot holds its band and scores, a user seat is left alone -------
{
	const { sim, game } = ventGame(7, 2);
	Game.setPlayerBot(game, 0, false);
	const userSeat = game.vent.seats[0];
	const openBefore = sim.inlets.open.slice();
	const steps = Math.round(20 / S.STEP);
	for (let k = 0; k < steps; k++) {
		S.step(sim, S.STEP);
		Game.step(game, S.STEP);
	}
	assert.equal(userSeat.drive, 0, "a seat nobody plays is never driven");
	assert.equal(sim.inlets.open[userSeat.inMouth], openBefore[userSeat.inMouth], "a user seat keeps its own mouths");
	assert.equal(sim.injected, sim.count + sim.drained + sim.purged, "grain bookkeeping stays balanced");
	const bot = game.players[1];
	assert.ok(bot.score > 0, "a bot seat holds its band and scores, got " + bot.score);
	assert.ok(game.vent.seats[1].rounds > 0, "a held band is a round");
	assert.equal(game.players[0].score, 0, "an idle seat scores nothing");
	assert.ok(game.vent.seats[1].pressure >= 0 && game.vent.seats[1].pressure <= 1, "the pocket reads inside the ramp");
}

// ---- seats come and go ------------------------------------------------------
{
	const sim = S.create(G.createLayout(7));
	S.setPressure(sim, "grid");
	// Snapshotted before the rigs borrow their columns: that is what the lab has
	// to get back.
	const before = cellText(sim);
	const game = Game.create(sim, { mode: "vent", botControl: true, players: 2 });
	const rivalColumn = game.vent.seats[1].column;
	assert.equal(Game.removePlayer(game, 0), false, "your own seat stays");
	assert.equal(game.players.length, 2);
	assert.equal(Game.removePlayer(game, 1), true, "a rival seat can be removed mid-match");
	assert.equal(game.players.length, 1);
	assert.equal(game.vent.count, 1, "its rig goes with it");
	let present = 0;
	for (let m = 0; m < sim.inlets.count; m++) if (sim.inlets.present[m]) present++;
	assert.equal(present, 2, "and its mouths leave the bands");
	for (let j = 0; j < N; j++) {
		const idx = j * N + rivalColumn;
		assert.equal(sim.autoLocked[idx], 0, "a given-back column is not locked");
		assert.equal(sim.goalOwner[idx], -1, "a given-back column has no owner");
		assert.equal(sim.caseTint[idx], -1, "a given-back column wears no color");
	}
	assert.equal(Game.addPlayer(game), true, "a seat can be added back");
	assert.equal(game.vent.count, 2);
	assert.equal(Game.addPlayer(game), false, "vent mode plays with one or two seats");
	assert.equal(game.players.length, 2);
	assert.ok(game.lastEvent.includes("1 or 2 seats"), "the refusal is answered in the status line");

	Game.setMode(game, "lab");
	assert.deepEqual(cellText(sim), before, "leaving vent mode gives the lab its own field back");
	let labOpen = 0;
	for (let m = 0; m < sim.inlets.count; m++) if (sim.inlets.open[m] && sim.inlets.present[m]) labOpen++;
	assert.equal(labOpen, sim.inlets.count, "the lab band is whole again");
	assert.equal(sim.autoRotate, Game.LAB_AUTO, "and runs the lab's auto-rotate share");

	Game.setMode(game, "vent");
	assert.equal(game.vent.count, 2, "vent mode can be entered again");
	assert.equal(Game.addPlayer(game), false, "still two seats at most");
	Game.setMode(game, "game");
	assert.equal(Game.addPlayer(game), true, "game mode deals its own seat list again");
	assert.ok(game.players.length <= Game.MAX_SEATS);
}

// ---- a new match rebuilds the rigs and clears the scores -------------------
{
	const { sim, game } = ventGame(42, 2);
	const steps = Math.round(12 / S.STEP);
	for (let k = 0; k < steps; k++) {
		S.step(sim, S.STEP);
		Game.step(game, S.STEP);
	}
	Game.resetMatch(game, sim);
	assert.equal(game.players[0].score + game.players[1].score, 0, "a new match starts from zero");
	assert.equal(game.vent.count, 2, "and builds fresh rigs");
	for (let s = 0; s < 2; s++) {
		assert.equal(game.vent.seats[s].rounds, 0, "no round carries over");
		assert.ok(game.vent.seats[s].bottle >= 0, "every seat gets a rig");
	}
	// A fresh layout never lent the columns this rig stands on.
	const fresh = S.create(G.createLayout(42));
	Game.resetMatch(game, fresh);
	assert.equal(game.vent.count, 2, "a new seed builds its own rigs");
	assert.equal(game.sim, fresh, "and plays on the new field");
}

console.log(
	"OK  vent mode: rig shape and band fit, seed determinism, seat ownership, " +
		"bot scoring against an idle seat, add/remove/hand-over, teardown restore, new match",
);
