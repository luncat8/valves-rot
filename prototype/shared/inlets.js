// Constant-pressure boundary mouths. Every column has one mouth in the pour band
// above the field and one in the drain band below it. Bottom mouths are high
// pressure sources, top mouths are low pressure vents, and the pressure backends
// pin their value at each open mouth, so the field keeps a standing gradient
// between the reservoirs instead of relaxing to a uniform cloud.
const ValveInlets = (() => {
	"use strict";
	const G = typeof ValveGeometry !== "undefined" ? ValveGeometry : require("./geometry.js");

	const LOW = 0;
	const HIGH = 1;
	const TOP = 0;
	const BOTTOM = 1;
	// Marker depth inside the band, clear of the housing edge.
	const MOUTH = 5;

	function create() {
		const count = G.N * 2;
		const inlets = {
			count,
			version: 0,
			side: new Uint8Array(count),
			column: new Uint8Array(count),
			level: new Uint8Array(count),
			open: new Uint8Array(count),
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
	}

	function reset(inlets) {
		for (let k = 0; k < inlets.count; k++) {
			inlets.open[k] = 1;
			inlets.level[k] = inlets.side[k] === TOP ? LOW : HIGH;
		}
		inlets.version++;
	}

	// A click toggles a mouth between open and sealed; a flipped mouth swaps its
	// source/vent polarity instead.
	function press(inlets, index, flip) {
		if (index < 0 || index >= inlets.count) return false;
		if (flip) inlets.level[index] = inlets.level[index] === HIGH ? LOW : HIGH;
		else inlets.open[index] = inlets.open[index] ? 0 : 1;
		inlets.version++;
		return true;
	}

	function count(inlets, level) {
		let n = 0;
		for (let k = 0; k < inlets.count; k++) if (inlets.open[k] && inlets.level[k] === level) n++;
		return n;
	}

	// World point in either band selects that column's mouth.
	function hit(inlets, x, y) {
		let side = -1;
		if (y < 0) side = TOP;
		else if (y > G.SIZE) side = BOTTOM;
		if (side < 0) return -1;
		const column = Math.max(0, Math.min(G.N - 1, (x / G.S) | 0));
		return side * G.N + column;
	}

	return { LOW, HIGH, TOP, BOTTOM, MOUTH, create, reset, press, count, hit };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveInlets;
