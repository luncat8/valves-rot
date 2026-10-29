// Owned-mouth pressure probe: with the bands dealt per player, a pressure
// quest's bottle lands in one of the signer's own columns, so two presses of
// that player's mouths (favourable pair open, opposing pair sealed) must be
// enough to charge or drain the chamber to the fitted target.
// Run: node experiments/mouth-quest-probe.cjs [rounds] [seeds...]
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const I = require("../prototype/shared/inlets.js");
const Game = require("../prototype/shared/game.js");

const ROUNDS = Number(process.argv[2] || 5);
const EXTRA = process.argv.slice(3).map(Number);
const SEEDS = EXTRA.length ? EXTRA : [7, 11, 15, 19, 23, 42, 55, 77, 91, 104];
const HOLD = 4;

function setOwnMouths(sim, playerId, wantHigh) {
	for (let k = 0; k < sim.inlets.count; k++) {
		if (!I.ownedBy(sim.inlets, k, playerId)) continue;
		const wantOpen = (sim.inlets.level[k] === I.HIGH) === wantHigh;
		if (!!sim.inlets.open[k] !== wantOpen) S.toggleInlet(sim, k, false, playerId);
	}
}

let signed = 0;
let done = 0;
let refused = 0;
let signMs = 0;
let signMax = 0;
const rows = [];
for (const seed of SEEDS) {
	const layout = G.createLayout(seed);
	const sim = S.create(layout, { turning: false });
	S.seed(sim);
	const game = Game.create(sim, { mode: "game", botControl: false });
	for (let round = 0; round < ROUNDS; round++) {
		const q = game.quests.find(x => x.owner < 0);
		if (!q) break;
		q.kind = "pressure";
		q.op = round % 2 ? "<" : ">";
		q.threshold = 0.9;
		q.bottles = 1;
		q.timeLimit = 0;
		q.holdNeed = Game.HOLD_EXACT;
		q.title = "P";
		q.aim = 0.6;
		const t0 = process.hrtime.bigint();
		const ok = Game.signQuest(game, q.id, 0);
		const ms = Number(process.hrtime.bigint() - t0) / 1e6;
		signMs += ms;
		if (ms > signMax) signMax = ms;
		if (!ok) {
			refused++;
			rows.push(`${seed} ${round} refused`);
			break;
		}
		signed++;
		const cell = q.cells[0];
		const own = I.ownedBy(sim.inlets, cell % G.N, 0) && I.ownedBy(sim.inlets, G.N + (cell % G.N), 0);
		setOwnMouths(sim, 0, q.op === ">");
		let won = false;
		const steps = Math.round((HOLD / S.STEP));
		for (let k = 0; k < steps && !won; k++) {
			S.step(sim, S.STEP);
			Game.step(game, S.STEP);
			won = game.players[0].completed > 0;
		}
		if (won) done++;
		rows.push(`${seed} ${round} ${q.op} ${q.threshold.toFixed(2)} col ${cell % G.N} ${own ? "own" : "FOREIGN"} ${won ? "done" : "FAIL"} ${ms.toFixed(0)}ms`);
		if (game.players[0].questId >= 0) Game.dropQuest(game, 0);
		for (let k = 0; k < Math.round(0.2 / S.STEP); k++) {
			S.step(sim, S.STEP);
			Game.step(game, S.STEP);
		}
	}
}

console.log(rows.join("\n"));
console.log(
	`\nsigned ${signed}, completed ${done}, failed ${signed - done}, refused ${refused}; ` +
		`sign ${(signMs / Math.max(1, signed + refused)).toFixed(0)} ms average, ${signMax.toFixed(0)} ms worst`,
);
