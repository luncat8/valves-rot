// Balance measurements for Game mode: how much a goal bottle can actually hold,
// how long the spout promotion a signed route gets lasts, and how much each quest
// tier and kind costs a bot field in solve time, pours, completions and expiries.
// Run: node experiments/game-balance.cjs [seconds] [seeds...]
// AUTO=0.1,0 also re-runs the match at other auto-rotate shares.
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const Game = require("../prototype/shared/game.js");

const N = G.N;
const SECONDS = Number(process.argv[2] || 90);
const EXTRA = process.argv.slice(3).map(Number);
const SEEDS = EXTRA.length ? EXTRA : [7, 11, 42];

// A straight N-S feed column over an open field, so the bottle is the only restriction.
function feedLayout(seed) {
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) valves.push(G.makeValve(i, j, "solid", [3, 1], 0, 0));
	}
	return { seed, valves };
}

// 1. Capacity of a goal bottle: the count a quest may legitimately ask for.
function capacity(kind, chamber, seconds) {
	const sim = S.create(feedLayout(7), { turning: false });
	const idx = 5 * N + 5;
	S.installValve(sim, idx, G.typeById(kind), 3, chamber);
	const v = sim.layout.valves[idx];
	const steps = Math.round(seconds / S.STEP);
	let poured = 0;
	for (let k = 0; k < steps; k++) {
		if (k % 12 === 0) {
			for (let f = 0; f < 5; f++) {
				const x = v.cx + (f - 2) * 2.6;
				if (S.addGrain(sim, x, v.cy - 26, 1.9) >= 0) poured++;
			}
		}
		S.step(sim, S.STEP);
	}
	let inCell = 0;
	const colors = new Int32Array(6);
	for (let k = 0; k < sim.count; k++) {
		if (G.cellAt(sim.x[k], sim.y[k]) !== idx) continue;
		const dx = sim.x[k] - v.cx;
		const dy = sim.y[k] - v.cy;
		if (dx * dx + dy * dy >= G.RV * G.RV) continue;
		inCell++;
		colors[sim.color[k]]++;
	}
	let top = 0;
	for (let c = 0; c < 6; c++) if (colors[c] > top) top = colors[c];
	return { poured, inCell, top };
}

// The chance that a bottle of `total` uniformly random grains holds at least
// `need` of one colour, or lands its circular mean hue inside a 60 degree band.
function colorOdds(total, trials) {
	const rnd = G.rng(0x9e3779b9);
	const bands = Game.BAND_GROUPS[6];
	const cos = new Float64Array(6);
	const sin = new Float64Array(6);
	for (let c = 0; c < 6; c++) {
		const rad = (Game.GRAIN_HUE_DEG[c] * Math.PI) / 180;
		cos[c] = Math.cos(rad);
		sin[c] = Math.sin(rad);
	}
	const hits = { top: 0, mean: 0 };
	const best = new Float64Array(8);
	for (let t = 0; t < trials; t++) {
		const counts = new Int32Array(6);
		let cs = 0;
		let sn = 0;
		for (let k = 0; k < total; k++) {
			const c = (rnd() * 6) | 0;
			counts[c]++;
			cs += cos[c];
			sn += sin[c];
		}
		let top = 0;
		for (let c = 0; c < 6; c++) if (counts[c] > top) top = counts[c];
		hits.top += top;
		for (let need = 1; need <= 7; need++) if (top >= need) best[need]++;
		const mean = (Math.atan2(sn, cs) * 180) / Math.PI;
		const coherence = Math.hypot(cs, sn) / total;
		for (const band of bands) {
			if (Game.angleDiffDeg(mean, band.center) <= band.half && coherence >= Game.COHERENCE_MIN) {
				hits.mean++;
				break;
			}
		}
	}
	return { bestColour: hits.top / trials, meanHits: hits.mean / trials, need: Array.from(best).slice(1).map(v => v / trials) };
}

