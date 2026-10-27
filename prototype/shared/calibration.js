// SI reference for the display only. The grid itself stores a normalized relative pressure.
const ValveCalibration = (() => {
	"use strict";

	const UNITS = Object.freeze({
		metresPerPixel: 0.001,
		secondsPerSimSecond: 1,
		kgPerMassUnit: 0.000001,
		depthMetres: 0.01,
	});

	// 100 particles in a sealed radius-15 px chamber, 20 s, seed 0x4a71.
	// Normal wall impulse measured by ValveAir, excluding recovery and the cap.
	const REF_RADIUS = 15;
	const REF_SECONDS = 20;
	const REF_IMPULSE = 13429587.29757736;

	function wallPressure(impulse, seconds, wallLength, units = UNITS) {
		const momentum = impulse * units.kgPerMassUnit * units.metresPerPixel / units.secondsPerSimSecond;
		const area = wallLength * units.metresPerPixel * units.depthMetres;
		return momentum / (seconds * units.secondsPerSimSecond * area);
	}

	const DEFAULT_SPAN = wallPressure(REF_IMPULSE, REF_SECONDS, 2 * Math.PI * REF_RADIUS);

	function equivalentPressure(potential, span) {
		return Math.max(0, Math.min(1, potential)) * span;
	}

	function format(span) {
		if (span >= 10000 || span < 0.001) return span.toExponential(2);
		return String(Number(span.toPrecision(4)));
	}

	return { UNITS, REF_RADIUS, REF_SECONDS, REF_IMPULSE, DEFAULT_SPAN, wallPressure, equivalentPressure, format };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveCalibration;
