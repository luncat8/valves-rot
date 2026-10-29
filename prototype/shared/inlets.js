// Constant-pressure boundary mouths. Every column has one mouth in the pour band
// above the field and one in the drain band below it. Bottom mouths are high
// pressure sources, top mouths are low pressure vents, and the pressure backends
// pin their value at each open mouth, so the field keeps a standing gradient
// between the reservoirs instead of relaxing to a uniform cloud.
//
// In Lab mode every mouth exists and anyone may press it. Game mode deals each
// competitor four owned mouths — two sources (in) and two vents (out), as the
// two ends of two random columns — and leaves the rest of the bands empty, so
// there is nothing to grind at: only an owner can press their own mouth, and an
// owned mouth keeps the polarity it was dealt.
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

	// Game mode: two source (in) and two vent (out) mouths per player, dealt as
	// two random columns that each hold one in and one out. A player therefore
	// owns a small pressure station they can charge or drain, the colour marks
	// both ends of the column, and no two players share a column.
	function deal(inlets, players, rnd) {
		for (let k = 0; k < inlets.count; k++) {
			inlets.present[k] = 0;
			inlets.owner[k] = UNOWNED;
			inlets.open[k] = 0;
		}
		shuffleColumns(dealColumns, rnd);
		const dealt = Math.min(players, (G.N / PER_PLAYER) | 0);
		for (let p = 0; p < dealt; p++) {
			for (let n = 0; n < PER_PLAYER; n++) {
				const col = dealColumns[p * PER_PLAYER + n];
				claim(inlets, TOP * G.N + col, p, LOW);
				claim(inlets, BOTTOM * G.N + col, p, HIGH);
			}
		}
		inlets.version++;
	}

	function claim(inlets, index, owner, level) {
		inlets.present[index] = 1;
		inlets.owner[index] = owner;
		inlets.level[index] = level;
		inlets.open[index] = 1;
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

	return { LOW, HIGH, TOP, BOTTOM, MOUTH, UNOWNED, PER_PLAYER, create, reset, deal, press, canPress, ownedBy, count, hit };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveInlets;