// 2. Is the pour spout above a signed route promoted for exactly the life of the quest?
function spoutPromotion() {
	const sim = S.create(G.createLayout(7), { turning: false });
	const game = Game.create(sim, { mode: "game", botControl: false });
	S.setAutoRotate(sim, 0);
	let first = null;
	// Sign quests until one lands a route whose top column is not already primary.
	for (let attempt = 0; attempt < 40 && !first; attempt++) {
		const before = sim.spoutMask.slice();
		const q = game.quests.find(x => x.kind === "grains" && x.owner < 0);
		if (!q || !Game.signQuest(game, q.id, 0)) break;
		let promoted = -1;
		for (let i = 0; i < N; i++) if (!before[i] && sim.spoutMask[i]) promoted = i;
		if (promoted < 0) {
			Game.dropQuest(game, 0);
			continue;
		}
		first = { title: q.title, column: promoted, mask: sim.spoutMask.join("") };
	}
	if (!first) return { note: "no promotion found on this seed" };
	// Another player's goal bottle landing elsewhere rebuilds the mask.
	Game.signQuest(game, game.quests.find(x => x.owner < 0).id, 2);
	const afterOther = sim.spoutMask.slice();
	// Ending the quest hands the column back, unless the layout owns it anyway.
	Game.dropQuest(game, 0);
	const afterEnd = sim.spoutMask.slice();
	return {
		...first,
		survivedOther: afterOther[first.column] === 1,
		releasedOnEnd: afterEnd[first.column] === 1 ? sim.goalFeed[first.column] === 0 : true,
	};
}

// 3. Match telemetry: how long each signed quest takes, and what it is worth.
// `auto` overrides Game mode's auto-rotate share, to measure route churn.
function telemetry(seconds, seed, auto) {
	const sim = S.create(G.createLayout(seed), { turning: true });
	S.setPressure(sim, "grid");
	const game = Game.create(sim, { mode: "game", botControl: true });
	if (auto !== undefined) S.setAutoRotate(sim, auto);
	const steps = Math.round(seconds / S.STEP);
	const rows = [];
	const live = new Map();
	let unsignedTicks = 0;
	let signedTicks = 0;
	for (let k = 0; k < steps; k++) {
		S.step(sim, S.STEP);
		Game.step(game, S.STEP);
		const t = (k + 1) * S.STEP;
		for (const q of game.quests) {
			if (!live.has(q.id)) live.set(q.id, { born: t, signed: -1, quest: q, injected: sim.injected });
			const rec = live.get(q.id);
			if (q.owner >= 0 && rec.signed < 0) {
				rec.signed = t;
				rec.injected = sim.injected;
			}
			if (q.owner < 0) unsignedTicks++;
			else signedTicks++;
		}
		// A quest that left the board was finished, expired or dropped.
		for (const [id, rec] of live) {
			if (game.quests.some(q => q.id === id)) continue;
			const q = rec.quest;
			live.delete(id);
			rows.push({
				seed,
				kind: q.kind,
				tier: q.tier,
				points: q.points,
				bottles: q.bottles,
				bands: q.bands,
				timeLimit: q.timeLimit,
				minCount: q.minCount,
				maxCount: q.maxCount,
				title: q.title,
				owner: q.owner,
				poured: sim.injected - rec.injected,
				done: q.hold >= q.holdNeed,
				expired: q.timeLimit > 0 && q.remaining <= 0,
				wait: rec.signed > 0 ? rec.signed - rec.born : t - rec.born,
				solve: rec.signed > 0 ? t - rec.signed : -1,
			});
		}
	}
	return {
		rows,
		conserved: sim.injected === sim.count + sim.drained + sim.purged,
		signedShare: signedTicks / (signedTicks + unsignedTicks),
		scores: game.players.map(p => ({ name: p.name, score: p.score, done: p.completed, failed: p.failed })),
	};
}

function aggregate(rows, key) {
	const map = new Map();
	for (const r of rows) {
		const k = key(r);
		let a = map.get(k);
		if (!a) map.set(k, (a = { n: 0, done: 0, expired: 0, solve: 0, wait: 0, points: 0, rate: 0, poured: 0 }));
		a.n++;
		a.poured += r.poured;
		a.wait += r.wait;
		if (r.done) {
			a.done++;
			a.solve += r.solve;
			a.points += r.points;
			a.rate += r.points / Math.max(r.solve, 0.001) * 60;
		}
		if (r.expired) a.expired++;
	}
	return map;
}

