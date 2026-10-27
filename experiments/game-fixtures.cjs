// Deterministic fixtures for v0.2: auto-rotate share, case tints, procedural
// quest generation, hue-band + circular-mean hue matching, goal lifecycle and bots.
// Run: node experiments/game-fixtures.cjs
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const I = require("../prototype/shared/inlets.js");
const GAS = require("../prototype/shared/gas.js");
const R = require("../prototype/shared/render.js");
const Game = require("../prototype/shared/game.js");

function conserved(sim, tag) {
	assert.equal(sim.injected, sim.count + sim.drained + sim.purged, tag + ": grain conservation violated");
}

function runGame(sim, game, seconds) {
	const steps = Math.round(seconds / S.STEP);
	for (let k = 0; k < steps; k++) {
		S.step(sim, S.STEP);
		Game.step(game, S.STEP);
	}
}

// 1. Auto-rotate percentage: exact subset counts, monotonicity, manual turns
// at 0%, and goal-bottle auto-lock.
function testAutoRotate() {
	const sim = S.create(G.createLayout(7));
	for (const [frac, expect] of [[0, 0], [0.2, 20], [0.55, 55], [0.9, 90], [1, 100]]) {
		S.setAutoRotate(sim, frac);
		let active = 0;
		for (let k = 0; k < 100; k++) if (S.canAutoRotate(sim, k)) active++;
		assert.equal(active, expect, `autoRotate ${frac} must select exact ${expect} valves`);
	}

	// Monotonicity: every cell active at 20% stays active at 90%.
	S.setAutoRotate(sim, 0.2);
	const set20 = [];
	for (let k = 0; k < 100; k++) if (S.canAutoRotate(sim, k)) set20.push(k);
	S.setAutoRotate(sim, 0.9);
	for (const k of set20) assert.ok(S.canAutoRotate(sim, k), "20% subset must remain inside 90% subset");

	// Locked goal valve never auto-rotates even at 100%.
	S.setAutoRotate(sim, 1);
	sim.autoLocked[set20[0]] = 1;
	assert.equal(S.canAutoRotate(sim, set20[0]), false, "autoLocked goal cell never auto-rotates");
	sim.autoLocked[set20[0]] = 0;

	// At 0%, no valve starts an autonomous turn over 5 s, while a manual turn completes.
	const still = S.create(G.createLayout(11), { autoRotate: 0 });
	const startAngles = Float64Array.from(still.layout.valves.map(v => v.angle));
	assert.ok(S.turn(still, 44, 1));
	for (let k = 0; k < 600; k++) S.step(still, S.STEP);
	for (let k = 0; k < 100; k++) {
		if (k === 44) assert.ok(Math.abs(still.layout.valves[k].angle - (startAngles[k] + G.HALF_PI)) < 1e-6);
		else assert.equal(still.layout.valves[k].angle, startAngles[k], `cell ${k} must stay fixed at 0% auto-rotate`);
	}

	// setTarget snaps cleanly to quarter-turn detents for press-drag gestures.
	assert.equal(S.setTarget(still, 44, startAngles[44] + 3 * G.HALF_PI), true);
	assert.equal(S.setTarget(still, 44, startAngles[44] + 3 * G.HALF_PI), false, "unchanged detent returns false");
}

// 2. Player housing tints and zero-allocation incremental scene updates.
function testCaseTints() {
	let canvasCount = 0;
	const gradient = { addColorStop() {} };
	const prevDoc = global.document;
	global.document = {
		createElement() {
			canvasCount++;
			return {
				width: 0,
				height: 0,
				getContext: () =>
					new Proxy(
						{ createLinearGradient: () => gradient, createRadialGradient: () => gradient },
						{ get: (o, p) => (p in o ? o[p] : () => {}), set: () => true },
					),
			};
		},
	};
	try {
		const layout = G.createLayout(7);
		const sim = S.create(layout, { turning: false });
		assert.equal(S.setCaseTint(sim, 12, 0), true);
		assert.equal(S.setCaseTint(sim, 12, 0), false);
		assert.equal(S.setCaseTint(sim, 34, 2), true);
		for (const skin of ["glm", "combined", "gpt"]) {
			const before = canvasCount;
			const scene = R.buildScene(layout, "#ffffff", 1, skin, sim.caseTint);
			assert.equal(canvasCount - before, 101, "scene builds 1 bg + 100 rotor canvases");
			const mid = canvasCount;
			S.setCaseTint(sim, 56, 3);
			R.rebuildBackground(scene, layout, sim.caseTint);
			S.installValve(sim, 12, G.typeById("hollow-single"), 3, Game.GOAL_CHAMBER);
			R.rebuildRotor(scene, layout, 12);
			assert.equal(canvasCount, mid, `incremental ${skin} updates allocate zero canvases`);
		}
	} finally {
		global.document = prevDoc;
	}
}

