// Constant-pressure boundary mouths. Every column has one mouth in the pour band
// above the field and one in the drain band below it. Bottom mouths are high
// pressure sources, top mouths are low pressure vents, and the pressure backends
// pin their value at each open mouth, so the field keeps a standing gradient
// between the reservoirs instead of relaxing to a uniform cloud.
//
// In Lab mode every mouth exists and anyone may press it. Game mode deals each
// competitor four owned mouths — two sources (in) and two vents (out) — at
// independent random columns of the two bands and leaves the rest of the bands
// empty, so there is nothing to grind at: only an owner can press their own
// mouth, and an owned mouth keeps the polarity it was dealt. The bands are dealt
// separately, so a player's own in and out mouths never share an x; one column
// can still carry a source for one player and a vent for another.
//
// Vent mode deals one source and one vent per player with `claimPair`; setup
// routes each pair through existing map valves to that player's collector.
const ValveInlets = (() => {
	"use strict";
	const G = typeof ValveGeometry !== "undefined" ? ValveGeometry : require("./geometry.js");

	const LOW = 0;
	const HIGH = 1;
	const TOP = 0;
	const BOTTOM = 1;
	const UNOWNED = -1;
	// Marker depth inside the band, clear of the housing edge.
	const MOUTH = 5;
	const PER_PLAYER = 2;
	// Ten columns, two in mouths each: the widest seat list a deal can serve.
	const MAX_PLAYERS = (G.N / PER_PLAYER) | 0;

	function create() {
		const count = G.N * 2;
		const inlets = {
			count,
			version: 0,
			side: new Uint8Array(count),
			column: new Uint8Array(count),
			level: new Uint8Array(count),
			open: new Uint8Array(count),
			present: new Uint8Array(count),
			owner: new Int8Array(count),
			x: new Float64Array(count),
			y: new Float64Array(count),
		};
		for (let i = 0; i < G.N; i++) {
			define(inlets, i, TOP, i);
			define(inlets, G.N + i, BOTTOM, i);
		}
		return inlets;
	}

	function define(inlets, index, side, column) {
		inlets.side[index] = side;
		inlets.column[index] = column;
		inlets.x[index] = (column + 0.5) * G.S;
		inlets.y[index] = side === TOP ? -G.POUR + MOUTH : G.SIZE + G.POUR - MOUTH;
		inlets.level[index] = side === TOP ? LOW : HIGH;
		inlets.open[index] = 1;
		inlets.present[index] = 1;
		inlets.owner[index] = UNOWNED;
	}

	// Back to the sandbox band: every mouth present, unowned and open.
	function reset(inlets) {
		for (let k = 0; k < inlets.count; k++) {
			inlets.open[k] = 1;
			inlets.present[k] = 1;
			inlets.owner[k] = UNOWNED;
			inlets.level[k] = inlets.side[k] === TOP ? LOW : HIGH;
		}
		inlets.version++;
	}

	function shuffleColumns(order, rnd) {
		for (let c = 0; c < order.length; c++) order[c] = c;
		for (let c = order.length - 1; c > 0; c--) {
			const k = (rnd() * (c + 1)) | 0;
			const t = order[c];
			order[c] = order[k];
			order[k] = t;
		}
	}

	const dealColumns = new Uint8Array(G.N);
	const inColumns = new Uint8Array(G.N);
	const outColumns = new Uint8Array(G.N);
	const columnSlot = new Int8Array(G.N);
	const columnVisited = new Uint8Array(G.N);

	// Game mode: two source (in) mouths at the bottom and two vent (out) mouths
	// at the top per player. The two bands are dealt separately, so a player's
	// in and out mouths sit at different x, and a column carries at most one
	// mouth per band. The in columns come from one shuffled deck, so no two
	// players share one; the out slots are matched onto distinct columns that
	// skip each player's own in columns, so a column owned in one band never
	// holds the same player's mouth in the other.
	function deal(inlets, players, rnd) {
		clearAll(inlets);
		const dealt = Math.min(players, MAX_PLAYERS);
		const mouths = dealt * PER_PLAYER;
		shuffleColumns(dealColumns, rnd);
		for (let s = 0; s < mouths; s++) inColumns[s] = dealColumns[s];
		assignOutColumns(mouths, rnd);
		for (let p = 0; p < dealt; p++) {
			for (let n = 0; n < PER_PLAYER; n++) {
				const s = p * PER_PLAYER + n;
				claim(inlets, BOTTOM * G.N + inColumns[s], p, HIGH);
				claim(inlets, TOP * G.N + outColumns[s], p, LOW);
			}
		}
		inlets.version++;
	}

	// Kuhn's augmenting-path matching of the out slots onto columns. Every slot
	// of a player allows the same eight columns (all but that player's two in
	// columns), so a complete assignment always exists and this never fails.
	function assignOutColumns(mouths, rnd) {
		for (let c = 0; c < G.N; c++) columnSlot[c] = -1;
		for (let s = 0; s < mouths; s++) {
			columnVisited.fill(0);
			matchOutSlot(s, (rnd() * G.N) | 0);
		}
		for (let s = 0; s < mouths; s++) outColumns[s] = 0;
		for (let c = 0; c < G.N; c++) {
			if (columnSlot[c] >= 0) outColumns[columnSlot[c]] = c;
		}
	}

	function matchOutSlot(slot, offset) {
		const player = (slot / PER_PLAYER) | 0;
		for (let k = 0; k < G.N; k++) {
			const col = (offset + k) % G.N;
			if (columnVisited[col]) continue;
			if (isInColumn(player, col)) continue;
			columnVisited[col] = 1;
			const holder = columnSlot[col];
			if (holder < 0 || matchOutSlot(holder, offset)) {
				columnSlot[col] = slot;
				return true;
			}
		}
		return false;
	}

	function isInColumn(player, col) {
		for (let n = 0; n < PER_PLAYER; n++) if (inColumns[player * PER_PLAYER + n] === col) return true;
		return false;
	}

	function claim(inlets, index, owner, level) {
		inlets.present[index] = 1;
		inlets.owner[index] = owner;
		inlets.level[index] = level;
		inlets.open[index] = 1;
		inlets.version++;
	}

	// Every slot empty: no mouth to press anywhere in either band.
	function clearAll(inlets) {
		for (let k = 0; k < inlets.count; k++) {
			inlets.present[k] = 0;
			inlets.owner[k] = UNOWNED;
			inlets.open[k] = 0;
		}
		inlets.version++;
	}

	// Vent mode assigns one independently routed source and vent to each seat.
	function claimPair(inlets, sourceIndex, ventIndex, owner) {
		claim(inlets, sourceIndex, owner, HIGH);
		claim(inlets, ventIndex, owner, LOW);
	}


	function release(inlets, index) {
		inlets.present[index] = 0;
		inlets.owner[index] = UNOWNED;
		inlets.open[index] = 0;
		inlets.version++;
	}

	function releasePair(inlets, sourceIndex, ventIndex) {
		if (sourceIndex >= 0) release(inlets, sourceIndex);
		if (ventIndex >= 0) release(inlets, ventIndex);
	}


	// A click toggles a mouth between open and sealed; a flipped mouth swaps its
	// source/vent polarity instead. `actor` is the player acting: a dealt mouth
	// answers only to its owner and keeps the polarity it was dealt.
	function press(inlets, index, flip, actor) {
		if (index < 0 || index >= inlets.count) return false;
		if (!inlets.present[index]) return false;
		const owner = inlets.owner[index];
		if (owner !== UNOWNED) {
			if (actor !== owner) return false;
			if (flip) return false;
		}
		if (flip) inlets.level[index] = inlets.level[index] === HIGH ? LOW : HIGH;
		else inlets.open[index] = inlets.open[index] ? 0 : 1;
		inlets.version++;
		return true;
	}

	function canPress(inlets, index, actor) {
		if (index < 0 || index >= inlets.count || !inlets.present[index]) return false;
		return inlets.owner[index] === UNOWNED || inlets.owner[index] === actor;
	}

	// Present and owned by `owner`: the two in and two out mouths of one player.
	function ownedBy(inlets, index, owner) {
		return inlets.present[index] === 1 && inlets.owner[index] === owner;
	}

	function count(inlets, level) {
		let n = 0;
		for (let k = 0; k < inlets.count; k++) if (inlets.open[k] && inlets.level[k] === level) n++;
		return n;
	}

	// World point in either band selects that column's mouth, present or not:
	// hovering a dealt mouth names its owner, an empty slot stays quiet.
	function hit(inlets, x, y) {
		let side = -1;
		if (y < 0) side = TOP;
		else if (y > G.SIZE) side = BOTTOM;
		if (side < 0) return -1;
		const column = Math.max(0, Math.min(G.N - 1, (x / G.S) | 0));
		return side * G.N + column;
	}

	return { LOW, HIGH, TOP, BOTTOM, MOUTH, UNOWNED, PER_PLAYER, MAX_PLAYERS, create, reset, deal, clearAll, claimPair, releasePair, press, canPress, ownedBy, count, hit };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveInlets;