function table(title, map, order) {
	console.log("\n" + title);
	console.log("group            n  done  exp poured  wait s  solve s   pts   pts/min");
	const keys = order ? order.filter(k => map.has(k)) : [...map.keys()].sort();
	for (const k of keys) {
		const a = map.get(k);
		console.log(
			String(k).padEnd(15),
			String(a.n).padStart(3),
			String(a.done).padStart(5),
			String(a.expired).padStart(4),
			(a.poured / a.n).toFixed(0).padStart(6),
			(a.wait / a.n).toFixed(1).padStart(8),
			(a.done ? (a.solve / a.done).toFixed(1) : "-").padStart(8),
			String(a.points).padStart(6),
			(a.done ? (a.rate / a.done).toFixed(0) : "-").padStart(8),
		);
	}
}

function match(label, auto) {
	console.log("\n=========== match: " + label);
	let all = [];
	for (const seed of SEEDS) {
		const m = telemetry(SECONDS, seed, auto);
		all = all.concat(m.rows);
		console.log(`seed ${seed}: conserved ${m.conserved}, board ${Math.round(100 * m.signedShare)}% signed`);
		console.log("  " + m.scores.map(s => `${s.name} ${s.score}pts (${s.done}d/${s.failed}f)`).join(" · "));
	}
	table("by tier", aggregate(all, r => r.tier), ["easy", "med", "hard"]);
	table("by kind x tier", aggregate(all, r => r.kind + " " + r.tier), null);
	table("by shape", aggregate(all, r =>
		r.kind === "pressure" ? "pressure" : r.bottles > 1 ? "2 bottles" : r.bands === 6 ? "single hue" : r.maxCount > 0 ? "bounded" : "open count"
	), null);
	table("timed only", aggregate(all.filter(r => r.timeLimit > 0), r => r.timeLimit + "s"), null);
	table("by player (0 = idle human)", aggregate(all, r => "player " + r.owner), null);
	const failed = all.filter(r => !r.done);
	console.log(`\nsigned quests that did not score (${failed.length}/${all.length}):`);
	for (const r of failed.slice(0, 10)) console.log(`  ${r.tier.padEnd(4)} ${String(r.points).padStart(2)}pts ${String(r.timeLimit).padStart(3)}s ${r.title}`);
	const scored = all.filter(r => r.done);
	if (scored.length) {
		const per = scored.reduce((a, r) => a + r.poured, 0) / scored.length;
		const perTarget = scored.reduce((a, r) => a + r.poured / Math.max(r.minCount, 1), 0) / scored.length;
		console.log(`grains poured per completed quest ${per.toFixed(0)} (${perTarget.toFixed(0)} per required grain)`);
	}
}

const bottle = capacity("hollow-single", Game.GOAL_CHAMBER, 25);
const odds = colorOdds(Math.max(bottle.inCell, 4), 4000);
console.log("goal bottle capacity, counted inside the cell at rotor radius");
console.log(`  hollow-single at GOAL_CHAMBER: ${bottle.inCell} grains after ${bottle.poured} poured, best colour ${bottle.top}`);
console.log(`  a full bottle of ${Math.max(bottle.inCell, 4)} random grains: expected best colour ${odds.bestColour.toFixed(1)},`);
console.log(`  chance it reaches a band need of 4..7: ${odds.need.map(v => (v * 100).toFixed(0) + "%").join(" ")}`);
console.log(`  circular mean hue inside one 60 deg band: ${(odds.meanHits * 100).toFixed(1)}%`);
console.log("\nspout promotion on signing");
console.log(" ", spoutPromotion());

match("Game default", undefined);
if (process.env.AUTO) for (const a of process.env.AUTO.split(",").map(Number)) match(`auto-rotate ${a * 100}%`, a);