// 3. Procedural quest generator: tier balance, property axes, determinism.
function testQuestGenerator() {
	const a = Game.create(S.create(G.createLayout(19)));
	const b = Game.create(S.create(G.createLayout(19)));
	assert.equal(a.quests.length, Game.BOARD_SIZE);
	assert.deepEqual(
		a.quests.map(q => [q.tier, q.title, q.points, q.timeLimit, q.bottles]),
		b.quests.map(q => [q.tier, q.title, q.points, q.timeLimit, q.bottles]),
		"quest board must be deterministic from layout seed",
	);

	const seen = { easy: 0, med: 0, hard: 0, wide: 0, narrow: 0, big: 0, exact: 0, band2: 0, band3: 0, band6: 0, timed: 0, multi: 0, pHi: 0, pLo: 0 };
	for (let k = 0; k < 240; k++) {
		const q = Game.generateQuest(a);
		seen[q.tier]++;
		if (q.timeLimit > 0) seen.timed++;
		if (q.bottles === 2) seen.multi++;
		if (q.kind === "pressure") {
			if (q.op === ">") seen.pHi++;
			else seen.pLo++;
			continue;
		}
		if (q.bands === 2) seen.band2++;
		else if (q.bands === 3) seen.band3++;
		else if (q.bands === 6) seen.band6++;
		else if (q.maxCount > 0 && q.minCount === q.maxCount) seen.exact++;
		else if (q.maxCount > 0 && q.maxCount - q.minCount >= 5) seen.wide++;
		else if (q.maxCount > 0) seen.narrow++;
		else if (q.minCount >= 8) seen.big++;
	}
	for (const [key, val] of Object.entries(seen)) assert.ok(val > 0, `generator must produce ${key} quests, got 0`);
	return seen;
}

// 4. Hue-band and circular-average-hue evaluation.
function testHueMatching() {
	const layout = G.createLayout(7);
	const sim = S.create(layout, { turning: false });
	const idx = 44;
	S.installValve(sim, idx, G.typeById("hollow-single"), 3, Game.GOAL_CHAMBER);
	const v = layout.valves[idx];

	// 6-band Amber quest (band 1: center 41°, half 22°, color index 1).
	const amber = Game.BAND_GROUPS[6][1];
	const quest6 = {
		kind: "grains",
		minCount: 5,
		maxCount: 0,
		bands: 6,
		hueCenter: amber.center,
		hueHalf: amber.half,
		colorMask: amber.mask,
	};

	function fillColors(colors) {
		S.drain(sim);
		for (let k = 0; k < colors.length; k++) {
			const a = (k / colors.length) * G.TAU;
			const r = k === 0 ? 0 : 6.2;
			assert.ok(S.addGrain(sim, v.cx + Math.cos(a) * r, v.cy + Math.sin(a) * r, 2.4, colors[k]) >= 0);
		}
	}

	// Direct band count: 5 Amber (1) + 2 Cobalt (3) passes even though Cobalt pulls mean hue.
	fillColors([1, 1, 1, 1, 1, 3, 3]);
	let res = Game.evaluateCell(sim, idx, quest6);
	assert.equal(res.matched, 5);
	assert.equal(res.ok, true, "5 matching grains satisfy 5+ 6-band quest despite stray grains");

	// Average hue: 3 Coral (0: 11°) + 3 Lime (5: 90°) -> circular mean ~50.5°, inside Amber 41° ± 22°!
	fillColors([0, 0, 0, 5, 5, 5]);
	res = Game.evaluateCell(sim, idx, quest6);
	assert.equal(res.matched, 0, "no individual grain is Amber");
	assert.equal(res.avgMatch, true, "Coral + Lime average hue lands inside Amber band");
	assert.equal(res.ok, true, "circular mean hue satisfies the quest without over-complicating");

	// Pure neighbor rejection: 5 pure Coral (11°) must NOT pass as 6-band Amber (41°).
	fillColors([0, 0, 0, 0, 0]);
	res = Game.evaluateCell(sim, idx, quest6);
	assert.equal(res.ok, false, "pure Coral (30° away) does not pass 6-band Amber");

	// Rainbow soup rejection: 1 of each color has near-zero coherence and must fail.
	fillColors([0, 1, 2, 3, 4, 5]);
	res = Game.evaluateCell(sim, idx, quest6);
	assert.ok(res.coherence < 0.2);
	assert.equal(res.ok, false, "unfiltered 6-color mix must not pass a 6-band quest");

	// 3-band Amber-Coral (Coral + Amber) accepts 3 Coral + 2 Amber.
	const triad = Game.BAND_GROUPS[3][0];
	const quest3 = { kind: "grains", minCount: 5, maxCount: 0, bands: 3, hueCenter: triad.center, hueHalf: triad.half, colorMask: triad.mask };
	fillColors([0, 0, 0, 1, 1]);
	assert.equal(Game.evaluateCell(sim, idx, quest3).ok, true, "3-band quest accepts Coral + Amber mix");
}

