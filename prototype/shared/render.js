const ValveRender = (() => {
	"use strict";

	const G = ValveGeometry;
	const N = G.N;
	const S = G.S;
	const SIZE = G.SIZE;
	const RV = G.RV;
	const HALF = G.HALF;
	const WALL = G.WALL;
	const EDGE = G.EDGE;
	const TAU = G.TAU;

	const GROUT = "#1a1e24";
	const EDGE_C = "#15191f";
	const WALL_V = "#c6cfd9";
	const WALL_H = "#98a3af";
	const RIM_BAND = 1.1;
	const SPR = Math.ceil(2 * RV + 6);

	function hsl(h, s, l) {
		return "hsl(" + h.toFixed(1) + "," + s.toFixed(1) + "%," + l.toFixed(1) + "%)";
	}

	// Muted grey housings with a small hue and lightness variation per cell, kept
	// out of the geometry layer so layout stays pure data.
	function paintFor(rnd) {
		const hueTile = 210 + (rnd() * 24 - 12);
		const hueBody = 214 + (rnd() * 20 - 10);
		const sat = 5 + rnd() * 6;
		const light = 43 + rnd() * 13;
		return {
			tileHi: hsl(hueTile, sat, light + 5),
			tileLo: hsl(hueTile, sat, light - 5),
			bodyHi: hsl(hueBody, sat, 23 + rnd() * 8),
			bodyLo: hsl(hueBody, sat, 23 + rnd() * 8),
		};
	}

	function makeCanvas(w, h, dpr) {
		const c = document.createElement("canvas");
		c.width = Math.max(1, Math.round(w * dpr));
		c.height = Math.max(1, Math.round(h * dpr));
		const ctx = c.getContext("2d");
		ctx.scale(dpr, dpr);
		return { c: c, ctx: ctx };
	}

	function roundRect(ctx, x, y, w, h, r) {
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.lineTo(x + w - r, y);
		ctx.quadraticCurveTo(x + w, y, x + w, y + r);
		ctx.lineTo(x + w, y + h - r);
		ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
		ctx.lineTo(x + r, y + h);
		ctx.quadraticCurveTo(x, y + h, x, y + h - r);
		ctx.lineTo(x, y + r);
		ctx.quadraticCurveTo(x, y, x + r, y);
		ctx.closePath();
	}

	// A housing channel is three nested bands: dark edge, light material, air.
	// Strip geometry is cell-local, so the caller translates to the cell center.
	// The corridor is drawn from just inside the rotor rim so it visually meets
	// the clipped passage; the length must stay exactly that span. Bands are
	// painted in passes across the whole field: neighbouring corridors cross at
	// every cell edge, so a strip's dark edge must never land on another's air.
	const HALF_EDGE = HALF + WALL + EDGE;
	function paintStripBand(ctx, st, half, color) {
		const inner = RV - 1;
		const len = st.far - inner;
		ctx.save();
		ctx.translate(st.ux * (inner + len / 2), st.uy * (inner + len / 2));
		ctx.rotate(Math.atan2(st.uy, st.ux));
		ctx.fillStyle = color;
		ctx.fillRect(-len / 2, -half, len, half * 2);
		ctx.restore();
	}

	function paintStrips(ctx, layout, air) {
		const passes = [
			[HALF_EDGE, EDGE_C],
			[HALF + WALL, WALL_H],
			[HALF, air],
		];
		for (const pass of passes) {
			for (const v of layout.valves) {
				ctx.save();
				ctx.translate(v.cx, v.cy);
				for (const st of v.strips) paintStripBand(ctx, st, pass[0], pass[1]);
				ctx.restore();
			}
		}
	}

	function paintBackground(layout, colors, air, dpr) {
		const sheet = makeCanvas(SIZE, SIZE + G.POUR * 2, dpr);
		const ctx = sheet.ctx;
		ctx.fillStyle = GROUT;
		ctx.fillRect(0, 0, SIZE, SIZE + G.POUR * 2);
		// The sheet also covers the pour bands, so field coordinates are shifted
		// down once and every painter keeps working in world units.
		ctx.translate(0, G.POUR);
		const inset = 1.6;
		const tile = S - inset * 2;
		for (let k = 0; k < layout.valves.length; k++) {
			const v = layout.valves[k];
			const x = v.cx - S / 2 + inset;
			const y = v.cy - S / 2 + inset;
			const g = ctx.createLinearGradient(x, y, x, y + tile);
			g.addColorStop(0, colors[k].tileHi);
			g.addColorStop(1, colors[k].tileLo);
			roundRect(ctx, x, y, tile, tile, 5);
			ctx.fillStyle = g;
			ctx.fill();
			ctx.lineWidth = 1;
			ctx.strokeStyle = "rgba(12,15,19,0.55)";
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(x + 5, y + 1);
			ctx.lineTo(x + tile - 5, y + 1);
			ctx.strokeStyle = "rgba(255,255,255,0.16)";
			ctx.stroke();
		}
		for (const v of layout.valves) {
			ctx.beginPath();
			ctx.arc(v.cx, v.cy, RV + EDGE + 0.9, 0, TAU);
			ctx.lineWidth = 2.6;
			ctx.strokeStyle = "rgba(14,17,22,0.5)";
			ctx.stroke();
		}
		paintStrips(ctx, layout, air);
		for (const v of layout.valves) {
			for (const sx of [-1, 1]) {
				for (const sy of [-1, 1]) {
					const bx = v.cx + sx * (S / 2 - 10.5);
					const by = v.cy + sy * (S / 2 - 10.5);
					ctx.beginPath();
					ctx.arc(bx, by, 4.4, 0, TAU);
					ctx.fillStyle = "rgba(20,24,30,0.55)";
					ctx.fill();
					ctx.beginPath();
					ctx.arc(bx, by, 3.2, 0, TAU);
					ctx.fillStyle = "#8b949c";
					ctx.fill();
					ctx.beginPath();
					ctx.moveTo(bx - 2.1, by);
					ctx.lineTo(bx + 2.1, by);
					ctx.lineWidth = 1.1;
					ctx.strokeStyle = "rgba(16,20,26,0.65)";
					ctx.stroke();
				}
			}
		}
		return sheet.c;
	}

	// Rotor sprite: silhouette and body, then the clipped passages. The passage
	// strokes are the drawing of the very prims used for collision, and the disk
	// clip is the same rotor radius, so drawn air and modelled air agree.
	function paintRotor(v, colors, air, dpr) {
		const sheet = makeCanvas(SPR, SPR, dpr);
		const ctx = sheet.ctx;
		ctx.translate(SPR / 2, SPR / 2);
		const g = ctx.createRadialGradient(-RV * 0.34, -RV * 0.4, RV * 0.08, 0, 0, RV * 1.05);
		g.addColorStop(0, colors.bodyHi);
		g.addColorStop(1, colors.bodyLo);
		ctx.beginPath();
		ctx.arc(0, 0, RV, 0, TAU);
		ctx.fillStyle = g;
		ctx.fill();
		ctx.beginPath();
		ctx.arc(0, 0, RV - RIM_BAND, 0, TAU);
		ctx.lineWidth = RIM_BAND * 2;
		ctx.strokeStyle = EDGE_C;
		ctx.stroke();
		ctx.beginPath();
		const ticks = 24;
		for (let k = 0; k < ticks; k++) {
			const a = (k / ticks) * TAU;
			ctx.moveTo(Math.cos(a) * RV * 0.86, Math.sin(a) * RV * 0.86);
			ctx.lineTo(Math.cos(a) * RV * 0.93, Math.sin(a) * RV * 0.93);
		}
		ctx.lineWidth = 1.4;
		ctx.strokeStyle = "rgba(255,255,255,0.1)";
		ctx.stroke();
		ctx.save();
		ctx.beginPath();
		ctx.arc(0, 0, RV, 0, TAU);
		ctx.clip();
		ctx.lineCap = "butt";
		ctx.lineJoin = "miter";
		const chamber = v.chamberR;
		const disc = (r, color) => {
			ctx.beginPath();
			ctx.arc(0, 0, r, 0, TAU);
			ctx.fillStyle = color;
			ctx.fill();
		};
		if (chamber > 0) disc(chamber + WALL + EDGE, EDGE_C);
		ctx.strokeStyle = EDGE_C;
		ctx.lineWidth = HALF * 2 + WALL * 2 + EDGE * 2;
		ctx.stroke(v.path);
		if (chamber > 0) disc(chamber + WALL, WALL_V);
		ctx.strokeStyle = WALL_V;
		ctx.lineWidth = HALF * 2 + WALL * 2;
		ctx.stroke(v.path);
		if (chamber > 0) disc(chamber, air);
		ctx.strokeStyle = air;
		ctx.lineWidth = HALF * 2;
		ctx.stroke(v.path);
		ctx.restore();
		return sheet.c;
	}

	function buildScene(layout, air, dpr) {
		const rnd = G.rng(layout.seed * 2654435761);
		const colors = layout.valves.map(() => paintFor(rnd));
		const sprites = layout.valves.map((v, k) => paintRotor(v, colors[k], air, dpr));
		return {
			bg: paintBackground(layout, colors, air, dpr),
			sprites: sprites,
			sprite: SPR,
			dpr: dpr,
		};
	}

	function renderScene(ctx, layout, scene) {
		ctx.clearRect(0, -G.POUR, SIZE, SIZE + G.POUR * 2);
		ctx.drawImage(scene.bg, 0, -G.POUR, SIZE, SIZE + G.POUR * 2);
		const half = scene.sprite / 2;
		for (const v of layout.valves) {
			if (v.angle === 0) {
				ctx.drawImage(scene.sprites[v.j * N + v.i], v.cx - half, v.cy - half, scene.sprite, scene.sprite);
				continue;
			}
			ctx.save();
			ctx.translate(v.cx, v.cy);
			ctx.rotate(v.angle);
			ctx.drawImage(scene.sprites[v.j * N + v.i], -half, -half, scene.sprite, scene.sprite);
			ctx.restore();
		}
	}

	// Coarse air map of the same clearance field the contact solver will query.
	// Sampling well under a grain radius makes the drawn air and the model easy to
	// compare by eye.
	function renderAirMap(map, layout) {
		const w = Math.ceil(SIZE / map.cell);
		const h = Math.ceil((SIZE + G.POUR * 2) / map.cell);
		const data = map.img.data;
		let k = 0;
		for (let y = 0; y < h; y++) {
			const wy = y * map.cell - G.POUR + map.cell / 2;
			for (let x = 0; x < w; x++) {
				const wx = x * map.cell + map.cell / 2;
				const air = G.airClearance(layout, wx, wy) >= 0.9;
				data[k] = 96;
				data[k + 1] = 232;
				data[k + 2] = 255;
				data[k + 3] = air ? 128 : 0;
				k += 4;
			}
		}
		map.ctx.putImageData(map.img, 0, 0);
	}

	// Grains are drawn last, over the housings, in one pass with a single fill
	// colour per grain. Nothing here allocates: the palette is a plain table and
	// the path is reused.
	function renderGrains(ctx, sim, palette) {
		const x = sim.x;
		const y = sim.y;
		const r = sim.r;
		for (let k = 0; k < sim.count; k++) {
			ctx.fillStyle = palette[sim.color[k]];
			ctx.beginPath();
			ctx.arc(x[k], y[k], r[k], 0, TAU);
			ctx.fill();
		}
		ctx.strokeStyle = EDGE_C;
		ctx.lineWidth = 0.6;
		ctx.beginPath();
		for (let k = 0; k < sim.count; k++) {
			ctx.moveTo(x[k] + r[k], y[k]);
			ctx.arc(x[k], y[k], r[k], 0, TAU);
		}
		ctx.stroke();
	}

	function makeAirMap(cell) {
		const w = Math.ceil(SIZE / cell);
		const h = Math.ceil((SIZE + G.POUR * 2) / cell);
		const c = document.createElement("canvas");
		c.width = w;
		c.height = h;
		const ctx = c.getContext("2d");
		return { canvas: c, ctx: ctx, img: ctx.createImageData(w, h), cell: cell, w: w, h: h };
	}

	return {
		SPR: SPR,
		buildScene: buildScene,
		renderScene: renderScene,
		makeAirMap: makeAirMap,
		renderAirMap: renderAirMap,
		renderGrains: renderGrains,
		makeCanvas: makeCanvas,
	};
})();
if (typeof module !== "undefined") module.exports = ValveRender;
