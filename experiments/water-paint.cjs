// One picture painter for the water previews, so a colour or alpha change is
// judged in the layers the page actually draws instead of a copy. The sheet is
// painted by `ValveRender.renderWater` from the solver's own display field, so a
// dead or drifted water layer shows up in the pictures, not only in a browser.
"use strict";
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");
const R = require("../prototype/shared/render.js");

const GRAIN_RGB = S.GRAIN_COLORS.map(hex => [1, 3, 5].map(o => parseInt(hex.slice(o, o + 2), 16)));

function mix(px, o, rgb, a) {
	px[o] += (rgb[0] - px[o]) * a;
	px[o + 1] += (rgb[1] - px[o + 1]) * a;
	px[o + 2] += (rgb[2] - px[o + 2]) * a;
}

// Grain-free scene: dark ceramic, pale passages, then the page's water sheet.
function background(sim, view, scale, wdt, hgt) {
	const px = Buffer.alloc(wdt * hgt * 3);
	for (let i = 0; i < px.length; i += 3) {
		px[i] = 18;
		px[i + 1] = 22;
		px[i + 2] = 29;
	}
	for (let y = 0; y < hgt; y++) {
		const wy = view.y0 + (y + 0.5) / scale;
		for (let x = 0; x < wdt; x++) {
			const clear = G.airClearance(sim.layout, view.x0 + (x + 0.5) / scale, wy);
			const o = (y * wdt + x) * 3;
			if (clear >= S.R_GRAIN) {
				px[o] = 236;
				px[o + 1] = 240;
				px[o + 2] = 244;
			} else if (clear > 0) {
				px[o] = 118;
				px[o + 1] = 128;
				px[o + 2] = 140;
			}
		}
	}
	return px;
}

// Water as the page paints it: the display field the buoyancy reads, painted by
// render.js, composited over the scene at its own alpha.
function sheet(sim, view, scale, wdt, hgt, px, pigment) {
	if (!sim.water || !sim.water.enabled) return;
	const field = W.makeDisplay(sim.water);
	W.sampleDisplay(sim, field);
	const map = { nx: field.nx, ny: field.ny, img: { data: new Uint8ClampedArray(field.nx * field.ny * 4) }, ctx: { putImageData() {} } };
	R.renderWater(map, field, pigment ? 1 : 0);
	const data = map.img.data;
	const cell = field.cell;
	for (let y = 0; y < hgt; y++) {
		const wy = view.y0 + (y + 0.5) / scale;
		const gy = Math.floor((wy + G.POUR) / cell);
		if (gy < 0 || gy >= field.ny) continue;
		for (let x = 0; x < wdt; x++) {
			const gx = Math.floor((view.x0 + (x + 0.5) / scale) / cell);
			if (gx < 0 || gx >= field.nx) continue;
			const a = data[(gy * field.nx + gx) * 4 + 3] / 255;
			if (a <= 0) continue;
			const o = (y * wdt + x) * 3;
			mix(px, o, [data[(gy * field.nx + gx) * 4], data[(gy * field.nx + gx) * 4 + 1], data[(gy * field.nx + gx) * 4 + 2]], a);
		}
	}
}

function grains(sim, view, scale, wdt, hgt, px) {
	for (let k = 0; k < sim.count; k++) {
		const cx = (sim.x[k] - view.x0) * scale;
		const cy = (sim.y[k] - view.y0) * scale;
		const rad = sim.r[k] * scale;
		const col = GRAIN_RGB[sim.color[k]];
		const edge = (rad - 1) * (rad - 1);
		for (let dy = -Math.ceil(rad); dy <= rad; dy++) {
			for (let dx = -Math.ceil(rad); dx <= rad; dx++) {
				const d2 = dx * dx + dy * dy;
				if (d2 > rad * rad) continue;
				const x = Math.round(cx + dx);
				const y = Math.round(cy + dy);
				if (x < 0 || x >= wdt || y < 0 || y >= hgt) continue;
				mix(px, (y * wdt + x) * 3, d2 > edge ? [21, 25, 31] : col, d2 > edge ? 0.65 : 1);
			}
		}
	}
}

// view: {x0, y0, w, h} in field coordinates. scale 1 is one pixel per field px.
function panel(sim, view, scale, pigment) {
	const wdt = Math.round(view.w * scale);
	const hgt = Math.round(view.h * scale);
	const px = background(sim, view, scale, wdt, hgt);
	sheet(sim, view, scale, wdt, hgt, px, pigment);
	grains(sim, view, scale, wdt, hgt, px);
	return { rgb: px, w: wdt, h: hgt };
}

module.exports = { panel, GRAIN_RGB };