// 5. Quest lifecycle: mode defaults, one-sign exclusivity, upright bottle spawn,
// exact-count hold protection, completion -> solid blank, and timer expiration.
function testQuestLifecycle() {
	const layout = G.createLayout(11);
	const sim = S.create(layout);
	S.seed(sim);
	const game = Game.create(sim, { mode: "lab", botControl: false });
	S.setAutoRotate(sim, Game.LAB_AUTO);
	assert.ok(Math.abs(sim.autoRotate - 0.9) < 1e-9, "Lab mode default is 90%");

	Game.setMode(game, "game");
	assert.ok(Math.abs(sim.autoRotate - 0.2) < 1e-9, "Game mode default is 20%");

	// Inject a controlled Hard exact-3 quest onto the board.
	const exactQuest = game.quests[0];
	exactQuest.kind = "grains";
	exactQuest.tier = "hard";
	exactQuest.points = 50;
	exactQuest.minCount = 3;
	exactQuest.maxCount = 3;
	exactQuest.bands = 0;
	exactQuest.colorMask = 63;
	exactQuest.bottles = 1;
	exactQuest.timeLimit = 20;
	exactQuest.holdNeed = Game.HOLD_EXACT;
	exactQuest.title = "Exact 3 any-color grains";

	assert.equal(Game.signQuest(game, exactQuest.id, 0), true, "player 0 signs quest");
	assert.equal(Game.signQuest(game, exactQuest.id, 1), false, "only one sign allowed per goal");
	assert.equal(Game.signQuest(game, game.quests[1].id, 0), false, "player holds one active quest at a time");

	const goalCell = exactQuest.cells[0];
	const gv = layout.valves[goalCell];
	assert.equal(G.typeOf(gv).id, "hollow-single", "signed quest spawns hollow single");
	assert.equal(G.orientationOf(gv), 3, "bottle spawns at direction ↑ N (270°)");
	assert.deepEqual(G.worldPorts(gv), [3], "bottle world port is N");
	assert.equal(sim.caseTint[goalCell], 0, "bottle housing carries player 0 tint");
	assert.equal(sim.autoLocked[goalCell], 1, "bottle is locked from auto-rotation");
	assert.equal(S.placeValve(sim, goalCell, { type: "solid-cross", dir: 0 }), false, "active goal rejects type replacement");
	conserved(sim, "after quest sign");

	// Place 3 grains inside the bottle, hold briefly (< HOLD_EXACT), then add a 4th
	// grain to prove transient pass-through does not falsely complete an exact quest.
	for (let k = 0; k < 3; k++) assert.ok(S.addGrain(sim, gv.cx - 4 + k * 4, gv.cy, 2.3, k) >= 0);
	runGame(sim, game, 0.3);
	assert.equal(game.players[0].completed, 0, "must not complete before hold window");
	assert.ok(S.addGrain(sim, gv.cx, gv.cy - 5, 2.3, 3) >= 0);
	runGame(sim, game, 0.9);
	assert.equal(game.players[0].completed, 0, "4 grains must not complete an Exact 3 quest");

	// Remove 1 grain (simulating a spill to 3) and hold across HOLD_EXACT -> completes!
	sim.count--;
	sim.purged++;
	runGame(sim, game, 1.2);
	assert.equal(game.players[0].completed, 1, "Exact 3 completes after holding 1.0 s");
	assert.equal(game.players[0].score, 50);
	assert.equal(game.players[0].questId, -1);
	assert.equal(G.typeOf(layout.valves[goalCell]).id, "solid-blank", "completed goal bottle becomes solid blank");
	assert.equal(sim.caseTint[goalCell], -1, "completed goal clears housing tint");
	assert.equal(sim.autoLocked[goalCell], 0);
	assert.equal(game.quests.length, Game.BOARD_SIZE, "completed quest is replaced on the board");
	assert.ok(!game.quests.some(q => q.id === exactQuest.id), "completed quest is removed from list");
	conserved(sim, "after quest completion");

	// Timed quest expiration also seals bottle to solid blank and spawns replacement.
	const timed = game.quests[0];
	timed.kind = "grains";
	timed.minCount = 9;
	timed.maxCount = 0;
	timed.bands = 0;
	timed.colorMask = 63;
	timed.bottles = 1;
	timed.timeLimit = 0.5;
	assert.equal(Game.signQuest(game, timed.id, 0), true);
	const expCell = timed.cells[0];
	runGame(sim, game, 0.7);
	assert.equal(game.players[0].failed, 1, "expired timer counts failure");
	assert.equal(G.typeOf(layout.valves[expCell]).id, "solid-blank", "expired goal becomes solid blank");
	assert.equal(game.quests.length, Game.BOARD_SIZE);
	conserved(sim, "after timer expiry");
}

