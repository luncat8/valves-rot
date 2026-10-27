// Game mode: player-tinted goal bottles, composable random quest generator,
// single-sign goal board, hue-band + average-hue evaluation, and bot routing.
// Pure state over ValveGeometry / ValveSimulation; no DOM or canvas calls.
const ValveGame = (() => {
	"use strict";

	const G = typeof ValveGeometry !== "undefined" ? ValveGeometry : require("./geometry.js");
	const S = typeof ValveSimulation !== "undefined" ? ValveSimulation : require("./simulation.js");
	const GAS = typeof ValveGas !== "undefined" ? ValveGas : require("./gas.js");
	const I = typeof ValveInlets !== "undefined" ? ValveInlets : require("./inlets.js");
	const R = typeof ValveRender !== "undefined" ? ValveRender : require("./render.js");

	const N = G.N;
	const SLOTS = N * N;
	const LAB_AUTO = 0.9;
	const GAME_AUTO = 0.2;
	const BOARD_SIZE = 5;
	const HOLD_OPEN = 0.45;
	const HOLD_EXACT = 1.0;
	const COHERENCE_MIN = 0.42;
	const GOAL_CHAMBER = G.RV * 0.53;
	const EVAL_DT = 1 / 15;

	// Grain palette hues in degrees for GRAIN_COLORS[0..5]:
	// 0 coral, 1 amber, 2 cyan, 3 cobalt, 4 magenta, 5 lime.
	const GRAIN_HUE_DEG = [11, 41, 173, 227, 323, 90];
	const GRAIN_COS = new Float64Array(6);
	const GRAIN_SIN = new Float64Array(6);
	for (let c = 0; c < 6; c++) {
		const rad = (GRAIN_HUE_DEG[c] * Math.PI) / 180;
		GRAIN_COS[c] = Math.cos(rad);
		GRAIN_SIN[c] = Math.sin(rad);
	}

	// Hue band partitions around the 360° wheel:
	// 2 bands split 3+3 colors, 3 bands split 2+2+2, 6 bands isolate 1 color each
	// while still accepting a circular mean hue inside ±hueHalf.
	const BAND_GROUPS = {
		2: [
			{ name: "Warm hue", swatch: "#f0964f", center: 55, half: 90, mask: (1 << 0) | (1 << 1) | (1 << 5) },
			{ name: "Cool hue", swatch: "#6fa6eb", center: 235, half: 90, mask: (1 << 2) | (1 << 3) | (1 << 4) },
		],
		3: [
			{ name: "Amber-Coral", swatch: "#ed9453", center: 25, half: 60, mask: (1 << 0) | (1 << 1) },
			{ name: "Jade-Cyan", swatch: "#67bd86", center: 145, half: 60, mask: (1 << 5) | (1 << 2) },
			{ name: "Indigo-Rose", swatch: "#ab85c9", center: 265, half: 60, mask: (1 << 3) | (1 << 4) },
		],
		6: [
			{ name: "Coral", swatch: "#f07a5f", center: 11, half: 22, mask: 1 << 0 },
			{ name: "Amber", swatch: "#e9b64b", center: 41, half: 22, mask: 1 << 1 },
			{ name: "Lime", swatch: "#8cbf5a", center: 90, half: 22, mask: 1 << 5 },
			{ name: "Cyan", swatch: "#4fb8ab", center: 173, half: 22, mask: 1 << 2 },
			{ name: "Cobalt", swatch: "#7f93dd", center: 227, half: 22, mask: 1 << 3 },
			{ name: "Magenta", swatch: "#d978b4", center: 323, half: 22, mask: 1 << 4 },
		],
	};

	const EXACT_CHOICES = [1, 3, 5, 7];

	// Preallocated scratch buffers shared across step evaluations and bot BFS.
	const evalOut = { total: 0, matched: 0, effective: 0, meanDeg: -1, coherence: 0, avgMatch: false, potential: 0.5, ok: false };
	const bfsDist = new Int16Array(SLOTS);
	const bfsNext = new Int16Array(SLOTS);
	const bfsOutDir = new Int8Array(SLOTS);
	const bfsQueue = new Int16Array(SLOTS);
	const cellGrains = new Uint16Array(SLOTS);
	const baseMasks = new Uint8Array(SLOTS);

	function rotMask(mask, quarter) {
		const q = ((quarter % 4) + 4) % 4;
		return q === 0 ? mask : ((mask << q) | (mask >> (4 - q))) & 15;
	}

	function valveMask(v) {
		let m = 0;
		for (let k = 0; k < v.ports.length; k++) m |= 1 << v.ports[k];
		return m;
	}

	function canSatisfyMask(baseMask, needMask) {
		for (let q = 0; q < 4; q++) {
			if ((rotMask(baseMask, q) & needMask) === needMask) return true;
		}
		return false;
	}

	function bestQuarterForMask(baseMask, curQuarter, needMask) {
		if ((rotMask(baseMask, curQuarter) & needMask) === needMask) return curQuarter;
		for (const step of [1, -1, 2]) {
			const q = (curQuarter + step + 4) & 3;
			if ((rotMask(baseMask, q) & needMask) === needMask) return q;
		}
		return -1;
	}

	function angleDiffDeg(a, b) {
		let d = (a - b) % 360;
		if (d > 180) d -= 360;
		else if (d < -180) d += 360;
		return d < 0 ? -d : d;
	}

	function randInt(rnd, lo, hi) {
		return lo + ((rnd() * (hi - lo + 1)) | 0);
	}

	function makePlayers() {
		return R.PLAYERS.map(p => ({
			id: p.id,
			name: p.name,
			bot: p.bot,
			hex: p.hex,
			accent: p.accent,
			score: 0,
			completed: 0,
			failed: 0,
			questId: -1,
		}));
	}

	function formatQuestTitle(q) {
		const prefix = q.bottles > 1 ? q.bottles + "× bottles · " : "";
		if (q.kind === "pressure") {
			const dir = q.op === ">" ? "High air > " : "Low air < ";
			return prefix + dir + q.threshold.toFixed(2);
		}
		let countStr = q.minCount + "+";
		if (q.maxCount > 0) {
			countStr = q.minCount === q.maxCount ? "Exact " + q.minCount : q.minCount + "–" + q.maxCount;
		}
		const colorStr = q.bands > 0 ? " " + q.bandName + " (" + q.bands + "-band)" : " any-color";
		const noun = q.minCount === 1 && q.maxCount === 1 ? " grain" : " grains";
		return prefix + countStr + colorStr + noun;
	}

	function rollCandidate(game) {
		const rnd = game.random;
		const id = ++game.nextQuestId;
		const isPressure = rnd() < 0.22;
		if (isPressure) {
			const op = rnd() < 0.5 ? ">" : "<";
			const strong = rnd() < 0.42;
			const threshold = op === ">" ? (strong ? 0.78 : 0.68) : strong ? 0.22 : 0.32;
			const bottles = !strong && rnd() < 0.22 ? 2 : 1;
			const timeRoll = rnd();
			const timeLimit = timeRoll < 0.55 ? 0 : timeRoll < 0.82 ? 70 : 45;
			const diff = (strong ? 3 : 2) + (bottles > 1 ? 2 : 0) + (timeLimit === 45 ? 2 : timeLimit > 0 ? 1 : 0);
			return finalizeQuest(id, {
				kind: "pressure",
				op,
				threshold,
				minCount: 0,
				maxCount: 0,
				bands: 0,
				bandIndex: 0,
				bandName: "",
				swatch: op === ">" ? "#ff8a5c" : "#5cc8ff",
				hueCenter: 0,
				hueHalf: 180,
				colorMask: 63,
				bottles,
				timeLimit,
				difficulty: diff,
			});
		}

		const bandRoll = rnd();
		const bands = bandRoll < 0.62 ? 0 : bandRoll < 0.76 ? 2 : bandRoll < 0.89 ? 3 : 6;
		let minCount = 3;
		let maxCount = 0;
		let shapeDiff = 0;
		if (bands > 0) {
			// Hue-band quests ask for N+ matching or average-hue grains so color
			// routing is not over-complicated by simultaneous upper caps.
			minCount = bands === 6 ? randInt(rnd, 4, 6) : randInt(rnd, 5, 7);
			maxCount = 0;
			shapeDiff = bands === 6 ? 4 : 2;
		} else {
			const sRoll = rnd();
			if (sRoll < 0.32) {
				minCount = randInt(rnd, 2, 4);
				maxCount = minCount + randInt(rnd, 5, 6);
				shapeDiff = 0;
			} else if (sRoll < 0.58) {
				minCount = randInt(rnd, 3, 6);
				maxCount = 0;
				shapeDiff = 0;
			} else if (sRoll < 0.75) {
				minCount = randInt(rnd, 4, 6);
				maxCount = minCount + randInt(rnd, 2, 3);
				shapeDiff = 2;
			} else if (sRoll < 0.88) {
				minCount = randInt(rnd, 8, 11);
				maxCount = 0;
				shapeDiff = 2;
			} else {
				minCount = EXACT_CHOICES[(rnd() * EXACT_CHOICES.length) | 0];
				maxCount = minCount;
				shapeDiff = 4;
			}
		}

		let bandName = "";
		let swatch = "";
		let hueCenter = 0;
		let hueHalf = 180;
		let colorMask = 63;
		let bandIndex = 0;
		if (bands > 0) {
			const group = BAND_GROUPS[bands];
			bandIndex = (rnd() * group.length) | 0;
			const entry = group[bandIndex];
			bandName = entry.name;
			swatch = entry.swatch;
			hueCenter = entry.center;
			hueHalf = entry.half;
			colorMask = entry.mask;
		}

		const bottles = shapeDiff <= 2 && bands < 6 && rnd() < 0.16 ? 2 : 1;
		const tRoll = rnd();
		const timeLimit = tRoll < 0.72 ? 0 : tRoll < 0.9 ? 75 : 45;
		const diff = shapeDiff + (bottles > 1 ? 2 : 0) + (timeLimit === 45 ? 2 : timeLimit > 0 ? 1 : 0);

		return finalizeQuest(id, {
			kind: "grains",
			op: "",
			threshold: 0,
			minCount,
			maxCount,
			bands,
			bandIndex,
			bandName,
			swatch,
			hueCenter,
			hueHalf,
			colorMask,
			bottles,
			timeLimit,
			difficulty: diff,
		});
	}

	function finalizeQuest(id, spec) {
		const tier = spec.difficulty <= 1 ? "easy" : spec.difficulty <= 3 ? "med" : "hard";
		const points = tier === "easy" ? 10 : tier === "med" ? 25 : 50;
		const holdNeed = spec.kind === "grains" && spec.maxCount === 0 ? HOLD_OPEN : HOLD_EXACT;
		const q = {
			id,
			tier,
			points,
			difficulty: spec.difficulty,
			kind: spec.kind,
			op: spec.op,
			threshold: spec.threshold,
			minCount: spec.minCount,
			maxCount: spec.maxCount,
			bands: spec.bands,
			bandIndex: spec.bandIndex,
			bandName: spec.bandName,
			swatch: spec.swatch,
			hueCenter: spec.hueCenter,
			hueHalf: spec.hueHalf,
			colorMask: spec.colorMask,
			bottles: spec.bottles,
			timeLimit: spec.timeLimit,
			remaining: spec.timeLimit,
			holdNeed,
			hold: 0,
			holdRatio: 0,
			owner: -1,
			cellCount: 0,
			cells: new Int32Array(2),
			cellValues: new Float64Array(2),
			cellTotals: new Int16Array(2),
			cellOk: new Uint8Array(2),
			cellTags: ["", ""],
			title: "",
			progressText: "Unsigned",
		};
		q.cells.fill(-1);
		q.title = formatQuestTitle(q);
		return q;
	}

	function generateQuest(game, tierHint) {
		let fallback = null;
		for (let attempt = 0; attempt < 24; attempt++) {
			const q = rollCandidate(game);
			fallback = q;
			if (!tierHint || q.tier === tierHint) return q;
		}
		return fallback;
	}

	function neededTier(quests) {
		let easy = 0;
		let med = 0;
		let hard = 0;
		for (let k = 0; k < quests.length; k++) {
			if (quests[k].tier === "easy") easy++;
			else if (quests[k].tier === "med") med++;
			else hard++;
		}
		if (easy === 0) return "easy";
		if (med === 0) return "med";
		if (hard === 0) return "hard";
		return null;
	}

	function spawnQuest(game, tierHint) {
		const hint = tierHint || neededTier(game.quests);
		const q = generateQuest(game, hint);
		game.quests.push(q);
		game.version++;
		return q;
	}

	function create(sim, options) {
		const o = options || {};
		const seed = (sim.layout.seed | 0) ^ 0x51f2a9;
		const game = {
			sim,
			mode: o.mode === "game" ? "game" : "lab",
			botControl: o.botControl !== false,
			random: G.rng(seed),
			players: makePlayers(),
			quests: [],
			nextQuestId: 0,
			version: 1,
			evalClock: 0,
			pourCooldown: 0,
			botCooldown: new Float64Array([0, 1.1, 1.9, 2.7]),
			dirtyRotors: new Uint8Array(SLOTS),
			dirtyCases: false,
			hasDirtyRotors: false,
			lastEvent: "Sign a goal to spawn your colored bottle on the field.",
		};
		seedBoard(game);
		if (game.mode === "game") S.setAutoRotate(sim, GAME_AUTO);
		return game;
	}

	function seedBoard(game) {
		game.quests.length = 0;
		const initial = ["easy", "easy", "med", "med", "hard"];
		for (let k = 0; k < BOARD_SIZE; k++) spawnQuest(game, initial[k]);
	}

	function markRotorDirty(game, index) {
		game.dirtyRotors[index] = 1;
		game.hasDirtyRotors = true;
	}

	function consumeDirty(game, scene) {
		if (!scene) return;
		if (game.dirtyCases) {
			R.rebuildBackground(scene, game.sim.layout, game.sim.caseTint);
			game.dirtyCases = false;
		}
		if (!game.hasDirtyRotors) return;
		for (let k = 0; k < SLOTS; k++) {
			if (!game.dirtyRotors[k]) continue;
			game.dirtyRotors[k] = 0;
			R.rebuildRotor(scene, game.sim.layout, k);
		}
		game.hasDirtyRotors = false;
	}

	function setMode(game, mode) {
		if (mode !== "lab" && mode !== "game") return false;
		if (game.mode === mode) return true;
		if (mode === "lab") clearActiveGoals(game, false);
		game.mode = mode;
		S.setAutoRotate(game.sim, mode === "game" ? GAME_AUTO : LAB_AUTO);
		if (mode === "game" && game.quests.length < BOARD_SIZE) seedBoard(game);
		game.version++;
		return true;
	}

	function setBotControl(game, enabled) {
		game.botControl = !!enabled;
		game.version++;
	}

	// Clears signed goals cleanly when resetting or returning to Lab mode.
	function clearActiveGoals(game, sealWithBlank) {
		const sim = game.sim;
		const blank = G.typeById("solid-blank");
		for (let q = 0; q < game.quests.length; q++) {
			const quest = game.quests[q];
			if (quest.owner < 0) continue;
			for (let s = 0; s < quest.cellCount; s++) {
				const idx = quest.cells[s];
				sim.autoLocked[idx] = 0;
				sim.goalOwner[idx] = -1;
				S.setCaseTint(sim, idx, -1);
				if (sealWithBlank) {
					S.installValve(sim, idx, blank, 0);
					markRotorDirty(game, idx);
				}
			}
			game.dirtyCases = true;
		}
		for (let p = 0; p < game.players.length; p++) game.players[p].questId = -1;
	}

	function resetMatch(game, sim) {
		if (sim) game.sim = sim;
		clearActiveGoals(game, false);
		game.random = G.rng((game.sim.layout.seed | 0) ^ 0x51f2a9);
		for (let p = 0; p < game.players.length; p++) {
			game.players[p].score = 0;
			game.players[p].completed = 0;
			game.players[p].failed = 0;
			game.players[p].questId = -1;
		}
		game.nextQuestId = 0;
		game.evalClock = 0;
		game.pourCooldown = 0;
		game.botCooldown[1] = 1.1;
		game.botCooldown[2] = 1.9;
		game.botCooldown[3] = 2.7;
		seedBoard(game);
		if (game.mode === "game") S.setAutoRotate(game.sim, GAME_AUTO);
		game.lastEvent = "New match started — sign a goal to spawn your bottle.";
		game.version++;
	}

	// True when valve `v` can deflect a grain arriving from North sideways (an elbow's
	// curved chute, whereas a tee/cross with South closed traps single grains on its floor).
	function canDeflectSideways(v) {
		const id = G.typeOf(v).id;
		return id === "solid-elbow" || id === "hollow-elbow";
	}

	// Gravity-plausible reachability from row-0 pour spouts to `entry` (which must
	// exit South into the bottle's North port): allows vertical drops through
	// straight/tee/cross bores and single-cell lateral jogs via elbow chutes.
	function findGravityTopSpout(sim, entry, pureVerticalOnly) {
		if (entry < 0 || sim.goalOwner[entry] >= 0) return -1;
		const valves = sim.layout.valves;
		for (let k = 0; k < SLOTS; k++) baseMasks[k] = valveMask(valves[k]);
		if (!canSatisfyMask(baseMasks[entry], 1 << 1)) return -1;
		bfsDist.fill(-1);
		bfsOutDir.fill(-1);
		let head = 0;
		let tail = 0;
		bfsDist[entry] = 0;
		bfsOutDir[entry] = 1;
		bfsQueue[tail++] = entry;
		let fallbackTop = -1;
		while (head < tail) {
			const u = bfsQueue[head++];
			const outDir = bfsOutDir[u];
			const ui = u % N;
			const uj = (u / N) | 0;
			if (uj === 0 && canSatisfyMask(baseMasks[u], (1 << 3) | (1 << outDir))) {
				if (outDir !== 1 && !canDeflectSideways(valves[u])) {
					// Top cell cannot deflect sideways without an elbow ramp.
				} else {
					if (sim.spoutMask[ui]) return ui;
					if (fallbackTop < 0) fallbackTop = ui;
				}
			}
			const sides = pureVerticalOnly ? [3] : [3, 0, 2];
			for (let s = 0; s < sides.length; s++) {
				const inSide = sides[s];
				if (inSide === outDir) continue;
				// Avoid chaining two horizontal steps in a row, and require an elbow chute
				// on the cell that turns a vertical drop (N) into a lateral exit (E/W).
				if (outDir !== 1 && (inSide !== 3 || !canDeflectSideways(valves[u]))) continue;
				if (!canSatisfyMask(baseMasks[u], (1 << inSide) | (1 << outDir))) continue;
				const pi = ui + G.DX[inSide];
				const pj = uj + G.DY[inSide];
				if (pi < 0 || pi >= N || pj < 0 || pj >= N) continue;
				const pk = pj * N + pi;
				if (bfsDist[pk] >= 0 || sim.goalOwner[pk] >= 0 || valves[pk].ports.length < 2) continue;
				const pOut = (inSide + 2) & 3;
				if (pOut !== 1 && !canDeflectSideways(valves[pk])) continue;
				if (!canSatisfyMask(baseMasks[pk], 1 << pOut)) continue;
				bfsDist[pk] = bfsDist[u] + 1;
				bfsOutDir[pk] = pOut;
				bfsQueue[tail++] = pk;
			}
		}
		return fallbackTop;
	}

	function reachableFromTop(sim, targetCell) {
		return findGravityTopSpout(sim, targetCell, false) >= 0;
	}

	// Mean potential of the air cells in the bottle's chamber; `field` is `p`, or
	// the target buffer of a hypothetical mouth set.
	function sampleChamber(sim, index, field) {
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
				sum += field[k];
				n++;
			}
		}
		return n > 0 ? sum / n : gas.air[c0] ? field[c0] : 0.5;
	}

	function sampleChamberPotential(sim, index) {
		const gas = sim.pressure;
		if (!gas || gas.kind !== "grid") return 0.5;
		return sampleChamber(sim, index, gas.p);
	}

	// Keep a pressure quest inside what the mouths can actually do here. Snap the
	// live field first so the fitted threshold is measured against the pressure
	// the player actually sees, then solve the two extreme mouth sets.
	function fitPressureQuest(sim, quest, index) {
		const gas = sim.pressure;
		if (!gas || gas.kind !== "grid") return;
		GAS.refresh(sim, true);
		const base = sampleChamberPotential(sim, index);
		const col = index % N;
		const high = GAS.probeMouths(sim, true, col) ? sampleChamber(sim, index, gas.pTarget) : base;
		const low = GAS.probeMouths(sim, false, col) ? sampleChamber(sim, index, gas.pTarget) : base;
		GAS.refresh(sim, true);
		const upper = Math.max(base, high, low);
		const lower = Math.min(base, high, low);
		const wanted = quest.op;
		if (wanted === ">" ? upper - base > 0.05 : base - lower > 0.05) {
			// Keep the generated polarity if the mouths can reach it here.
		} else if (upper - base > 0.05 && upper - base >= base - lower) {
			quest.op = ">";
		} else if (base - lower > 0.05) {
			quest.op = "<";
		} else {
			// No mouth set moves this pocket: still start uncommitted so the quest
			// asks the player to open a route with the valves.
			quest.op = base >= 0.5 ? "<" : ">";
		}
		const reach = quest.op === ">" ? Math.max(upper, base + 0.25) : Math.min(lower, base - 0.25);
		// Aim part of the way to what the best mouth set reaches, so the target
		// sits inside the field this cell can actually produce and starts unmet.
		const aim = base + (reach - base) * 0.6;
		quest.threshold = Number(Math.min(0.98, Math.max(0.02, aim)).toFixed(2));
		quest.swatch = quest.op === ">" ? "#ff8a5c" : "#5cc8ff";
		quest.title = formatQuestTitle(quest);
	}

	function columnHasGoal(sim, col, chosen) {
		for (let r = 0; r < N; r++) if (sim.goalOwner[r * N + col] >= 0) return true;
		for (let k = 0; k < chosen.length; k++) if (chosen[k] % N === col) return true;
		return false;
	}

	function pickGoalCells(game, quest) {
		const sim = game.sim;
		const rnd = game.random;
		const chosen = [];
		const rowMin = 3;
		const rowMax = quest.kind === "pressure" ? 6 : 8;
		for (let slot = 0; slot < quest.bottles; slot++) {
			let picked = -1;
			// Pass 0: distinct column + pure/elbow gravity path; Pass 1: distinct column + reachable;
			// Pass 2: any cell that does not directly cork an existing bottle.
			for (let pass = 0; pass < 3 && picked < 0; pass++) {
				const startCol = (rnd() * N) | 0;
				const startRow = rowMin + ((rnd() * (rowMax - rowMin + 1)) | 0);
				for (let dr = 0; dr <= rowMax - rowMin && picked < 0; dr++) {
					const j = rowMin + ((startRow - rowMin + dr) % (rowMax - rowMin + 1));
					for (let dc = 0; dc < N; dc++) {
						const i = (startCol + dc) % N;
						const idx = j * N + i;
						if (sim.goalOwner[idx] >= 0 || chosen.indexOf(idx) >= 0) continue;
						// Never spawn directly above or below an active goal bottle (would cork its ↑ N port!).
						const above = idx - N;
						const below = idx + N;
						if (sim.goalOwner[above] >= 0) continue;
						if (below < SLOTS && sim.goalOwner[below] >= 0) continue;
						if (chosen.indexOf(above) >= 0 || chosen.indexOf(below) >= 0) continue;
						if (pass < 2 && columnHasGoal(sim, i, chosen)) continue;
						if (chosen.length && Math.abs((chosen[0] % N) - i) < 2 && pass < 2) continue;
						if (pass === 0 && !reachableFromTop(sim, above)) continue;
						if (pass < 2 && sim.layout.valves[above].ports.length < 2) continue;
						if (quest.kind === "pressure" && pass < 2 && sim.pressure && sim.pressure.kind === "grid") {
							const p0 = sim.pressure.p[GAS.index((i + 0.5) * G.S, (j + 0.5) * G.S)];
							const already = quest.op === ">" ? p0 > quest.threshold - 0.05 : p0 < quest.threshold + 0.05;
							if (already) continue;
						}
						picked = idx;
						break;
					}
				}
			}
			if (picked < 0) break;
			// If every remaining cell had a blank plug above it after many rounds,
			// reopen the feeder above so the ↑ N bottle stays routable.
			const above = picked - N;
			if (sim.goalOwner[above] < 0 && sim.layout.valves[above].ports.length < 2) {
				S.installValve(sim, above, G.typeById("solid-tee"), 0);
				markRotorDirty(game, above);
			}
			chosen.push(picked);
		}
		return chosen;
	}

	// A pressure goal bottle has a single north port, so a random machine can
	// leave it cut off from both mouth bands. Open a vertical shaft in its column
	// and the neighbouring one: that gives the bottle a route to the high and low
	// constant-pressure boundaries without sealing any other valve.
	function ensureAirRoute(game, cells) {
		const sim = game.sim;
		const cross = G.typeById("solid-cross");
		for (let s = 0; s < cells.length; s++) {
			const i = cells[s] % N;
			for (let j = 0; j < N; j++) {
				const k = j * N + i;
				if (sim.goalOwner[k] >= 0) continue;
				const v = sim.layout.valves[k];
				if (G.typeOf(v).id === "solid-cross" && v.angle === 0) continue;
				S.installValve(sim, k, cross, 0);
				markRotorDirty(game, k);
			}
		}
	}

	function questIndexById(game, questId) {
		for (let k = 0; k < game.quests.length; k++) if (game.quests[k].id === questId) return k;
		return -1;
	}

	function signQuest(game, questId, playerId) {
		if (playerId < 0 || playerId >= game.players.length) return false;
		const player = game.players[playerId];
		if (player.questId >= 0) return false;
		const qIndex = questIndexById(game, questId);
		if (qIndex < 0) return false;
		const quest = game.quests[qIndex];
		if (quest.owner >= 0) return false;

		const sim = game.sim;
		if (quest.kind === "pressure" && sim.pressureMode !== "grid") S.setPressure(sim, "grid");

		const cells = pickGoalCells(game, quest);
		if (!cells.length) return false;

		const bottleType = G.typeById(quest.kind === "pressure" ? "hollow-cross" : "hollow-single");
		quest.owner = playerId;
		quest.cellCount = cells.length;
		quest.hold = 0;
		quest.holdRatio = 0;
		quest.remaining = quest.timeLimit;
		quest.cellValues.fill(-1);
		quest.cellTotals.fill(-1);
		quest.cellOk.fill(0);
		player.questId = quest.id;

		for (let s = 0; s < cells.length; s++) {
			const idx = cells[s];
			quest.cells[s] = idx;
			// Spawn 'hollow single · direction ↑ N · 270° (ports N)' with player's color tint.
			S.installValve(sim, idx, bottleType, 3, GOAL_CHAMBER);
			sim.autoLocked[idx] = 1;
			sim.goalOwner[idx] = playerId;
			S.setCaseTint(sim, idx, playerId);
			markRotorDirty(game, idx);
			if (quest.kind === "grains") {
				const topCol = findGravityTopSpout(sim, idx - N);
				if (topCol >= 0) sim.spoutMask[topCol] = 1;
			}
		}

		// Open the air route first, then fit the target to the range this cell can
		// actually reach; that also keeps it from being satisfied on frame 0.
		if (quest.kind === "pressure") {
			ensureAirRoute(game, cells);
			fitPressureQuest(sim, quest, cells[0]);
		}

		game.dirtyCases = true;
		evaluateQuest(game, quest);
		const first = sim.layout.valves[cells[0]];
		game.lastEvent = player.name + " signed: " + quest.title + " → (" + (first.i + 1) + "," + (first.j + 1) + ")";
		game.version++;
		return true;
	}

	function evaluateCell(sim, cellIndex, quest) {
		if (quest.kind === "pressure") {
			const gas = sim.pressure;
			const live = !!gas && gas.kind === "grid";
			const p = live ? sampleChamberPotential(sim, cellIndex) : 0.5;
			evalOut.potential = p;
			evalOut.ok = live && (quest.op === ">" ? p > quest.threshold : p < quest.threshold);
			return evalOut;
		}
		const v = sim.layout.valves[cellIndex];
		const r2 = G.RV * G.RV;
		let total = 0;
		let matched = 0;
		let cosSum = 0;
		let sinSum = 0;
		for (let k = 0; k < sim.count; k++) {
			const x = sim.x[k];
			const y = sim.y[k];
			if (G.cellAt(x, y) !== cellIndex) continue;
			const dx = x - v.cx;
			const dy = y - v.cy;
			if (dx * dx + dy * dy >= r2) continue;
			total++;
			const c = sim.color[k];
			cosSum += GRAIN_COS[c];
			sinSum += GRAIN_SIN[c];
			if (quest.colorMask & (1 << c)) matched++;
		}
		let effective = total;
		let avgMatch = false;
		let meanDeg = -1;
		let coherence = 0;
		if (quest.bands > 0) {
			effective = matched;
			if (total > 0) {
				coherence = Math.hypot(cosSum, sinSum) / total;
				meanDeg = ((Math.atan2(sinSum, cosSum) * 180) / Math.PI + 360) % 360;
				avgMatch = coherence >= COHERENCE_MIN && angleDiffDeg(meanDeg, quest.hueCenter) <= quest.hueHalf;
				if (avgMatch && total > effective) effective = total;
			}
		}
		evalOut.total = total;
		evalOut.matched = matched;
		evalOut.effective = effective;
		evalOut.meanDeg = meanDeg;
		evalOut.coherence = coherence;
		evalOut.avgMatch = avgMatch;
		evalOut.ok = effective >= quest.minCount && (quest.maxCount === 0 || total <= quest.maxCount);
		return evalOut;
	}

	function evaluateQuest(game, quest) {
		const sim = game.sim;
		let allOk = quest.cellCount > 0;
		let changed = false;
		for (let s = 0; s < quest.cellCount; s++) {
			const res = evaluateCell(sim, quest.cells[s], quest);
			quest.cellOk[s] = res.ok ? 1 : 0;
			if (!res.ok) allOk = false;
			if (quest.kind === "pressure") {
				const bucket = Math.round(res.potential * 100);
				if (quest.cellValues[s] !== bucket) {
					quest.cellValues[s] = bucket;
					quest.cellTags[s] = (bucket / 100).toFixed(2) + quest.op + quest.threshold.toFixed(2);
					changed = true;
				}
			} else {
				const val = res.effective;
				if (quest.cellValues[s] !== val || quest.cellTotals[s] !== res.total) {
					quest.cellValues[s] = val;
					quest.cellTotals[s] = res.total;
					const cap = quest.maxCount > 0 ? (quest.minCount === quest.maxCount ? "/" + quest.minCount : "/" + quest.minCount + "-" + quest.maxCount) : "/" + quest.minCount + "+";
					quest.cellTags[s] = val + cap;
					changed = true;
				}
			}
		}
		if (changed) {
			let summary = "";
			for (let s = 0; s < quest.cellCount; s++) {
				const v = sim.layout.valves[quest.cells[s]];
				if (s > 0) summary += " · ";
				summary += "(" + (v.i + 1) + "," + (v.j + 1) + ") " + quest.cellTags[s];
			}
			quest.progressText = summary;
			game.version++;
		}
		return allOk;
	}

	function finishQuest(game, qIndex, outcome) {
		const quest = game.quests[qIndex];
		const player = game.players[quest.owner];
		const sim = game.sim;
		const blank = G.typeById("solid-blank");

		for (let s = 0; s < quest.cellCount; s++) {
			const idx = quest.cells[s];
			sim.autoLocked[idx] = 0;
			sim.goalOwner[idx] = -1;
			S.setCaseTint(sim, idx, -1);
			// Quest end: replace goal bottle 'hollow single' with 'solid blank'.
			S.installValve(sim, idx, blank, 0);
			markRotorDirty(game, idx);
		}
		game.dirtyCases = true;

		if (player) {
			player.questId = -1;
			if (outcome === "done") {
				player.score += quest.points;
				player.completed++;
				game.lastEvent = player.name + " completed " + quest.title + " (+" + quest.points + " pts)!";
			} else if (outcome === "expired") {
				player.failed++;
				game.lastEvent = player.name + " ran out of time on " + quest.title + ".";
			} else {
				game.lastEvent = player.name + " dropped " + quest.title + ".";
			}
		}

		game.quests.splice(qIndex, 1);
		spawnQuest(game, null);
		game.version++;
	}

	function dropQuest(game, playerId) {
		const player = game.players[playerId];
		if (!player || player.questId < 0) return false;
		const qIndex = questIndexById(game, player.questId);
		if (qIndex < 0) return false;
		finishQuest(game, qIndex, "dropped");
		return true;
	}

	// ---- Bot AI ---------------------------------------------------------------
	function tallyCellGrains(sim, colorMask) {
		cellGrains.fill(0);
		for (let k = 0; k < sim.count; k++) {
			if (sim.y[k] < 0 || sim.y[k] >= G.SIZE) continue;
			if ((colorMask & (1 << sim.color[k])) === 0) continue;
			cellGrains[G.cellAt(sim.x[k], sim.y[k])]++;
		}
	}

	function botSignChoice(game, botId) {
		let activeBotPressure = "";
		for (let m = 0; m < game.quests.length; m++) {
			const mq = game.quests[m];
			if (mq.owner > 0 && mq.kind === "pressure") activeBotPressure = mq.op;
		}
		let bestIdx = -1;
		let bestScore = -1e9;
		for (let k = 0; k < game.quests.length; k++) {
			const q = game.quests[k];
			if (q.owner >= 0) continue;
			if (q.kind === "pressure" && activeBotPressure && q.op !== activeBotPressure) continue;
			// Stagger bot appetite by bot id so competitors pick varied tiers.
			let score = q.points * 0.4 - q.difficulty * (botId === 1 ? 4 : botId === 2 ? 1.5 : 0.5);
			if (q.kind === "grains") score += 2.5;
			if (q.bottles > 1) score -= 5;
			score += game.random() * 6;
			if (score > bestScore) {
				bestScore = score;
				bestIdx = k;
			}
		}
		return bestIdx >= 0 ? game.quests[bestIdx].id : -1;
	}

	function botStepGrainQuest(game, quest) {
		const sim = game.sim;
		const valves = sim.layout.valves;

		// Pick the first unsatisfied bottle, or shut the feeder above an exact/range
		// bottle that already holds its target count so extra grains do not overshoot.
		let targetSlot = 0;
		for (let s = 0; s < quest.cellCount; s++) {
			if (!quest.cellOk[s]) {
				targetSlot = s;
				break;
			}
		}
		const goalIdx = quest.cells[targetSlot];
		const goalValve = valves[goalIdx];

		// Keep the bottle upright facing ↑ N (quarter 3) unless it overflowed maxCount.
		const goalQ = G.quarterOf(sim.target[goalIdx]);
		const overflowed = quest.maxCount > 0 && quest.cellTotals[targetSlot] > quest.maxCount;
		if (overflowed) {
			if (goalQ === 3) return S.turn(sim, goalIdx, 1);
			return false;
		}
		if (goalQ !== 3) {
			const stepQ = ((3 - goalQ + 4) & 3) === 3 ? -1 : 1;
			return S.turn(sim, goalIdx, stepQ);
		}

		// If bounded bottle is currently satisfied and holding, close feeder above it.
		if (quest.maxCount > 0 && quest.cellOk[targetSlot] && goalIdx >= N) {
			const feeder = goalIdx - N;
			if (sim.goalOwner[feeder] < 0) {
				const fMask = rotMask(valveMask(valves[feeder]), G.quarterOf(sim.target[feeder]));
				if (fMask & (1 << 1)) return S.turn(sim, feeder, 1);
			}
			return false;
		}

		// Pour fresh grains if the machine is running lean.
		if (sim.count < 42 && game.pourCooldown <= 0) {
			if (S.pour(sim, 16) > 0) {
				game.pourCooldown = 2.8;
				return true;
			}
		}

		const entry = goalIdx - N;
		if (entry < 0 || sim.goalOwner[entry] >= 0) return false;

		for (let k = 0; k < SLOTS; k++) baseMasks[k] = valveMask(valves[k]);
		tallyCellGrains(sim, quest.colorMask);

		// Backward BFS from `entry` (flowing S into the bottle's N mouth) to find
		// the nearest grain-rich pocket or top pour spout along geometrically valid pipes.
		bfsDist.fill(-1);
		bfsNext.fill(-1);
		bfsOutDir.fill(-1);
		let head = 0;
		let tail = 0;
		if (valves[entry].ports.length >= 1) {
			bfsDist[entry] = 0;
			bfsOutDir[entry] = 1; // must output South (1) into goal's North (3)
			bfsQueue[tail++] = entry;
		}

		let bestSource = -1;
		let bestCost = 1e9;
		while (head < tail) {
			const u = bfsQueue[head++];
			const d = bfsDist[u];
			const outDir = bfsOutDir[u];
			const ui = u % N;
			const uj = (u / N) | 0;

			// Can `u` act as a source itself (top spout with port N, or cell draining South)?
			if (uj === 0 && sim.spoutMask[ui] && canSatisfyMask(baseMasks[u], (1 << 3) | (1 << outDir))) {
				if (outDir === 1 || canDeflectSideways(valves[u])) {
					const cost = d - 2.5;
					if (cost < bestCost) {
						bestCost = cost;
						bestSource = u;
					}
				}
			}
			if (outDir === 1 && cellGrains[u] > 0 && canSatisfyMask(baseMasks[u], 1 << 1)) {
				const cost = d - Math.min(cellGrains[u], 5) * 0.8;
				if (cost < bestCost) {
					bestCost = cost;
					bestSource = u;
				}
			}
			if (d >= 14) continue;

			// Expand upstream along gravity-plausible links (vertical drops + elbow ramp jogs).
			for (const inSide of [3, 0, 2]) {
				if (inSide === outDir) continue;
				if (outDir !== 1 && (inSide !== 3 || !canDeflectSideways(valves[u]))) continue;
				if (!canSatisfyMask(baseMasks[u], (1 << inSide) | (1 << outDir))) continue;
				const pi = ui + G.DX[inSide];
				const pj = uj + G.DY[inSide];
				if (pi < 0 || pi >= N || pj < 0 || pj >= N) continue;
				const pk = pj * N + pi;
				if (bfsDist[pk] >= 0 || sim.goalOwner[pk] >= 0) continue;
				const pOut = (inSide + 2) & 3;
				const pPorts = valves[pk].ports.length;
				if (pPorts === 0) continue;
				if (pOut !== 1 && !canDeflectSideways(valves[pk])) continue;
				// A 1-port single valve cannot pass grains from upstream; it is only valid
				// as a terminal source when it already holds matching grains and drains South.
				if (pPorts === 1 && !(pOut === 1 && cellGrains[pk] > 0)) continue;
				if (!canSatisfyMask(baseMasks[pk], 1 << pOut)) continue;
				const autoPenalty = S.canAutoRotate(sim, pk) ? 3 : 0;
				bfsDist[pk] = d + (inSide === 3 ? 1 : 2) + autoPenalty;
				bfsNext[pk] = u;
				bfsOutDir[pk] = pOut;
				bfsQueue[tail++] = pk;
			}
		}

		if (bestSource < 0) return false;
		if (bestSource < N && cellGrains[bestSource] === 0 && game.pourCooldown <= 0 && sim.count < 96) {
			let spoutWaiting = 0;
			for (let k = 0; k < sim.count; k++) {
				if (sim.y[k] < 0 && ((sim.x[k] / G.S) | 0) === bestSource) spoutWaiting++;
			}
			if (spoutWaiting < 2 && S.pour(sim, 16) > 0) {
				game.pourCooldown = 2.4;
			}
		}

		// Collect path into bfsQueue[0..len-1] so we can align bottom-up (funnel above
		// bottle first) and defer auto-rotating valves until static valves are aligned.
		let len = 0;
		let walk = bestSource;
		while (walk >= 0 && len < SLOTS) {
			bfsQueue[len++] = walk;
			if (walk === entry) break;
			walk = bfsNext[walk];
		}

		let fallbackAutoIdx = -1;
		let fallbackAutoDelta = 0;
		for (let p = len - 1; p >= 0; p--) {
			const cur = bfsQueue[p];
			const outDir = bfsOutDir[cur];
			let inSide = -1;
			if (p > 0) inSide = (bfsOutDir[bfsQueue[p - 1]] + 2) & 3;
			else if (cur < N && sim.spoutMask[cur] && cellGrains[cur] === 0) inSide = 3;
			const need = inSide >= 0 ? (1 << inSide) | (1 << outDir) : 1 << outDir;
			const curQ = G.quarterOf(sim.target[cur]);
			const wantQ = bestQuarterForMask(baseMasks[cur], curQ, need);
			if (wantQ >= 0 && wantQ !== curQ) {
				let delta = (wantQ - curQ + 4) & 3;
				if (delta === 3) delta = -1;
				else if (delta === 2) delta = 1;
				if (S.canAutoRotate(sim, cur)) {
					if (fallbackAutoIdx < 0) {
						fallbackAutoIdx = cur;
						fallbackAutoDelta = delta;
					}
					continue;
				}
				return S.turn(sim, cur, delta);
			}
		}
		if (fallbackAutoIdx >= 0) return S.turn(sim, fallbackAutoIdx, fallbackAutoDelta);
		return false;
	}

	const COL_SWEEP = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7, -8, 8, -9, 9];

	// Open mouths of one band, ordered by distance from a goal column: the nearest
	// and the farthest are the two the mouth policy cares about.
	const mouthSpan = { count: 0, nearest: -1, farthest: -1 };

	function scanMouths(sim, side, col) {
		mouthSpan.count = 0;
		mouthSpan.nearest = -1;
		mouthSpan.farthest = -1;
		for (let m = 0; m < COL_SWEEP.length; m++) {
			const c = col + COL_SWEEP[m];
			if (c < 0 || c >= N) continue;
			const idx = side * N + c;
			if (!sim.inlets.open[idx]) continue;
			if (mouthSpan.nearest < 0) mouthSpan.nearest = idx;
			mouthSpan.farthest = idx;
			mouthSpan.count++;
		}
		return mouthSpan;
	}

	// Keep one mouth of the opposing polarity open as a reference: it holds a
	// through-flow and lets the favourable band dominate the pressure.
	function botHoldAnchor(sim, col, wantHigh) {
		const side = wantHigh ? I.TOP : I.BOTTOM;
		const level = wantHigh ? I.LOW : I.HIGH;
		const span = scanMouths(sim, side, col);
		if (!span.count) return S.toggleInlet(sim, side * N + (col > N / 2 ? 0 : N - 1), false);
		return sim.inlets.level[span.farthest] !== level ? S.toggleInlet(sim, span.farthest, true) : false;
	}

	// Open the mouths that feed the quest polarity near the goal. One action.
	function botFeedGoal(sim, col, wantHigh) {
		const side = wantHigh ? I.BOTTOM : I.TOP;
		const level = wantHigh ? I.HIGH : I.LOW;
		for (let m = 0; m < COL_SWEEP.length; m++) {
			const c = col + COL_SWEEP[m];
			if (c < 0 || c >= N || Math.abs(c - col) > 3) continue;
			const idx = side * N + c;
			if (!sim.inlets.open[idx]) return S.toggleInlet(sim, idx, false);
			if (sim.inlets.level[idx] !== level) return S.toggleInlet(sim, idx, true);
		}
		return false;
	}

	// Shut the opposing mouths nearest the goal first and leave the farthest one
	// open: that is what lifts (or drops) the potential over the bottle.
	function botChokeGoal(sim, col, wantHigh) {
		const side = wantHigh ? I.TOP : I.BOTTOM;
		const span = scanMouths(sim, side, col);
		if (span.count > 1 && span.nearest >= 0) return S.toggleInlet(sim, span.nearest, false);
		return false;
	}

	function botStepPressureQuest(game, quest) {
		const sim = game.sim;
		if (sim.pressureMode === "off") S.setPressure(sim, "grid");
		let slot = 0;
		for (let s = 0; s < quest.cellCount; s++) {
			if (!quest.cellOk[s]) {
				slot = s;
				break;
			}
		}
		const goalIdx = quest.cells[slot];
		const col = goalIdx % N;
		const row = (goalIdx / N) | 0;
		const wantHigh = quest.op === ">";
		const wantBottleQ = wantHigh ? 1 : 3;
		const curBottleQ = G.quarterOf(sim.target[goalIdx]);
		if (curBottleQ !== wantBottleQ) {
			const delta = ((wantBottleQ - curBottleQ + 4) & 3) === 3 ? -1 : 1;
			return S.turn(sim, goalIdx, delta);
		}

		// 1. Hold one reference mouth of the opposing polarity.
		if (botHoldAnchor(sim, col, wantHigh)) return true;
		// 2. Feed the goal, then choke its opposite until only the far mouth is left.
		if (botFeedGoal(sim, col, wantHigh)) return true;
		if (botChokeGoal(sim, col, wantHigh)) return true;

		// 3. Align vertical shaft between goal and the favourable boundary.
		const startR = wantHigh ? row + 1 : 0;
		const endR = wantHigh ? N - 1 : row - 1;
		for (let r = startR; r <= endR; r++) {
			const idx = r * N + col;
			if (sim.goalOwner[idx] >= 0) continue;
			const mask = valveMask(sim.layout.valves[idx]);
			const need = (1 << 1) | (1 << 3);
			const curQ = G.quarterOf(sim.target[idx]);
			const wantQ = bestQuarterForMask(mask, curQ, need);
			if (wantQ >= 0 && wantQ !== curQ) {
				const delta = ((wantQ - curQ + 4) & 3) === 3 ? -1 : 1;
				return S.turn(sim, idx, delta);
			}
		}
		return false;
	}

	function stepBots(game, dt) {
		if (!game.botControl) return;
		if (game.pourCooldown > 0) game.pourCooldown -= dt;
		for (let p = 1; p < game.players.length; p++) {
			game.botCooldown[p] -= dt;
			if (game.botCooldown[p] > 0) continue;
			game.botCooldown[p] = 0.48 + game.random() * 0.42;
			const player = game.players[p];
			if (player.questId < 0) {
				const pick = botSignChoice(game, p);
				if (pick >= 0) signQuest(game, pick, p);
				continue;
			}
			const qIndex = questIndexById(game, player.questId);
			if (qIndex < 0) {
				player.questId = -1;
				continue;
			}
			const quest = game.quests[qIndex];
			if (quest.kind === "pressure") botStepPressureQuest(game, quest);
			else botStepGrainQuest(game, quest);
		}
	}

	function step(game, dt) {
		if (!game || game.mode !== "game" || !(dt > 0)) return;
		game.evalClock += dt;
		const doEval = game.evalClock >= EVAL_DT;
		if (doEval) game.evalClock = 0;

		for (let q = game.quests.length - 1; q >= 0; q--) {
			const quest = game.quests[q];
			if (quest.owner < 0) continue;
			if (quest.timeLimit > 0) {
				const beforeSec = Math.ceil(quest.remaining);
				quest.remaining -= dt;
				if (quest.remaining <= 0) {
					finishQuest(game, q, "expired");
					continue;
				}
				if (Math.ceil(quest.remaining) !== beforeSec) game.version++;
			}
			const ok = doEval ? evaluateQuest(game, quest) : quest.cellCount > 0 && quest.cellOk[0] === 1 && (quest.cellCount < 2 || quest.cellOk[1] === 1);
			if (ok) {
				quest.hold += dt;
				quest.holdRatio = quest.hold >= quest.holdNeed ? 1 : quest.hold / quest.holdNeed;
				if (quest.hold >= quest.holdNeed) {
					finishQuest(game, q, "done");
					continue;
				}
			} else if (quest.hold > 0) {
				quest.hold = 0;
				quest.holdRatio = 0;
			}
		}

		stepBots(game, dt);
	}

	return {
		LAB_AUTO,
		GAME_AUTO,
		BOARD_SIZE,
		HOLD_OPEN,
		HOLD_EXACT,
		COHERENCE_MIN,
		GOAL_CHAMBER,
		GRAIN_HUE_DEG,
		BAND_GROUPS,
		angleDiffDeg,
		create,
		setMode,
		setBotControl,
		resetMatch,
		generateQuest,
		spawnQuest,
		signQuest,
		dropQuest,
		evaluateCell,
		evaluateQuest,
		step,
		consumeDirty,
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ValveGame;
