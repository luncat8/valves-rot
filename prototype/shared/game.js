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
	const GAME_AUTO = 0.07;
	const BOARD_SIZE = 5;
	const HOLD_OPEN = 0.45;
	const HOLD_EXACT = 1.0;
	// The field moves while other rotors turn, so a pressure target has to survive
	// a longer window than a settled pile of grains.
	const HOLD_PRESSURE = 1.6;
	// A fresh quest stays on the board long enough for a person to read the board
	// and sign it before the bots reach for it.
	const BOT_GRACE = 4;
	// A bounded clock is a share of the budget the quest's own demands need.
	const TIME_BASE = 45;
	const TIME_PER_GRAIN = 3.5;
	const TIME_PER_BOTTLE = 18;
	const TIME_WINDOW = 10;
	const TIME_PRESSURE = 40;
	const TIME_TIGHT = 0.8;
	const TIME_MIN = 40;
	const TIME_MAX = 90;
	const COHERENCE_MIN = 0.42;
	const GOAL_CHAMBER = G.RV * 0.53;
	const EVAL_DT = 1 / 15;

	// ---- Vent mode ------------------------------------------------------------
	// A pressure-regulation mode on the same random valve map: setup orients
	// existing valves into source/vent routes to hollow-single collectors, while
	// `5%` keep their normal automatic turns. Players operate only their own two
	// mouths; two seats is the limit because all routes share one pressure field.
	const VENT_AUTO = 0.05;
	const VENT_MAX = 2;
	const VENT_HOLD = 4;
	// Bot seats wait briefly after a pulse and aim just inside the target band.
	const VENT_SETTLE = 0.4;
	const VENT_AIM_INSET = 0.125;
	// Keep target bands away from measured extremes when the route has headroom.
	const VENT_EDGE_MARGIN = 0.15;
	const VENT_HALF_MIN = 0.06;
	const VENT_HALF_MAX = 0.11;
	const VENT_BAND_STEP = 0.22;
	// Outside the band by this much counts once as a lost regulation.
	const VENT_ALARM = 0.18;
	const MAX_SEATS = Math.min(R.PLAYERS.length, I.MAX_PLAYERS);

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
	const scanColumns = new Uint8Array(N);

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

	// A seat is a color from the render table: id 0 is the local player's own seat
	// and starts user controlled, every other one starts bot controlled. Either can
	// be flipped at any time, so a rival can be handed to a second person.
	function makePlayer(id) {
		const p = R.PLAYERS[id];
		return {
			id,
			name: p.name,
			bot: id > 0,
			hex: p.hex,
			accent: p.accent,
			score: 0,
			completed: 0,
			failed: 0,
			questId: -1,
		};
	}

	function makePlayers(count) {
		const out = [];
		for (let k = 0; k < count; k++) out.push(makePlayer(k));
		return out;
	}

	// Pressure targets carry a thousandth so a fitted value inside a small
	// headroom still reads exactly; whole hundredths stay short.
	function pressureText(value) {
		return value.toFixed(3).replace(/0$/, "");
	}

	function formatQuestTitle(q) {
		const prefix = q.bottles > 1 ? q.bottles + "× bottles · " : "";
		if (q.kind === "pressure") {
			const dir = q.op === ">" ? "High air > " : "Low air < ";
			return prefix + dir + pressureText(q.threshold);
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
			// One chamber per pressure route.
			const bottles = 1;
			const clock = rollTimeLimit(rnd, TIME_PRESSURE + (strong ? 8 : 0), 0.55);
			// Keep the advertised target fixed; players must route and isolate air.
			const threshold = op === ">" ? (strong ? 0.78 : 0.68) : strong ? 0.22 : 0.32;
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
				timeLimit: clock.limit,
				difficulty: (strong ? 3 : 2) + (bottles > 1 ? 2 : 0) + (clock.tight ? 2 : clock.limit > 0 ? 1 : 0),
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
		const budget = TIME_BASE + TIME_PER_GRAIN * minCount + TIME_PER_BOTTLE * (bottles - 1) + (maxCount > 0 ? TIME_WINDOW : 0);
		const clock = rollTimeLimit(rnd, budget, 0.72);

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
			timeLimit: clock.limit,
			difficulty: shapeDiff + (bottles > 1 ? 2 : 0) + (clock.tight ? 2 : clock.limit > 0 ? 1 : 0),
		});
	}

	// Untimed, or a share of the budget the quest needs; the tight share is what
	// the extra difficulty point buys, so a small-count quest is never given a
	// clock it cannot finish and a large one is never given an easy ride.
	function rollTimeLimit(rnd, budget, untimedShare) {
		const roll = rnd();
		if (roll < untimedShare) return { limit: 0, tight: false };
		const tight = roll >= 0.9;
		const scaled = budget * (tight ? TIME_TIGHT : 1);
		return { limit: Math.round(Math.min(TIME_MAX, Math.max(TIME_MIN, scaled))), tight };
	}

	function finalizeQuest(id, spec) {
		const tier = spec.difficulty <= 1 ? "easy" : spec.difficulty <= 3 ? "med" : "hard";
		const points = tier === "easy" ? 10 : tier === "med" ? 25 : 50;
		const holdNeed = spec.kind === "pressure" ? HOLD_PRESSURE : spec.maxCount === 0 ? HOLD_OPEN : HOLD_EXACT;
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
			openFor: 0,
			owner: -1,
			cellCount: 0,
			cells: new Int32Array(2),
			cellValues: new Float64Array(2),
			cellTotals: new Int16Array(2),
			cellOk: new Uint8Array(2),
			feed: new Int8Array(2),
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

	// `aged` marks the board a match starts on as already claimable; every other quest
	// opens young, so that the human gets the first look at it before the bots do.
	function spawnQuest(game, tierHint, aged) {
		const hint = tierHint || neededTier(game.quests);
		const q = generateQuest(game, hint);
		if (aged) q.openFor = BOT_GRACE;
		game.quests.push(q);
		game.version++;
		return q;
	}

	function create(sim, options) {
		const o = options || {};
		const seed = (sim.layout.seed | 0) ^ 0x51f2a9;
		const seats = o.players === undefined ? 4 : Math.max(1, Math.min(MAX_SEATS, o.players | 0));
		const mode = o.mode === "game" || o.mode === "vent" ? o.mode : "lab";
		const game = {
			sim,
			mode,
			botControl: o.botControl !== false,
			random: G.rng(seed),
			// A separate stream, so dealing mouths does not reshuffle the quests.
			mouthRandom: G.rng(seed ^ 0x2f9c1b7),
			players: makePlayers(mode === "vent" ? Math.min(seats, VENT_MAX) : seats),
			quests: [],
			nextQuestId: 0,
			version: 1,
			// The seat list is interactive, so it only rebuilds when a seat changes.
			rosterVersion: 1,
			evalClock: 0,
			pourCooldown: 0,
			botCooldown: new Float64Array(MAX_SEATS),
			vent: makeVent(),
			dirtyRotors: new Uint8Array(SLOTS),
			dirtyCases: false,
			hasDirtyRotors: false,
			lastEvent: "Sign a goal to spawn your colored bottle on the field.",
		};
		staggerBots(game);
		seedBoard(game);
		if (game.mode === "game") dealMouths(game);
		else if (game.mode === "vent") enterVent(game);
		S.setAutoRotate(sim, autoFor(game.mode));
		return game;
	}

	// Bots act out of phase so two rigs do not reach for the same goal together.
	function staggerBots(game) {
		for (let p = 0; p < game.botCooldown.length; p++) game.botCooldown[p] = p === 0 ? 0 : 0.3 + p * 0.8;
	}

	function seedBoard(game) {
		game.quests.length = 0;
		const initial = ["easy", "easy", "med", "med", "hard"];
		for (let k = 0; k < BOARD_SIZE; k++) spawnQuest(game, initial[k], true);
	}

	// ---- Owned mouths ---------------------------------------------------------
	// Game mode deals every competitor two in (source) and two out (vent) mouths
	// at independent random columns and leaves the rest of the bands empty. A
	// player presses only their own four, so pressure play is a handful of
	// deliberate taps instead of sweeping two ten-mouth bands.
	function dealMouths(game) {
		I.deal(game.sim.inlets, game.players.length, game.mouthRandom);
		S.setInletOwnership(game.sim);
	}

	function restoreMouths(game) {
		I.reset(game.sim.inlets);
		S.setInletOwnership(game.sim);
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

	// How much of the field keeps turning by itself is a property of the mode, so
	// the slider follows the mode instead of the other way round.
	const MODE_AUTO = { lab: LAB_AUTO, game: GAME_AUTO, vent: VENT_AUTO };

	function autoFor(mode) {
		return MODE_AUTO[mode];
	}

	function setMode(game, mode) {
		if (mode !== "lab" && mode !== "game" && mode !== "vent") return false;
		if (game.mode === mode) return true;
		const from = game.mode;
		if (from === "vent") teardownVent(game);
		if (from === "game") clearActiveGoals(game, false);
		game.mode = mode;
		if (mode === "vent") {
			trimPlayers(game, VENT_MAX);
			enterVent(game);
			game.lastEvent = "Vent mode: hold your bottle's pressure inside the band with your two mouths.";
		} else if (mode === "game") {
			dealMouths(game);
			if (game.quests.length < BOARD_SIZE) seedBoard(game);
			game.lastEvent = "Sign a goal to spawn your colored bottle on the field.";
		} else {
			restoreMouths(game);
		}
		S.setAutoRotate(game.sim, autoFor(mode));
		game.version++;
		game.rosterVersion++;
		return true;
	}

	// Vent mode keeps its rig for as long as it runs; entering it drains the grains
	// and clears both bands so only the rigs' own mouths are left to press.
	function enterVent(game) {
		const sim = game.sim;
		if (sim.pressureMode !== "grid") S.setPressure(sim, "grid");
		const built = buildVent(game);
		if (built > 0) return built;
		game.lastEvent = "No complete random-valve route fit this seed.";
		return 0;
	}

	// A master pause over every bot-controlled seat; each seat's own checkbox says
	// whether it is a bot or a person at all.
	function setBotControl(game, enabled) {
		game.botControl = !!enabled;
		game.version++;
		game.rosterVersion++;
	}

	function setPlayerBot(game, playerId, bot) {
		const player = game.players[playerId];
		if (!player || player.bot === !!bot) return false;
		player.bot = !!bot;
		game.botCooldown[playerId] = 0.4;
		game.lastEvent = player.name + " is now " + (player.bot ? "bot controlled." : "user controlled.");
		game.version++;
		game.rosterVersion++;
		return true;
	}

	// Seats may come and go mid-match. Both re-deal the bands, because a mouth set
	// is only balanced for the seat list it was dealt to.
	function addPlayer(game) {
		const limit = game.mode === "vent" ? VENT_MAX : MAX_SEATS;
		if (game.players.length >= limit) {
			notice(game, game.mode === "vent" ? "Vent mode plays with 1 or 2 seats — more would share one average." : "The bands only deal " + limit + " players.");
			return false;
		}
		const player = makePlayer(game.players.length);
		game.players.push(player);
		reseats(game, player.name + " joined — mouths re-dealt.");
		return true;
	}

	function removePlayer(game, playerId) {
		if (playerId < 0 || playerId >= game.players.length) return false;
		if (playerId === 0) {
			notice(game, "Your own seat stays; remove a rival instead.");
			return false;
		}
		const name = game.players[playerId].name;
		dropQuest(game, playerId);
		game.players.splice(playerId, 1);
		renumberSeats(game, playerId);
		reseats(game, name + " left — mouths re-dealt.");
		return true;
	}

	// Dropping a seat renumbers the ones behind it, so colors, tints and claimed
	// goals all follow the seat list instead of pointing at a color nobody holds.
	function renumberSeats(game, removed) {
		const sim = game.sim;
		for (let k = 0; k < SLOTS; k++) {
			const tint = sim.caseTint[k];
			if (tint === removed) sim.caseTint[k] = -1;
			else if (tint > removed) sim.caseTint[k] = tint - 1;
			const owner = sim.goalOwner[k];
			if (owner === removed) sim.goalOwner[k] = -1;
			else if (owner > removed) sim.goalOwner[k] = owner - 1;
		}
		for (let q = 0; q < game.quests.length; q++) {
			const owner = game.quests[q].owner;
			if (owner === removed) game.quests[q].owner = -1;
			else if (owner > removed) game.quests[q].owner = owner - 1;
		}
		for (let p = 0; p < game.players.length; p++) game.players[p].id = p;
		game.dirtyCases = true;
	}

	function trimPlayers(game, limit) {
		while (game.players.length > limit) {
			const id = game.players.length - 1;
			dropQuest(game, id);
			game.players.splice(id, 1);
			renumberSeats(game, id);
		}
	}

	function reseats(game, text) {
		if (game.mode === "vent") {
			teardownVent(game);
			trimPlayers(game, VENT_MAX);
			enterVent(game);
		} else if (game.mode === "game") dealMouths(game);
		staggerBots(game);
		game.lastEvent = text;
		game.version++;
		game.rosterVersion++;
	}

	// A short answer in the game status line, e.g. when a press is not yours.
	function notice(game, text) {
		if (game.mode === "lab" || game.lastEvent === text) return;
		game.lastEvent = text;
		game.version++;
	}

	// A signed quest's pour priority is only borrowed for the length of the quest.
	function releaseFeeds(game, quest) {
		for (let s = 0; s < quest.feed.length; s++) {
			const column = quest.feed[s] - 1;
			if (column < 0) continue;
			quest.feed[s] = 0;
			S.setGoalFeed(game.sim, column, false);
		}
	}

	// Gives up the field a signed quest held: the bottles, their locks and tints,
	// and the pour priority. The quest object keeps its own outcome for the HUD.
	function unclaim(game, quest, sealWithBlank) {
		const sim = game.sim;
		const blank = G.typeById("solid-blank");
		releaseFeeds(game, quest);
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

	// Clears signed goals cleanly when resetting or returning to Lab mode. The card
	// stays on the board, so it also has to forget that anyone ever held it.
	function clearActiveGoals(game, sealWithBlank) {
		for (let q = 0; q < game.quests.length; q++) {
			const quest = game.quests[q];
			if (quest.owner < 0) continue;
			unclaim(game, quest, sealWithBlank);
			quest.owner = -1;
			quest.hold = 0;
			quest.holdRatio = 0;
			quest.remaining = quest.timeLimit;
			quest.progressText = "Unsigned";
		}
		for (let p = 0; p < game.players.length; p++) game.players[p].questId = -1;
	}

	function resetMatch(game, sim) {
		const fresh = !!sim && sim !== game.sim;
		if (sim) game.sim = sim;
		if (game.mode === "vent") {
			// A fresh layout never carried the previous routes, so there is nothing
			// to restore onto it.
			if (fresh) forgetVent(game);
			else teardownVent(game);
		}
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
		staggerBots(game);
		seedBoard(game);
		game.mouthRandom = G.rng((game.sim.layout.seed | 0) ^ 0x2f9c1b7);
		if (game.mode === "vent") {
			trimPlayers(game, VENT_MAX);
			enterVent(game);
			game.lastEvent = "New random-valve routes built — hold the bands with your own mouths.";
		} else {
			if (game.mode === "game") dealMouths(game);
			else restoreMouths(game);
			game.lastEvent = "New match started — sign a goal to spawn your bottle.";
		}
		S.setAutoRotate(game.sim, autoFor(game.mode));
		game.version++;
		game.rosterVersion++;
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

	// Mean local pressure of the air cells in the bottle's chamber.
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

	function columnHasGoal(sim, col, chosen) {
		for (let r = 0; r < N; r++) if (sim.goalOwner[r * N + col] >= 0) return true;
		for (let k = 0; k < chosen.length; k++) if (chosen[k] % N === col) return true;
		return false;
	}

	// One candidate cell, with only the filters a pass needs. Kept separate from
	// the scan so a pass can be retried without re-ranging over the board.
	function goalCellFits(sim, quest, idx, pass, chosen) {
		if (sim.goalOwner[idx] >= 0 || chosen.indexOf(idx) >= 0) return false;
		// Never spawn directly above or below an active goal bottle (would cork its ↑ N port!).
		const above = idx - N;
		const below = idx + N;
		if (sim.goalOwner[above] >= 0) return false;
		if (below < SLOTS && sim.goalOwner[below] >= 0) return false;
		if (chosen.indexOf(above) >= 0 || chosen.indexOf(below) >= 0) return false;
		const i = idx % N;
		const j = (idx / N) | 0;
		if (pass < 2 && columnHasGoal(sim, i, chosen)) return false;
		if (chosen.length && Math.abs((chosen[0] % N) - i) < 2 && pass < 2) return false;
		if (pass === 0 && quest.kind === "grains" && !reachableFromTop(sim, above)) return false;
		if (pass < 2 && sim.layout.valves[above].ports.length < 2) return false;
		if (quest.kind === "pressure" && pass < 2 && sim.pressure && sim.pressure.kind === "grid") {
			const p0 = sim.pressure.p[GAS.index((i + 0.5) * G.S, (j + 0.5) * G.S)];
			const already = quest.op === ">" ? p0 > quest.threshold - 0.05 : p0 < quest.threshold + 0.05;
			if (already) return false;
		}
		return true;
	}

	// Search possible quarter-turn routes, not current pressure or mouth ownership.
	// A rival's open reservoir is usable; only our own sealed ones can be opened.
	const airParent = new Int16Array(SLOTS * 4);
	const airQueue = new Int16Array(SLOTS * 4);
	const airQuarter = new Int8Array(SLOTS * 4);
	function findAirRoute(sim, goal, wantHigh, playerId) {
		airParent.fill(-2);
		let head = 0;
		let tail = 0;
		for (let side = 0; side < 4; side++) {
			const state = goal * 4 + side;
			airParent[state] = -1;
			airQueue[tail++] = state;
		}
		while (head < tail) {
			const state = airQueue[head++];
			const cell = state >> 2;
			const incoming = state & 3;
			const v = sim.layout.valves[cell];
			for (let side = 0; side < 4; side++) {
				if (cell !== goal && side === incoming) continue;
				const need = (1 << incoming) | (1 << side);
				const q = cell === goal ? 0 : bestQuarterForMask(valveMask(v), G.quarterOf(sim.target[cell]), need);
				if (q < 0 || (cell !== goal && sim.goalOwner[cell] >= 0)) continue;
				const x = cell % N + G.DX[side];
				const y = ((cell / N) | 0) + G.DY[side];
				if (x < 0 || x >= N) continue;
				if (y < 0 || y >= N) {
					const inlet = (y < 0 ? I.TOP : I.BOTTOM) * N + x;
					const mouths = sim.inlets;
					if (!mouths.present[inlet] || (mouths.level[inlet] === I.HIGH) !== wantHigh) continue;
					if (!mouths.open[inlet] && mouths.owner[inlet] !== playerId) continue;
					airQuarter[state] = q;
					return state;
				}
				const nextCell = y * N + x;
				let ancestor = state;
				while (ancestor >= 0 && (ancestor >> 2) !== nextCell) ancestor = airParent[ancestor];
				if (ancestor >= 0) continue;
				const next = nextCell * 4 + ((side + 2) & 3);
				if (airParent[next] !== -2) continue;
				airParent[next] = state;
				airQueue[tail++] = next;
			}
		}
		return -1;
	}

	function pickGoalCells(game, quest, playerId) {
		const sim = game.sim;
		const rnd = game.random;
		const chosen = [];
		const rowMin = 3;
		const rowMax = quest.kind === "pressure" ? 6 : 8;
		for (let slot = 0; slot < quest.bottles; slot++) {
			let picked = -1;
			// Pass 0: distinct column + gravity path; Pass 1: distinct column + reachable;
			// Pass 2: any cell that does not directly cork an existing bottle.
			for (let pass = 0; pass < 3 && picked < 0; pass++) {
				const startCol = (rnd() * N) | 0;
				const startRow = rowMin + ((rnd() * (rowMax - rowMin + 1)) | 0);
				const columns = N;
				for (let c = 0; c < N; c++) scanColumns[c] = (startCol + c) % N;
				for (let dr = 0; dr <= rowMax - rowMin && picked < 0; dr++) {
					const j = rowMin + ((startRow - rowMin + dr) % (rowMax - rowMin + 1));
					for (let dc = 0; dc < columns; dc++) {
						const idx = j * N + scanColumns[dc];
						if (!goalCellFits(sim, quest, idx, pass, chosen)) continue;
						if (quest.kind === "pressure" && findAirRoute(sim, idx, quest.op === ">", playerId) < 0) continue;
						picked = idx;
						break;
					}
				}
			}
			if (picked < 0) break;
			chosen.push(picked);
		}
		return chosen;
	}

	function questIndexById(game, questId) {
		for (let k = 0; k < game.quests.length; k++) if (game.quests[k].id === questId) return k;
		return -1;
	}

	function placeBottles(game, quest, cells, playerId) {
		const sim = game.sim;
		const bottleType = G.typeById(quest.kind === "pressure" ? "hollow-cross" : "hollow-single");
		for (let s = 0; s < cells.length; s++) {
			const idx = cells[s];
			quest.cells[s] = idx;
			S.installValve(sim, idx, bottleType, 3, GOAL_CHAMBER, true);
			sim.autoLocked[idx] = 1;
			sim.goalOwner[idx] = playerId;
			S.setCaseTint(sim, idx, playerId);
			markRotorDirty(game, idx);
			const above = idx - N;
			if (quest.kind === "grains" && sim.goalOwner[above] < 0 && sim.layout.valves[above].ports.length < 2) {
				S.installValve(sim, above, G.typeById("solid-tee"), 0, undefined, true);
				markRotorDirty(game, above);
			}
			if (quest.kind === "grains") {
				// Pour above the route the search found, so `Pour` feeds this bottle
				// first for as long as the quest is signed. One claim per bottle, and
				// `releaseFeeds` hands it back, so an already-promoted column is safe.
				const topCol = findGravityTopSpout(sim, idx - N);
				if (topCol >= 0) {
					S.setGoalFeed(sim, topCol, true);
					quest.feed[s] = topCol + 1;
				}
			}
		}
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
		if (quest.kind === "pressure") {
			if (sim.pressureMode !== "grid") S.setPressure(sim, "grid");
			// Keep the network ready for the new chamber.
			GAS.refresh(sim, true);
		}

		let cells = pickGoalCells(game, quest, playerId);
		if (!cells.length) return false;

		quest.cellCount = cells.length;
		quest.hold = 0;
		quest.holdRatio = 0;
		quest.feed.fill(0);
		quest.remaining = quest.timeLimit;
		quest.cellValues.fill(-1);
		quest.cellTotals.fill(-1);
		quest.cellOk.fill(0);

		placeBottles(game, quest, cells, playerId);
		S.rebuildPressure(sim);

		quest.owner = playerId;
		quest.cellCount = cells.length;
		player.questId = quest.id;

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
					quest.cellTags[s] = (bucket / 100).toFixed(2) + quest.op + pressureText(quest.threshold);
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
		// Quest end: every goal bottle becomes a 'solid blank' plug.
		unclaim(game, quest, true);
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
		// The replacement is deliberately young: a fresh slot is the human's window.
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

	// ---- Vent mode ------------------------------------------------------------

	function makeSeat() {
		return {
			player: -1,
			column: -1,
			row: -1,
			bottle: -1,
			inMouth: -1,
			outMouth: -1,
			spanLo: 0,
			spanHi: 1,
			lo: 0,
			hi: 0,
			half: 0,
			points: 0,
			pressure: 0.5,
			ok: false,
			alarm: false,
			hold: 0,
			holdRatio: 0,
			rounds: 0,
			drive: 0,
			wait: 0,
			tag: "",
			shown: -1,
		};
	}

	function makeVent() {
		const seats = [];
		for (let s = 0; s < VENT_MAX; s++) seats.push(makeSeat());
		return {
			count: 0,
			seats,
			used: new Uint8Array(SLOTS),
			savedCount: new Uint8Array(VENT_MAX),
			savedCell: new Int16Array(VENT_MAX * SLOTS).fill(-1),
			savedType: new Int8Array(VENT_MAX * SLOTS),
			savedQuarter: new Int8Array(VENT_MAX * SLOTS),
			savedChamber: new Float64Array(VENT_MAX * SLOTS),
			savedTint: new Int8Array(VENT_MAX * SLOTS),
			savedLock: new Uint8Array(VENT_MAX * SLOTS),
			savedOwner: new Int8Array(VENT_MAX * SLOTS),
		};
	}

	const routeBlocked = new Uint8Array(SLOTS);
	const routePrev = new Int16Array(SLOTS * 4);
	const routeQueue = new Int16Array(SLOTS * 4);
	const routeCells = new Int16Array(SLOTS);
	const routeQuarters = new Int8Array(SLOTS);
	const routeMouthBlocked = new Uint8Array(N * 2);
	const routePlan = new Int16Array(SLOTS * 3);
	const routePlanQuarters = new Int8Array(SLOTS * 3);
	const routePlanLength = { value: 0 };
	const savedBase = slot => slot * SLOTS;

	function clamp01(v) {
		return v < 0 ? 0 : v > 1 ? 1 : v;
	}

	function typeIndex(v) {
		const type = G.typeOf(v);
		return type ? G.TYPES.indexOf(type) : 0;
	}

	function saveRouteCell(game, slot, index) {
		const vent = game.vent;
		const base = savedBase(slot);
		for (let k = 0; k < vent.savedCount[slot]; k++) if (vent.savedCell[base + k] === index) return;
		const pos = base + vent.savedCount[slot]++;
		const v = game.sim.layout.valves[index];
		vent.savedCell[pos] = index;
		vent.savedType[pos] = typeIndex(v);
		vent.savedQuarter[pos] = G.orientationOf(v);
		vent.savedChamber[pos] = v.chamberR;
		vent.savedTint[pos] = game.sim.caseTint[index];
		vent.savedLock[pos] = game.sim.autoLocked[index];
		vent.savedOwner[pos] = game.sim.goalOwner[index];
	}

	function restoreSeatRoute(game, slot) {
		const vent = game.vent;
		const sim = game.sim;
		const base = savedBase(slot);
		for (let k = vent.savedCount[slot] - 1; k >= 0; k--) {
			const pos = base + k;
			const index = vent.savedCell[pos];
			if (index < 0) continue;
			S.installValve(sim, index, G.TYPES[vent.savedType[pos]], vent.savedQuarter[pos], vent.savedChamber[pos], true);
			S.setCaseTint(sim, index, vent.savedTint[pos]);
			sim.autoLocked[index] = vent.savedLock[pos];
			sim.goalOwner[index] = vent.savedOwner[pos];
			markRotorDirty(game, index);
			vent.used[index] = 0;
			vent.savedCell[pos] = -1;
		}
		vent.savedCount[slot] = 0;
		game.dirtyCases = true;
	}

	function saveRoute(game, slot, target, targetQuarter) {
		const sim = game.sim;
		const seat = game.vent.seats[slot];
		const targetType = G.typeById("hollow-single");
		for (let k = 0; k < routePlanLength.value; k++) {
			const index = routePlan[k];
			const v = sim.layout.valves[index];
			saveRouteCell(game, slot, index);
			S.installValve(sim, index, G.typeOf(v), routePlanQuarters[k], v.chamberR, true);
			game.vent.used[index] = 1;
			markRotorDirty(game, index);
		}
		saveRouteCell(game, slot, target);
		S.installValve(sim, target, targetType, targetQuarter, GOAL_CHAMBER, true);
		sim.goalOwner[target] = slot;
		S.setCaseTint(sim, target, slot);
		game.vent.used[target] = 1;
		markRotorDirty(game, target);
		seat.player = slot;
		seat.row = (target / N) | 0;
		seat.column = target % N;
		seat.bottle = target;
		game.dirtyCases = true;
	}

	function clearSeat(seat) {
		seat.player = -1;
		seat.column = -1;
		seat.row = -1;
		seat.bottle = -1;
		seat.inMouth = -1;
		seat.outMouth = -1;
		seat.lo = 0;
		seat.hi = 1;
		seat.hold = 0;
		seat.holdRatio = 0;
		seat.ok = false;
		seat.alarm = false;
		seat.pressure = 0.5;
		seat.rounds = 0;
		seat.drive = 0;
		seat.wait = 0;
		seat.tag = "";
		seat.shown = -1;
	}

	function measureChamber(sim, index) {
		const gas = sim.pressure;
		GAS.steady(gas, gas.pTarget);
		return sampleChamber(sim, index, gas.pTarget);
	}

	function ventMouths(game, seat, source, vent) {
		const inlets = game.sim.inlets;
		inlets.open[seat.inMouth] = source ? 1 : 0;
		inlets.open[seat.outMouth] = vent ? 1 : 0;
		inlets.version++;
		GAS.repin(game.sim);
	}

	function measureVentSpan(game, seat) {
		const sim = game.sim;
		GAS.refresh(sim);
		ventMouths(game, seat, true, false);
		const charge = measureChamber(sim, seat.bottle);
		ventMouths(game, seat, false, true);
		const drain = measureChamber(sim, seat.bottle);
		ventMouths(game, seat, true, true);
		seat.spanLo = Math.min(charge, drain);
		seat.spanHi = Math.max(charge, drain);
		return seat.spanHi - seat.spanLo;
	}

	function fitVentBand(game, seat, measure) {
		const rnd = game.random;
		const span = measure ? measureVentSpan(game, seat) : seat.spanHi - seat.spanLo;
		let half = VENT_HALF_MIN + rnd() * (VENT_HALF_MAX - VENT_HALF_MIN);
		if (half * 2 > span) half = Math.max(0.005, span * 0.24);
		const margin = Math.min(VENT_EDGE_MARGIN, Math.max(0, (span - half * 2) / 2));
		const centerLo = seat.spanLo + margin + half;
		const centerHi = seat.spanHi - margin - half;
		let center = centerLo + rnd() * Math.max(0, centerHi - centerLo);
		if (seat.rounds > 0) {
			const from = (seat.lo + seat.hi) / 2;
			const stepped = from + (rnd() * 2 - 1) * VENT_BAND_STEP;
			center = stepped < centerLo ? centerLo : stepped > centerHi ? centerHi : stepped;
		}
		center = clamp01(center);
		seat.half = half;
		seat.lo = clamp01(center - half);
		seat.hi = clamp01(center + half);
		seat.points = half >= 0.1 ? 10 : half >= 0.08 ? 25 : 50;
		seat.drive = 0;
		seat.wait = 0;
		seat.hold = 0;
		seat.holdRatio = 0;
		seat.shown = -1;
		seat.tag = seat.lo.toFixed(2) + "–" + seat.hi.toFixed(2);
	}

	function quarterForPair(type, first, second) {
		const need = (1 << first) | (1 << second);
		for (let q = 0; q < 4; q++) if ((rotMask(type.mask, q) & need) === need) return q;
		return -1;
	}

	function quarterForPairAt(game, index, first, second) {
		const type = G.typeOf(game.sim.layout.valves[index]);
		if (!type) return -1;
		return quarterForPair(type, first, second);
	}

	function supportsTripleAt(game, index, a, b, c) {
		const type = G.typeOf(game.sim.layout.valves[index]);
		if (!type) return -1;
		const need = (1 << a) | (1 << b) | (1 << c);
		for (let q = 0; q < 4; q++) if ((rotMask(type.mask, q) & need) === need) return q;
		return -1;
	}

	function neighbor(cell, direction) {
		const col = cell % N + G.DX[direction];
		const row = ((cell / N) | 0) + G.DY[direction];
		return col < 0 || col >= N || row < 0 || row >= N ? -1 : row * N + col;
	}

	function findRoute(game, start, entry, side, blocked, rndOffset) {
		const sim = game.sim;
		if (start < 0 || blocked[start]) return 0;
		const startType = G.typeOf(sim.layout.valves[start]);
		if (!startType) return 0;
		routePrev.fill(-2);
		let head = 0;
		let tail = 0;
		const startState = start * 4 + entry;
		routePrev[startState] = -1;
		routeQueue[tail++] = startState;
		let found = -1;
		const mouthDir = side === I.BOTTOM ? 1 : 3;
		while (head < tail) {
			const state = routeQueue[head++];
			const cell = state >> 2;
			const incoming = state & 3;
			const type = G.typeOf(sim.layout.valves[cell]);
			const row = (cell / N) | 0;
			if ((side === I.BOTTOM ? row === N - 1 : row === 0) && !routeMouthBlocked[side * N + cell % N] && quarterForPairAt(game, cell, incoming, mouthDir) >= 0) {
				found = state;
				break;
			}
			for (let k = 0; k < 4; k++) {
				const out = (k + rndOffset) & 3;
				if (out === incoming || quarterForPairAt(game, cell, incoming, out) < 0) continue;
				const next = neighbor(cell, out);
				if (next < 0 || blocked[next]) continue;
				const nextType = G.typeOf(sim.layout.valves[next]);
				if (!nextType) continue;
				const nextState = next * 4 + ((out + 2) & 3);
				if (routePrev[nextState] !== -2) continue;
				routePrev[nextState] = state;
				routeQueue[tail++] = nextState;
			}
		}
		if (found < 0) return 0;
		let length = 0;
		for (let state = found; state >= 0; state = routePrev[state]) routeCells[length++] = state >> 2;
		for (let a = 0, b = length - 1; a < b; a++, b--) {
			const t = routeCells[a];
			routeCells[a] = routeCells[b];
			routeCells[b] = t;
		}
		for (let k = 0; k < length; k++) {
			const cell = routeCells[k];
			const prevCell = k === 0 ? startParentCell : routeCells[k - 1];
			const nextCell = k === length - 1 ? -1 : routeCells[k + 1];
			const inDir = directionBetween(cell, prevCell);
			const outDir = k === length - 1 ? mouthDir : directionBetween(cell, nextCell);
			routeQuarters[k] = quarterForPairAt(game, cell, inDir, outDir);
		}
		return length;
	}

	function directionBetween(cell, other) {
		const dx = other % N - cell % N;
		const dy = ((other / N) | 0) - ((cell / N) | 0);
		return dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3;
	}

	let startParentCell = -1;
	const pathA = new Int16Array(SLOTS);
	const pathAQ = new Int8Array(SLOTS);
	const pathB = new Int16Array(SLOTS);
	const pathBQ = new Int8Array(SLOTS);

	function copyPath(path, quarters, length, out, outQuarters, offset) {
		for (let k = 0; k < length; k++) {
			out[offset + k] = path[k];
			outQuarters[offset + k] = quarters[k];
		}
		return offset + length;
	}

	function planSeatRoute(game, slot) {
		const sim = game.sim;
		const start = (game.mouthRandom() * SLOTS) | 0;
		const offset = (game.mouthRandom() * 4) | 0;
		routeMouthBlocked.fill(0);
		for (let s = 0; s < game.vent.count; s++) {
			if (s === slot) continue;
			const other = game.vent.seats[s];
			if (other.inMouth >= 0) routeMouthBlocked[other.inMouth] = 1;
			if (other.outMouth >= 0) routeMouthBlocked[other.outMouth] = 1;
		}
		for (let ti = 0; ti < SLOTS; ti++) {
			const raw = (start + ti) % SLOTS;
			const targetCol = raw % N;
			const targetRow = (raw / N) | 0;
			if (targetCol < 1 || targetCol > N - 2 || targetRow < 1 || targetRow > N - 2) continue;
			if (sim.goalOwner[raw] >= 0) continue;
			for (let oq = 0; oq < 4; oq++) {
				const targetQuarter = (oq + offset) & 3;
				const branch = neighbor(raw, targetQuarter);
				if (branch < 0 || sim.goalOwner[branch] >= 0) continue;
				const branchType = G.typeOf(sim.layout.valves[branch]);
				if (!branchType || branchType.ports.length < 3) continue;
				const targetSide = (targetQuarter + 2) & 3;
				for (let a = 0; a < 4; a++) {
					const sourceDir = (a + offset) & 3;
					if (sourceDir === targetSide) continue;
					for (let b = 0; b < 4; b++) {
						const ventDir = (b + offset) & 3;
						if (ventDir === targetSide || ventDir === sourceDir) continue;
						const branchQuarter = supportsTripleAt(game, branch, targetSide, sourceDir, ventDir);
						if (branchQuarter < 0) continue;
						const sourceStart = neighbor(branch, sourceDir);
						const ventStart = neighbor(branch, ventDir);
						if (sourceStart < 0 || ventStart < 0) continue;
						for (let sourceSide = I.TOP; sourceSide <= I.BOTTOM; sourceSide++) {
							for (let ventSide = I.TOP; ventSide <= I.BOTTOM; ventSide++) {
								routeBlocked.fill(0);
								routeBlocked[raw] = 1;
								routeBlocked[branch] = 1;
								startParentCell = branch;
								const lenA = findRoute(game, sourceStart, (sourceDir + 2) & 3, sourceSide, routeBlocked, offset);
								if (!lenA) continue;
								for (let k = 0; k < lenA; k++) {
									pathA[k] = routeCells[k];
									pathAQ[k] = routeQuarters[k];
									routeBlocked[pathA[k]] = 1;
								}
								const lenB = findRoute(game, ventStart, (ventDir + 2) & 3, ventSide, routeBlocked, offset + 1);
								if (!lenB) continue;
								for (let k = 0; k < lenB; k++) {
									pathB[k] = routeCells[k];
									pathBQ[k] = routeQuarters[k];
								}
								let count = 0;
								routePlan[count] = branch;
								routePlanQuarters[count++] = branchQuarter;
								count = copyPath(pathA, pathAQ, lenA, routePlan, routePlanQuarters, count);
								count = copyPath(pathB, pathBQ, lenB, routePlan, routePlanQuarters, count);
								routePlanLength.value = count;
								const sourceEnd = pathA[lenA - 1];
								const ventEnd = pathB[lenB - 1];
								const sourceMouth = sourceSide * N + sourceEnd % N;
								const ventMouth = ventSide * N + ventEnd % N;
								let mouthTaken = false;
								for (let s = 0; s < game.vent.count; s++) {
									if (s === slot) continue;
									const other = game.vent.seats[s];
									if (sourceMouth === other.inMouth || sourceMouth === other.outMouth || ventMouth === other.inMouth || ventMouth === other.outMouth) mouthTaken = true;
								}
								if (mouthTaken) continue;
								return { target: raw, targetQuarter, sourceMouth, ventMouth };
							}
						}
					}
				}
			}
		}
		return null;
	}

	function buildVentSeat(game, slot) {
		const seat = game.vent.seats[slot];
		const plan = planSeatRoute(game, slot);
		if (!plan) return false;
		saveRoute(game, slot, plan.target, plan.targetQuarter);
		seat.inMouth = plan.sourceMouth;
		seat.outMouth = plan.ventMouth;
		I.claimPair(game.sim.inlets, seat.inMouth, seat.outMouth, slot);
		S.setInletOwnership(game.sim);
		if (measureVentSpan(game, seat) <= 0.02) return false;
		for (let s = 0; s < slot; s++) {
			const other = game.vent.seats[s];
			if (other.bottle >= 0 && measureVentSpan(game, other) <= 0.02) return false;
		}
		return true;
	}

	function buildVent(game) {
		const sim = game.sim;
		const vent = game.vent;
		if (sim.pressureMode !== "grid") S.setPressure(sim, "grid");
		S.drain(sim);
		I.clearAll(sim.inlets);
		vent.used.fill(0);
		vent.savedCount.fill(0);
		vent.count = Math.min(game.players.length, VENT_MAX);
		let built = 0;
		const attempts = vent.count > 1 ? 12 : 1;
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (attempt > 0) {
				for (let s = vent.count - 1; s >= 0; s--) {
					const seat = vent.seats[s];
					I.releasePair(sim.inlets, seat.inMouth, seat.outMouth);
					restoreSeatRoute(game, s);
					clearSeat(seat);
				}
				I.clearAll(sim.inlets);
			}
			vent.used.fill(0);
			built = 0;
			for (let s = 0; s < vent.count; s++) {
				clearSeat(vent.seats[s]);
				vent.seats[s].player = s;
				if (!buildVentSeat(game, s)) {
					I.releasePair(sim.inlets, vent.seats[s].inMouth, vent.seats[s].outMouth);
					restoreSeatRoute(game, s);
					clearSeat(vent.seats[s]);
					break;
				}
				built++;
			}
			if (built === vent.count) break;
		}
		for (let s = 0; s < vent.count; s++) {
			if (vent.seats[s].bottle < 0) continue;
			fitVentBand(game, vent.seats[s], true);
		}
		GAS.refresh(sim, true);
		return built;
	}

	function teardownVent(game) {
		const vent = game.vent;
		for (let s = vent.count - 1; s >= 0; s--) {
			I.releasePair(game.sim.inlets, vent.seats[s].inMouth, vent.seats[s].outMouth);
			restoreSeatRoute(game, s);
			clearSeat(vent.seats[s]);
		}
		vent.count = 0;
		S.rebuildPressure(game.sim);
	}

	function forgetVent(game) {
		const vent = game.vent;
		for (let s = 0; s < VENT_MAX; s++) clearSeat(vent.seats[s]);
		vent.used.fill(0);
		vent.savedCount.fill(0);
		vent.savedCell.fill(-1);
		vent.count = 0;
	}

	// One seat's whole policy is two switches, pulsed like a hand would: an edge of
	// the band starts the pulse, the center ends it, and inside the band both
	// mouths stay sealed. Sealed is not the same as still — the pocket slides
	// toward the average of its whole column for a while — so a finished pulse is
	// waited out before the seat looks at the band again. Correcting during that
	// slide is what turns a seat into a chattering one.
	function stepVentBot(game, seat, dt) {
		const before = seat.drive;
		const p = seat.pressure;
		const width = seat.hi - seat.lo;
		const aim = seat.drive > 0 ? seat.lo + width * VENT_AIM_INSET : seat.hi - width * VENT_AIM_INSET;
		if (seat.drive > 0 && p >= aim) {
			seat.drive = 0;
			seat.wait = VENT_SETTLE;
		} else if (seat.drive < 0 && p <= aim) {
			seat.drive = 0;
			seat.wait = VENT_SETTLE;
		}
		if (seat.drive === 0) {
			if (seat.wait > 0) seat.wait -= dt;
			else if (p < seat.lo) seat.drive = 1;
			else if (p > seat.hi) seat.drive = -1;
		}
		if (seat.drive === before) return;
		applyVentDrive(game, seat);
	}

	function applyVentDrive(game, seat) {
		const sim = game.sim;
		const inlets = sim.inlets;
		const wantIn = seat.drive > 0 ? 1 : 0;
		const wantOut = seat.drive < 0 ? 1 : 0;
		if (inlets.open[seat.inMouth] !== wantIn) S.toggleInlet(sim, seat.inMouth, false, seat.player);
		if (inlets.open[seat.outMouth] !== wantOut) S.toggleInlet(sim, seat.outMouth, false, seat.player);
	}

	// The field tag is the band, which only changes per round; the gauge needle
	// carries the live pressure without touching the DOM or building a string.
	function sampleSeat(game, seat) {
		seat.pressure = sampleChamberPotential(game.sim, seat.bottle);
		seat.ok = seat.pressure >= seat.lo && seat.pressure <= seat.hi;
	}

	// One integer carries everything the panel shows, so a steady needle costs no
	// string and no DOM rebuild.
	function markSeatShown(game, seat) {
		const key = (Math.round(seat.pressure * 20) << 6) | (Math.round(seat.holdRatio * 10) << 1) | (seat.ok ? 1 : 0);
		if (key === seat.shown) return;
		seat.shown = key;
		game.version++;
	}

	function holdSeat(game, seat, dt) {
		const player = game.players[seat.player];
		if (!seat.ok) {
			seat.hold = 0;
			seat.holdRatio = 0;
			const miss = seat.pressure < seat.lo ? seat.lo - seat.pressure : seat.pressure - seat.hi;
			if (!seat.alarm && miss > VENT_ALARM) {
				seat.alarm = true;
				player.failed++;
				game.lastEvent = player.name + " lost the band on " + seat.tag + ".";
				game.version++;
				game.rosterVersion++;
			} else if (seat.alarm && miss <= VENT_ALARM * 0.5) seat.alarm = false;
			return;
		}
		seat.hold += dt;
		seat.holdRatio = seat.hold >= VENT_HOLD ? 1 : seat.hold / VENT_HOLD;
		if (seat.hold < VENT_HOLD) return;
		seat.rounds++;
		player.score += seat.points;
		player.completed++;
		game.lastEvent = player.name + " held " + seat.tag + " (+" + seat.points + " pts).";
		fitVentBand(game, seat, true);
		game.version++;
		game.rosterVersion++;
	}

	// An open mouth moves a pocket by a third of the band in one frame, so the
	// seats are driven on the sim cadence; only the panel is throttled.
	function stepVent(game, dt) {
		const vent = game.vent;
		let left = dt;
		while (left > 0) {
			const slice = left < S.STEP ? left : S.STEP;
			left -= slice;
			for (let s = 0; s < vent.count; s++) {
				const seat = vent.seats[s];
				if (seat.bottle < 0) continue;
				sampleSeat(game, seat);
				const player = game.players[seat.player];
				if (player && player.bot && game.botControl) stepVentBot(game, seat, slice);
				holdSeat(game, seat, slice);
			}
		}
		game.evalClock += dt;
		if (game.evalClock < EVAL_DT) return;
		game.evalClock = 0;
		for (let s = 0; s < vent.count; s++) {
			if (vent.seats[s].bottle < 0) continue;
			markSeatShown(game, vent.seats[s]);
		}
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
			const holder = mq.owner;
			if (holder < 0 || holder === botId || mq.kind !== "pressure") continue;
			if (game.players[holder] && game.players[holder].bot) activeBotPressure = mq.op;
		}
		let bestIdx = -1;
		let bestScore = -1e9;
		for (let k = 0; k < game.quests.length; k++) {
			const q = game.quests[k];
			if (q.owner >= 0 || q.openFor < BOT_GRACE) continue;
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

	// A player owns two in and two out mouths, so the whole mouth policy is a
	// couple of presses: seal my opposing pair, then open my favourable pair.
	function botMouthAction(sim, playerId, wantHigh) {
		const inlets = sim.inlets;
		const favourable = wantHigh ? I.BOTTOM : I.TOP;
		const opposing = wantHigh ? I.TOP : I.BOTTOM;
		for (let c = 0; c < N; c++) {
			const idx = opposing * N + c;
			if (!I.ownedBy(inlets, idx, playerId) || !inlets.open[idx]) continue;
			return S.toggleInlet(sim, idx, false, playerId);
		}
		for (let c = 0; c < N; c++) {
			const idx = favourable * N + c;
			if (!I.ownedBy(inlets, idx, playerId) || inlets.open[idx]) continue;
			return S.toggleInlet(sim, idx, false, playerId);
		}
		return false;
	}

	function botStepPressureQuest(game, quest, playerId) {
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
		const wantHigh = quest.op === ">";
		if (botMouthAction(sim, playerId, wantHigh)) return true;
		let state = findAirRoute(sim, goalIdx, wantHigh, playerId);
		if (state < 0) return false;
		let q = airQuarter[state];
		while (state >= 0) {
			const cell = state >> 2;
			const cur = G.quarterOf(sim.target[cell]);
			if (cell !== goalIdx && q !== cur) return S.turn(sim, cell, ((q - cur + 4) & 3) === 3 ? -1 : 1);
			const parent = airParent[state];
			if (parent < 0) break;
			const need = (1 << (parent & 3)) | (1 << (((state & 3) + 2) & 3));
			const v = sim.layout.valves[parent >> 2];
			q = bestQuarterForMask(valveMask(v), G.quarterOf(sim.target[parent >> 2]), need);
			state = parent;
		}
		return false;
	}

	function stepBots(game, dt) {
		if (!game.botControl) return;
		if (game.pourCooldown > 0) game.pourCooldown -= dt;
		for (let p = 0; p < game.players.length; p++) {
			if (!game.players[p].bot) continue;
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
			if (quest.kind === "pressure") botStepPressureQuest(game, quest, p);
			else botStepGrainQuest(game, quest);
		}
	}

	function step(game, dt) {
		if (!game || !(dt > 0)) return;
		if (game.mode === "vent") {
			stepVent(game, dt);
			return;
		}
		if (game.mode !== "game") return;
		game.evalClock += dt;
		const doEval = game.evalClock >= EVAL_DT;
		if (doEval) game.evalClock = 0;

		for (let q = game.quests.length - 1; q >= 0; q--) {
			const quest = game.quests[q];
			if (quest.owner < 0) {
				quest.openFor += dt;
				continue;
			}
			if (quest.timeLimit > 0) {
				const beforeSec = Math.ceil(quest.remaining);
				quest.remaining -= dt;
				if (quest.remaining <= 0) {
					finishQuest(game, q, "expired");
					continue;
				}
				if (Math.ceil(quest.remaining) !== beforeSec) game.version++;
			}
			if (doEval) evaluateQuest(game, quest);
			// Every bottle has to hold, so one window covers the quest: the verdicts
			// `evaluateQuest` cached on the settle cadence carry it between evaluations.
			let ok = quest.cellCount > 0;
			for (let s = 0; s < quest.cellCount; s++) if (!quest.cellOk[s]) ok = false;
			if (!ok) {
				quest.hold = 0;
				quest.holdRatio = 0;
				continue;
			}
			quest.hold += dt;
			quest.holdRatio = quest.hold >= quest.holdNeed ? 1 : quest.hold / quest.holdNeed;
			if (quest.hold >= quest.holdNeed) finishQuest(game, q, "done");
		}

		stepBots(game, dt);
	}

	// Who answers a mouth press: its owner when that seat is played by a person,
	// otherwise nobody. A bot's mouth and an undealt slot are not pressable, and
	// Lab mode has no owners at all so any press is the local player's.
	function pressActor(game, inlet) {
		const inlets = game.sim.inlets;
		if (inlet < 0 || inlet >= inlets.count || !inlets.present[inlet]) return -1;
		const owner = inlets.owner[inlet];
		if (owner === I.UNOWNED) return game.mode === "lab" ? 0 : -1;
		const player = game.players[owner];
		return player && !player.bot ? owner : -1;
	}

	// A rotor belongs to the hand when nobody owns it or when its owner is a seat a
	// person plays. Vent mode locks the whole field: only mouths move there.
	function canTurn(game, index) {
		if (index < 0 || index >= SLOTS || game.mode === "vent") return false;
		const owner = game.sim.goalOwner[index];
		if (owner < 0) return true;
		const player = game.players[owner];
		return !!player && !player.bot;
	}

	return {
		LAB_AUTO,
		GAME_AUTO,
		VENT_AUTO,
		VENT_MAX,
		VENT_HOLD,
		VENT_ALARM,
		MAX_SEATS,
		BOARD_SIZE,
		HOLD_OPEN,
		HOLD_EXACT,
		COHERENCE_MIN,
		GOAL_CHAMBER,
		GRAIN_HUE_DEG,
		BAND_GROUPS,
		BOT_GRACE,
		HOLD_PRESSURE,
		angleDiffDeg,
		autoFor,
		create,
		setMode,
		setBotControl,
		setPlayerBot,
		addPlayer,
		removePlayer,
		pressActor,
		canTurn,
		notice,
		resetMatch,
		generateQuest,
		spawnQuest,
		signQuest,
		dropQuest,
		evaluateCell,
		evaluateQuest,
		measureVentSpan,
		step,
		consumeDirty,
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ValveGame;