// 6. Pressure quest: auto-enables Grid gas, starts uncommitted, and completes when
// inlets/routes satisfy the target potential.
function testPressureQuest() {
	const layout = G.createLayout(7);
	const sim = S.create(layout, { turning: false });
	assert.equal(sim.pressureMode, "off");
	const game = Game.create(sim, { mode: "game", botControl: false });

	const pq = game.quests[0];
	pq.kind = "pressure";
	pq.op = ">";
	pq.threshold = 0.72;
	pq.bottles = 1;
	pq.timeLimit = 0;
	pq.holdNeed = Game.HOLD_EXACT;
	pq.title = "High air > 0.72";

	assert.equal(Game.signQuest(game, pq.id, 0), true);
	assert.equal(sim.pressureMode, "grid", "signing a pressure quest enables Grid gas");
	const cell = pq.cells[0];
	assert.equal(Game.evaluateCell(sim, cell, pq).ok, false, "spawned pressure quest requires player action");

	// Satisfy whichever polarity the quest resolved to by sealing opposing mouths.
	const wantHigh = pq.op === ">";
	for (let c = 0; c < G.N; c++) {
		const idx = (wantHigh ? I.TOP : I.BOTTOM) * G.N + c;
		if (sim.inlets.open[idx]) S.toggleInlet(sim, idx, false);
	}
	GAS.refresh(sim);
	runGame(sim, game, 1.2);
	assert.equal(game.players[0].completed, 1, "pressure quest completes once potential holds");
	assert.equal(G.typeOf(layout.valves[cell]).id, "solid-blank", "pressure bottle seals to solid blank");
}

// 7. Bot competitors: inactive when botControl is off, autonomous completion when on.
function testBots() {
	const layoutOff = G.createLayout(15);
	const simOff = S.create(layoutOff);
	S.seed(simOff);
	const gameOff = Game.create(simOff, { mode: "game", botControl: false });
	runGame(simOff, gameOff, 10);
	for (let p = 1; p < gameOff.players.length; p++) {
		assert.equal(gameOff.players[p].questId, -1, "disabled bots never sign quests");
		assert.equal(gameOff.players[p].completed, 0);
	}

	let totalCompleted = 0;
	let totalScore = 0;
	for (const seed of [7, 15]) {
		const layout = G.createLayout(seed);
		const sim = S.create(layout);
		S.seed(sim);
		S.setPressure(sim, "grid");
		const game = Game.create(sim, { mode: "game", botControl: true });
		runGame(sim, game, 40);
		conserved(sim, "bot run seed " + seed);
		for (let p = 1; p < game.players.length; p++) {
			totalCompleted += game.players[p].completed;
			totalScore += game.players[p].score;
		}
	}
	assert.ok(totalCompleted >= 1 && totalScore > 0, `bots must autonomously complete quests, got ${totalCompleted}`);
	return { totalCompleted, totalScore };
}

const t0 = process.hrtime.bigint();
testAutoRotate();
testCaseTints();
const gen = testQuestGenerator();
testHueMatching();
testQuestLifecycle();
testPressureQuest();
const bots = testBots();
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

console.log(
	`OK game v0.2: auto-rotate 0/20/90/100%, case tints (0 alloc rebuilds), quest gen (easy ${gen.easy} med ${gen.med} hard ${gen.hard}, bands 2/3/6 ${gen.band2}/${gen.band3}/${gen.band6}, exact ${gen.exact}, timed ${gen.timed}, 2-bottle ${gen.multi}, pressure ${gen.pHi + gen.pLo}), average-hue + band count, hold & solid-blank seal, bots completed ${bots.totalCompleted} (${bots.totalScore} pts) in ${ms.toFixed(0)} ms`,
);
