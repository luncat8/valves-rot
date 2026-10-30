// Game-mode bot pacing: one bot action per interval, 1..2 Hz by difficulty, so
// competitors route and press instead of grinding the map.
// Run: node experiments/bot-pacing.cjs
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const Game = require("../prototype/shared/game.js");

const EPS = S.STEP * 1.5;

function rateOf(level) {
	return Game.botRate({ botLevel: level });
}

// ---- the difficulty scale is the whole allowed range ----------------------
assert.deepEqual([...Game.BOT_RATES], [1, 1.5, 2], "difficulty spans one to two changes a second");
assert.equal(rateOf(0), 1);
assert.equal(rateOf(1), 1.5);
assert.equal(rateOf(2), 2);
assert.equal(rateOf(9), 1.5, "an unknown level falls back to the middle pace");
assert.equal(Game.BOT_LEVEL_NAMES.length, Game.BOT_RATES.length, "every pace is named in the roster");

// ---- measured action cadence per seat -------------------------------------
const sim = S.create(G.createLayout(7));
const game = Game.create(sim, { mode: "game", botControl: true, players: 4 });
// Seat 0 is the person; the rivals run one of each difficulty.
const levels = [1, 0, 1, 2];
for (let p = 0; p < levels.length; p++) Game.setPlayerLevel(game, p, levels[p]);
const players = game.players;
const rate = levels.map(level => rateOf(level));
const previous = game.botCooldown.slice();
const lastAt = new Float64Array(players.length).fill(-1);
const gaps = levels.map(() => []);
let clock = 0;
const seconds = 40;
for (let k = 0; k < Math.round(seconds / S.STEP); k++) {
	S.step(sim, S.STEP);
	Game.step(game, S.STEP);
	clock += S.STEP;
	for (let p = 0; p < players.length; p++) {
		if (game.botCooldown[p] <= previous[p]) continue;
		if (lastAt[p] >= 0) gaps[p].push(clock - lastAt[p]);
		lastAt[p] = clock;
		previous[p] = game.botCooldown[p];
	}
	// A non-resetting step still lowers the cooldown; keep the baseline in step.
	for (let p = 0; p < players.length; p++) previous[p] = game.botCooldown[p];
}

const summary = [];
for (let p = 1; p < players.length; p++) {
	const list = gaps[p];
	assert.ok(list.length >= 4, "bot " + p + " acted often enough to measure, got " + list.length);
	let min = Infinity;
	let max = 0;
	for (const gap of list) {
		if (gap < min) min = gap;
		if (gap > max) max = gap;
	}
	assert.ok(min >= 1 / rate[p] - EPS, "bot " + p + " keeps its " + rate[p] + " Hz ceiling, min gap " + min.toFixed(3));
	assert.ok(min >= 0.5 - EPS, "no bot changes the map faster than twice a second");
	assert.ok(max <= 1.25 / rate[p] + EPS, "bot " + p + " does not idle between actions, max gap " + max.toFixed(3));
	summary.push("seat " + p + " level " + levels[p] + ": " + rate[p] + " Hz, " + list.length + " actions, gap " + min.toFixed(2) + "–" + max.toFixed(2) + " s");
}

// A harder seat is measurably busier than a calm one over the same run.
assert.ok(gaps[3].length > gaps[1].length, "the quick seat acts more often than the calm one");

// ---- a person is unaffected ------------------------------------------------
{
	const solo = S.create(G.createLayout(7));
	const match = Game.create(solo, { mode: "game", botControl: true, players: 2 });
	Game.setPlayerBot(match, 1, false);
	Game.setPlayerLevel(match, 1, 2);
	const before = match.botCooldown[1];
	for (let k = 0; k < Math.round(5 / S.STEP); k++) {
		S.step(solo, S.STEP);
		Game.step(match, S.STEP);
	}
	assert.equal(match.botCooldown[1], before, "a seat played by a person never runs a bot clock");
}

console.log("OK  Bot pacing: 1..2 Hz map changes by difficulty, measured per seat");
for (const line of summary) console.log("    " + line);
