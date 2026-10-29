// Diagnostic baseline: toggle only owned mouths, without routing valves.
// Completion is NOT an acceptance criterion: pressure quests now require routes.
// Run: node experiments/mouth-quest-probe.cjs [rounds] [seeds...]
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const I = require("../prototype/shared/inlets.js");
const Game = require("../prototype/shared/game.js");

const ROUNDS = Number(process.argv[2] || 5);
const EXTRA = process.argv.slice(3).map(Number);
const SEEDS = EXTRA.length ? EXTRA : [7, 11, 15, 19, 23, 42, 55, 77, 91, 104];
// Observe the mouth-only baseline for eight simulation seconds.
const HOLD = 8;

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
		q.threshold = q.op === ">" ? 0.9 : 0.1;
		q.bottles = 1;
		q.timeLimit = 0;
		q.holdNeed = Game.HOLD_EXACT;
		q.title = "P";
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
		const col = cell % G.N;
		const own = `${I.ownedBy(sim.inlets, col, 0) ? 1 : 0}i${I.ownedBy(sim.inlets, G.N + col, 0) ? 1 : 0}o`;
		setOwnMouths(sim, 0, q.op === ">");
		let won = false;
		const doneBefore = game.players[0].completed;
		const steps = Math.round((HOLD / S.STEP));
		for (let k = 0; k < steps && !won; k++) {
			S.step(sim, S.STEP);
			Game.step(game, S.STEP);
			won = game.players[0].completed > doneBefore;
		}
		if (won) done++;
		rows.push(`${seed} ${round} ${q.op} ${q.threshold.toFixed(2)} col ${col} ${own} ${won ? "done" : "needs route"} ${ms.toFixed(0)}ms`);
		if (game.players[0].questId >= 0) Game.dropQuest(game, 0);
		for (let k = 0; k < Math.round(0.2 / S.STEP); k++) {
			S.step(sim, S.STEP);
			Game.step(game, S.STEP);
		}
	}
}

console.log(rows.join("\n"));
console.log(
	`\nsigned ${signed}, completed ${done}, needs routing ${signed - done}, refused ${refused}; ` +
		`sign ${(signMs / Math.max(1, signed + refused)).toFixed(0)} ms average, ${signMax.toFixed(0)} ms worst`,
);
