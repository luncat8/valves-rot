const ValveRender = (() => {
	"use strict";

	const G = typeof ValveGeometry !== "undefined" ? ValveGeometry : require("./geometry.js");
	const I = typeof ValveInlets !== "undefined" ? ValveInlets : require("./inlets.js");
	const N = G.N;
	const S = G.S;
	const SIZE = G.SIZE;
	const RV = G.RV;
	const HALF = G.HALF;
	const WALL = G.WALL;
	const EDGE = G.EDGE;
	const TAU = G.TAU;

	const GROUT = "#1a1e24";
	const GPT_GROUT = "#263030";
	const GPT_EDGE = "#45504f";
	const GPT_EDGE_STRIP = "#46504f";
	const GPT_RIM = "#354241";
	const GPT_HOUSING = ["#777d7b", "#7c7e79", "#747d80", "#81817c", "#787a80", "#7b827c", "#80807e", "#747b77"];
	const GPT_METAL = ["#a5aaa6", "#a9aaa3", "#9da8aa", "#aaa6a5", "#a3a9a2"];
	const EDGE_C = "#15191f";
	const WALL_V = "#c6cfd9";
	const WALL_H = "#98a3af";
	const SELECT_C = "#efc179";
	const RIM_BAND = 1.1;
	const SPR = Math.ceil(2 * RV + 6);

	const PLAYERS = [
		{ id: 0, name: "You", bot: false, hex: "#2ebd85", accent: "#6bf0ba", tileHi: "hsl(156,46%,42%)", tileLo: "hsl(156,50%,29%)", gptTile: "#387861" },
		{ id: 1, name: "Ada", bot: true, hex: "#e05a4f", accent: "#ff8d82", tileHi: "hsl(6,50%,45%)", tileLo: "hsl(6,52%,31%)", gptTile: "#844844" },
		{ id: 2, name: "Bolt", bot: true, hex: "#4a8af4", accent: "#85b4ff", tileHi: "hsl(216,54%,46%)", tileLo: "hsl(216,56%,32%)", gptTile: "#426394" },
		{ id: 3, name: "Lyra", bot: true, hex: "#b266e8", accent: "#d79eff", tileHi: "hsl(278,45%,45%)", tileLo: "hsl(278,48%,31%)", gptTile: "#6d4887" },
	];
	const LEGEND_W = 7;
	const LEGEND_H = 104;
	const LEGEND_X = SIZE - 30;
	const LEGEND_Y = 22;
	const LEGEND_STEPS = 16;

	// Relative potential ramp, low to high; the legend applies a reference span.
	// Both the texel lookup and the legend swatches are precomputed once.
	const PRESS_STOPS = [
		[0, 30, 88, 176],
		[0.3, 32, 200, 214],
		[0.55, 224, 224, 74],
		[0.78, 255, 150, 48],
		[1, 255, 52, 60],
	];

	function buildRamp(stops) {
		const lut = new Uint8ClampedArray(256 * 4);
		let seg = 0;
		for (let i = 0; i < 256; i++) {
			const t = i / 255;
			while (seg < stops.length - 2 && t > stops[seg + 1][0]) seg++;
			const a = stops[seg];
			const b = stops[seg + 1];
			const f = clamp01((t - a[0]) / (b[0] - a[0]));
			lut[i * 4] = a[1] + (b[1] - a[1]) * f;
			lut[i * 4 + 1] = a[2] + (b[2] - a[2]) * f;
			lut[i * 4 + 2] = a[3] + (b[3] - a[3]) * f;
			lut[i * 4 + 3] = 255;
		}
		return lut;
	}

	function clamp01(v) {
		return v < 0 ? 0 : v > 1 ? 1 : v;
	}

	const PRESS_LUT = buildRamp(PRESS_STOPS);
	const PRESS_CSS = (() => {
		const out = [];
		for (let i = 0; i < LEGEND_STEPS; i++) {
			const c = ((i / (LEGEND_STEPS - 1)) * 255) | 0;
			out.push("rgb(" + PRESS_LUT[c * 4] + "," + PRESS_LUT[c * 4 + 1] + "," + PRESS_LUT[c * 4 + 2] + ")");
		}
		return out;
	})();

	function hsl(h, s, l) {
		return "hsl(" + h.toFixed(1) + "," + s.toFixed(1) + "%," + l.toFixed(1) + "%)";
	}

	// Muted grey housings with a small hue and lightness variation per cell, kept
	// out of the geometry layer so layout stays pure data.
	function paintFor(rnd, skin) {
		// The gpt skin mirrors the prototype page: flat tinted tiles and flat
		// metal rotors picked from its exact colour lists.
		if (skin === "gpt") {
			const tile = GPT_HOUSING[(rnd() * GPT_HOUSING.length) | 0];
			const metal = GPT_METAL[(rnd() * GPT_METAL.length) | 0];
			return { tileHi: tile, tileLo: tile, bodyHi: metal, bodyLo: metal };
		}
		const hueTile = 210 + (rnd() * 24 - 12);
		const hueBody = 214 + (rnd() * 20 - 10);
		const sat = 5 + rnd() * 6;
		const light = 43 + rnd() * 13;
		const bodyLight = 23 + rnd() * 8;
		return {
			tileHi: hsl(hueTile, sat, light + 5),
			tileLo: hsl(hueTile, sat, light - 5),
			bodyHi: hsl(hueBody, sat, skin === "glm" ? bodyLight + 8 : bodyLight),
			bodyLo: hsl(hueBody, sat, 23 + rnd() * 8),
		};
	}

	function makeCanvas(w, h, dpr) {
		const c = document.createElement("canvas");
		c.width = Math.max(1, Math.round(w * dpr));
		c.height = Math.max(1, Math.round(h * dpr));
		const ctx = c.getContext("2d");
		ctx.scale(dpr, dpr);
		return { c, ctx };
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
	// Bands are painted in passes across the whole field so a strip's dark edge
	// never lands on top of a neighbour's air at shared cell crossings.
	const HALF_EDGE = HALF + WALL + EDGE;
	// The prototype gpt page paints its corridors in two bands (dark edge, air)
	// with no light material band, so the skin keeps its own pass table.
	function stripPasses(skin, air) {
		if (skin === "gpt") return [[HALF + 2.15, GPT_EDGE_STRIP], [HALF, air]];
		return [[HALF_EDGE, EDGE_C], [HALF + WALL, WALL_H], [HALF, air]];
	}

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

	function paintStrips(ctx, layout, air, skin) {
		const passes = stripPasses(skin, air);
		for (let p = 0; p < passes.length; p++) {
			const half = passes[p][0];
			const color = passes[p][1];
			for (let k = 0; k < layout.valves.length; k++) {
				const v = layout.valves[k];
				ctx.save();
				ctx.translate(v.cx, v.cy);
				for (let s = 0; s < v.strips.length; s++) paintStripBand(ctx, v.strips[s], half, color);
				ctx.restore();
			}
		}
	}

	function paintBackgroundInto(sheet, layout, colors, air, dpr, skin, caseTint) {
		const ctx = sheet.ctx;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = skin === "gpt" ? GPT_GROUT : GROUT;
		ctx.fillRect(0, 0, SIZE, SIZE + G.POUR * 2);
		ctx.save();
		// Shift down once so world coordinates [-POUR, SIZE + POUR] fill the sheet.
		ctx.translate(0, G.POUR);
		const inset = 1.6;
		const tile = S - inset * 2;
		for (let k = 0; k < layout.valves.length; k++) {
			const v = layout.valves[k];
			const x = v.cx - S / 2 + inset;
			const y = v.cy - S / 2 + inset;
			const tintId = caseTint ? caseTint[k] : -1;
			const player = tintId >= 0 && tintId < PLAYERS.length ? PLAYERS[tintId] : null;
			roundRect(ctx, x, y, tile, tile, skin === "gpt" ? 0 : 5);
			if (skin === "gpt" && player) {
				ctx.fillStyle = player.gptTile;
			} else {
				const g = ctx.createLinearGradient(x, y, x, y + tile);
				g.addColorStop(0, player ? player.tileHi : colors[k].tileHi);
				g.addColorStop(1, player ? player.tileLo : colors[k].tileLo);
				ctx.fillStyle = g;
			}
			ctx.fill();
			ctx.lineWidth = player ? 1.6 : 1;
			ctx.strokeStyle = player ? player.accent : skin === "gpt" ? "rgba(25,37,38,0.47)" : "rgba(12,15,19,0.55)";
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(x + 5, y + 1);
			ctx.lineTo(x + tile - 5, y + 1);
			ctx.strokeStyle = skin === "gpt" ? "rgba(255,255,255,0.115)" : "rgba(255,255,255,0.16)";
			ctx.lineWidth = 1;
			ctx.stroke();
			if (skin === "gpt") {
				ctx.fillStyle = "rgba(23,32,33,0.11)";
				ctx.fillRect(x + tile - 1, y + 1, 1, tile - 2);
			}
		}
		for (let k = 0; k < layout.valves.length; k++) {
			const v = layout.valves[k];
			const tintId = caseTint ? caseTint[k] : -1;
			const player = tintId >= 0 && tintId < PLAYERS.length ? PLAYERS[tintId] : null;
			if (skin === "gpt" && !player) continue;
			ctx.beginPath();
			ctx.arc(v.cx, v.cy, RV + (player ? 2 : 1.1), 0, TAU);
			ctx.lineWidth = player ? 2.4 : 2.6;
			ctx.strokeStyle = player ? player.accent : "rgba(14,17,22,0.5)";
			ctx.stroke();
		}
		paintStrips(ctx, layout, air, skin);
		for (let k = 0; k < layout.valves.length; k++) {
			const v = layout.valves[k];
			if (skin === "gpt") continue;
			for (let sx = -1; sx <= 1; sx += 2) {
				for (let sy = -1; sy <= 1; sy += 2) {
					const bx = v.cx + sx * (S / 2 - 10.5);
					const by = v.cy + sy * (S / 2 - 10.5);
					ctx.beginPath();
					ctx.arc(bx, by, 4.4, 0, TAU);
					ctx.fillStyle = "rgba(20,24,30,0.55)";
					ctx.fill();
					ctx.beginPath();
					ctx.arc(bx, by, 3.2, 0, TAU);
					const screw = ctx.createLinearGradient(bx - 3, by - 3, bx + 3, by + 3);
					screw.addColorStop(0, "rgba(255,255,255,0.28)");
					screw.addColorStop(1, "rgba(0,0,0,0.28)");
					ctx.fillStyle = skin === "combined" ? "#8b949c" : screw;
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
		ctx.restore();
		return sheet.c;
	}

	function paintBackground(layout, colors, air, dpr, skin, caseTint) {
		const sheet = makeCanvas(SIZE, SIZE + G.POUR * 2, dpr);
		paintBackgroundInto(sheet, layout, colors, air, dpr, skin, caseTint);
		return sheet;
	}

	// Rotor sprite: silhouette and body, then the clipped passages stroked from
	// the exact collision primitives.
	function paintRotorInto(sheet, v, colors, air, dpr, skin) {
		const ctx = sheet.ctx;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, SPR, SPR);
		ctx.save();
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
		ctx.strokeStyle = skin === "gpt" ? GPT_RIM : EDGE_C;
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(0, 0, RV - 2.9, 0, TAU);
		ctx.lineWidth = skin === "gpt" ? 0.8 : 1;
		ctx.strokeStyle = skin === "gpt" ? "rgba(255,255,255,0.24)" : "rgba(255,255,255,0.12)";
		ctx.stroke();
		ctx.beginPath();
		const ticks = skin === "gpt" ? 0 : skin === "glm" ? 26 : 24;
		for (let k = 0; k < ticks; k++) {
			const a = (k / ticks) * TAU;
			ctx.moveTo(Math.cos(a) * RV * 0.86, Math.sin(a) * RV * 0.86);
			ctx.lineTo(Math.cos(a) * RV * 0.93, Math.sin(a) * RV * 0.93);
		}
		ctx.lineWidth = 1.4;
		ctx.strokeStyle = skin === "glm" ? "rgba(10,13,17,0.4)" : "rgba(255,255,255,0.1)";
		ctx.stroke();
		ctx.save();
		ctx.beginPath();
		ctx.arc(0, 0, RV, 0, TAU);
		ctx.clip();
		// The prototype gpt page strokes passages with a thin dark edge and no
		// light material band, and rounds its bends.
		ctx.lineCap = skin === "gpt" ? "round" : "butt";
		ctx.lineJoin = skin === "gpt" ? "round" : "miter";
		const chamber = v.chamberR;
		if (chamber > 0) {
			ctx.beginPath();
			ctx.arc(0, 0, chamber + (skin === "gpt" ? 2.5 : WALL + EDGE), 0, TAU);
			ctx.fillStyle = skin === "gpt" ? GPT_EDGE : EDGE_C;
			ctx.fill();
		}
		ctx.strokeStyle = skin === "gpt" ? GPT_EDGE : EDGE_C;
		ctx.lineWidth = HALF * 2 + (skin === "gpt" ? 4.3 : WALL * 2 + EDGE * 2);
		ctx.stroke(v.path);
		if (skin !== "gpt") {
			if (chamber > 0) {
				ctx.beginPath();
				ctx.arc(0, 0, chamber + WALL, 0, TAU);
				ctx.fillStyle = WALL_V;
				ctx.fill();
			}
			ctx.strokeStyle = WALL_V;
			ctx.lineWidth = HALF * 2 + WALL * 2;
			ctx.stroke(v.path);
		}
		if (chamber > 0) {
			ctx.beginPath();
			ctx.arc(0, 0, chamber, 0, TAU);
			ctx.fillStyle = air;
			ctx.fill();
		}
		ctx.strokeStyle = air;
		ctx.lineWidth = HALF * 2;
		ctx.stroke(v.path);
		ctx.restore();
		ctx.restore();
		return sheet.c;
	}

	function paintRotor(v, colors, air, dpr, skin) {
		const sheet = makeCanvas(SPR, SPR, dpr);
		paintRotorInto(sheet, v, colors, air, dpr, skin);
		return sheet;
	}

	const PALETTES = {
		glm: ["#ff655b", "#ffcf32", "#16cbb1", "#548dff", "#ed43dc", "#7cdd30"],
		combined: ["#f07a5f", "#e9b64b", "#4fb8ab", "#7f93dd", "#d978b4", "#8cbf5a"],
		gpt: ["#ff8668", "#f6ca64", "#79d5c9", "#a9b8f4", "#e7a1cd", "#abd979"],
	};

	// Grain paint per skin: shadow tint and offset, rim stroke and highlight.
	// Bodies are drawn a hair above the collision radius so the varied grain
	// sizes stay readable where they touch a wall.
	const GRAIN_STYLE = {
		glm: { shadow: "rgba(14,24,25,0.32)", grow: 0.7, ox: 0.6, oy: 0.8, rim: EDGE_C, rimW: 0.65, hl: 0.27, hlMin: 0, hlFill: "rgba(255,255,255,0.65)" },
		combined: { shadow: "rgba(14,24,25,0.32)", grow: 0.7, ox: 0.6, oy: 0.8, rim: EDGE_C, rimW: 0.65, hl: 0.27, hlMin: 0, hlFill: "rgba(255,255,255,0.65)" },
		gpt: { shadow: "rgba(14,24,25,0.42)", grow: 0.65, ox: 0.8, oy: 1.1, rim: "rgba(20,32,33,0.48)", rimW: 0.75, hl: 0, hlMin: 0.7, hlFill: "rgba(255,255,255,0.85)" },
	};

	function buildScene(layout, air, dpr, skin = "glm", caseTint = null) {
		const rnd = G.rng(layout.seed * 2654435761);
		const colors = layout.valves.map(() => paintFor(rnd, skin));
		const rotorSheets = layout.valves.map((v, k) => paintRotor(v, colors[k], air, dpr, skin));
		const bgSheet = paintBackground(layout, colors, air, dpr, skin, caseTint);
		return {
			bg: bgSheet.c,
			bgSheet,
			sprites: rotorSheets.map(sheet => sheet.c),
			rotorSheets,
			colors,
			air,
			skin,
			palette: PALETTES[skin],
			grain: GRAIN_STYLE[skin],
			sprite: SPR,
			dpr,
		};
	}

	function rebuildBackground(scene, layout, caseTint) {
		paintBackgroundInto(scene.bgSheet, layout, scene.colors, scene.air, scene.dpr, scene.skin, caseTint);
	}

	function rebuildRotor(scene, layout, index) {
		if (index < 0 || index >= layout.valves.length) return;
		paintRotorInto(scene.rotorSheets[index], layout.valves[index], scene.colors[index], scene.air, scene.dpr, scene.skin);
	}

	function renderScene(ctx, layout, scene) {
		ctx.clearRect(0, -G.POUR, SIZE, SIZE + G.POUR * 2);
		ctx.drawImage(scene.bg, 0, -G.POUR, SIZE, SIZE + G.POUR * 2);
		const half = scene.sprite / 2;
		const valves = layout.valves;
		for (let k = 0; k < valves.length; k++) {
			const v = valves[k];
			if (v.angle === 0) {
				ctx.drawImage(scene.sprites[k], v.cx - half, v.cy - half, scene.sprite, scene.sprite);
				continue;
			}
			ctx.save();
			ctx.translate(v.cx, v.cy);
			ctx.rotate(v.angle);
			ctx.drawImage(scene.sprites[k], -half, -half, scene.sprite, scene.sprite);
			ctx.restore();
		}
	}

	function renderSelection(ctx, layout, selected) {
		if (selected < 0 || selected >= layout.valves.length) return;
		const v = layout.valves[selected];
		roundRect(ctx, v.cx - S / 2 + 2.2, v.cy - S / 2 + 2.2, S - 4.4, S - 4.4, 5);
		ctx.strokeStyle = SELECT_C;
		ctx.lineWidth = 1.8;
		ctx.stroke();
	}

	function renderDrag(ctx, layout, sim, drag) {
		if (!drag || !drag.active || drag.cell < 0 || drag.cell >= layout.valves.length) return;
		const v = layout.valves[drag.cell];
		const target = sim.target[drag.cell];
		ctx.save();
		ctx.beginPath();
		ctx.arc(v.cx, v.cy, RV + 3.2, 0, TAU);
		ctx.strokeStyle = "rgba(239,193,121,0.55)";
		ctx.lineWidth = 1.4;
		ctx.stroke();
		const ux = Math.cos(target - Math.PI / 2);
		const uy = Math.sin(target - Math.PI / 2);
		ctx.beginPath();
		ctx.moveTo(v.cx + ux * (RV - 3), v.cy + uy * (RV - 3));
		ctx.lineTo(v.cx + ux * (RV + 5.5), v.cy + uy * (RV + 5.5));
		ctx.strokeStyle = SELECT_C;
		ctx.lineWidth = 2.4;
		ctx.stroke();
		ctx.restore();
	}

	// Goal bottles carry a hold-completion arc and a cached status tag so players
	// can watch progress directly on the field with zero per-frame allocations.
	function renderGoals(ctx, layout, game) {
		if (!game || game.mode !== "game") return;
		const quests = game.quests;
		ctx.save();
		ctx.font = "bold 8px system-ui, sans-serif";
		ctx.textBaseline = "middle";
		ctx.textAlign = "left";
		for (let q = 0; q < quests.length; q++) {
			const quest = quests[q];
			if (quest.owner < 0) continue;
			const player = PLAYERS[quest.owner];
			for (let s = 0; s < quest.cellCount; s++) {
				const idx = quest.cells[s];
				const v = layout.valves[idx];
				if (quest.holdRatio > 0) {
					ctx.beginPath();
					ctx.arc(v.cx, v.cy, RV + 3.4, -Math.PI / 2, -Math.PI / 2 + TAU * quest.holdRatio);
					ctx.strokeStyle = player.accent;
					ctx.lineWidth = 2.8;
					ctx.stroke();
				}
				const tag = quest.cellTags[s];
				if (!tag) continue;
				const w = tag.length * 4.5 + 7;
				const tx = v.cx - S / 2 + 3.5;
				const ty = v.cy + S / 2 - 14.5;
				roundRect(ctx, tx, ty, w, 11, 3);
				ctx.fillStyle = "rgba(10,14,20,0.82)";
				ctx.fill();
				ctx.strokeStyle = player.accent;
				ctx.lineWidth = 0.9;
				ctx.stroke();
				ctx.fillStyle = player.accent;
				ctx.fillText(tag, tx + 3.5, ty + 5.6);
			}
		}
		ctx.restore();
	}

	function renderAirMap(map, layout) {
		const w = map.w;
		const h = map.h;
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

	// Batched by palette entry so 1,000 grains still issue a handful of draw calls
	// and zero allocations. Bodies use the physical radius plus a hair, so the
	// varied grain sizes read clearly and may kiss a wall edge.
	function renderGrains(ctx, sim, scene) {
		const n = sim.count;
		if (!n) return;
		const palette = scene.palette;
		const st = scene.grain;
		const x = sim.x;
		const y = sim.y;
		const r = sim.r;
		const col = sim.color;
		ctx.beginPath();
		for (let k = 0; k < n; k++) {
			const radius = r[k] + 0.2 + st.grow;
			ctx.moveTo(x[k] + st.ox + radius, y[k] + st.oy);
			ctx.arc(x[k] + st.ox, y[k] + st.oy, radius, 0, TAU);
		}
		ctx.fillStyle = st.shadow;
		ctx.fill();
		for (let c = 0; c < palette.length; c++) {
			let any = false;
			ctx.beginPath();
			for (let k = 0; k < n; k++) {
				if (col[k] !== c) continue;
				const xk = x[k];
				const yk = y[k];
				const rk = r[k] + 0.2;
				ctx.moveTo(xk + rk, yk);
				ctx.arc(xk, yk, rk, 0, TAU);
				any = true;
			}
			if (!any) continue;
			ctx.fillStyle = palette[c];
			ctx.fill();
		}
		ctx.fillStyle = st.hlFill;
		ctx.beginPath();
		for (let k = 0; k < n; k++) {
			const rk = r[k] + 0.2;
			let hr = rk * st.hl;
			if (hr < st.hlMin) hr = st.hlMin;
			const hx = x[k] - rk * 0.28;
			const hy = y[k] - rk * 0.28;
			ctx.moveTo(hx + hr, hy);
			ctx.arc(hx, hy, hr, 0, TAU);
		}
		ctx.fill();
		ctx.strokeStyle = st.rim;
		ctx.lineWidth = st.rimW;
		ctx.beginPath();
		for (let k = 0; k < n; k++) {
			const xk = x[k];
			const yk = y[k];
			const rk = r[k] + 0.2;
			ctx.moveTo(xk + rk, yk);
			ctx.arc(xk, yk, rk, 0, TAU);
		}
		ctx.stroke();
	}

	// Kinetic pressure preview: local air population appears as a cyan tint.
	function renderPressure(ctx, p) {
		ctx.beginPath();
		for (let k = 0; k < p.count; k++) {
			ctx.moveTo(p.x[k] + 0.65, p.y[k]);
			ctx.arc(p.x[k], p.y[k], 0.65, 0, TAU);
		}
		ctx.fillStyle = "rgba(30,165,210,0.8)";
		ctx.fill();
	}

	// Potential overlay: one texel per gas cell. A linear Pa-equivalent span
	// changes the legend, not the normalized colors or the simulation.
	function makeFieldMap(nx, ny) {
		const c = document.createElement("canvas");
		c.width = nx;
		c.height = ny;
		const ctx = c.getContext("2d");
		return { canvas: c, ctx, img: ctx.createImageData(nx, ny), nx, ny };
	}

	function renderField(map, gas) {
		const data = map.img.data;
		const lut = PRESS_LUT;
		const air = gas.air;
		const p = gas.p;
		const n = air.length;
		for (let k = 0, o = 0; k < n; k++, o += 4) {
			if (!gas.pins || !air[k]) {
				data[o + 3] = 0;
				continue;
			}
			const v = clamp01(p[k] > 0 ? p[k] : 0);
			const q = ((v * 255) | 0) * 4;
			data[o] = lut[q];
			data[o + 1] = lut[q + 1];
			data[o + 2] = lut[q + 2];
			data[o + 3] = lut[q + 3];
		}
		map.ctx.putImageData(map.img, 0, 0);
	}

	function renderPressureLegend(ctx, spanLabel) {
		const x = LEGEND_X;
		const y = LEGEND_Y;
		ctx.save();
		roundRect(ctx, x - 46, y - 16, LEGEND_W + 51, LEGEND_H + 30, 4);
		ctx.fillStyle = "rgba(10,14,20,0.72)";
		ctx.fill();
		const step = LEGEND_H / LEGEND_STEPS;
		for (let i = 0; i < LEGEND_STEPS; i++) {
			ctx.fillStyle = PRESS_CSS[i];
			ctx.fillRect(x, y + i * step, LEGEND_W, step + 0.7);
		}
		ctx.fillStyle = "rgba(226,236,245,0.95)";
		ctx.font = "10px system-ui, sans-serif";
		ctx.textAlign = "right";
		ctx.textBaseline = "middle";
		ctx.fillText("eq. Pa", x + LEGEND_W, y - 9);
		ctx.fillText("0", x - 3, y + 4);
		ctx.fillText(spanLabel, x - 3, y + LEGEND_H - 4);
		ctx.restore();
	}

	// One mouth marker per column: an arrow pointing into the field for a source
	// and out of it for a vent, with sealed mouths dimmed.
	function renderInlets(ctx, inlets, hover) {
		for (let k = 0; k < inlets.count; k++) {
			const x = inlets.x[k];
			const y = inlets.y[k];
			const active = k === hover;
			const open = inlets.open[k] === 1;
			const inward = inlets.side[k] === I.TOP ? 1 : -1;
			ctx.beginPath();
			ctx.arc(x, y, 6.2, 0, TAU);
			ctx.fillStyle = active ? "rgba(240,248,255,0.34)" : "rgba(8,12,18,0.46)";
			ctx.fill();
			if (open) {
				ctx.beginPath();
				ctx.moveTo(x, y + inward * 4.2);
				ctx.lineTo(x - 3.3, y - inward * 2.2);
				ctx.lineTo(x + 3.3, y - inward * 2.2);
				ctx.closePath();
				ctx.fillStyle = inlets.level[k] === I.HIGH ? "#ff8a5c" : "#5cc8ff";
				ctx.fill();
			} else {
				ctx.beginPath();
				ctx.moveTo(x - 2.6, y - 2.6);
				ctx.lineTo(x + 2.6, y + 2.6);
				ctx.moveTo(x + 2.6, y - 2.6);
				ctx.lineTo(x - 2.6, y + 2.6);
				ctx.lineWidth = 1.4;
				ctx.strokeStyle = "rgba(190,202,214,0.6)";
				ctx.stroke();
			}
			if (!active) continue;
			ctx.beginPath();
			ctx.arc(x, y, 7.6, 0, TAU);
			ctx.lineWidth = 1.2;
			ctx.strokeStyle = SELECT_C;
			ctx.stroke();
			// Hovering names the mouth: polarity and whether it holds the field.
			const source = inlets.level[k] === I.HIGH;
			const label = (source ? "source" : "vent") + (open ? "" : " sealed");
			ctx.font = "7px system-ui, sans-serif";
			ctx.textBaseline = "middle";
			ctx.textAlign = x > SIZE - 90 ? "right" : "left";
			const tx = x > SIZE - 90 ? x - 10 : x + 10;
			// Fixed estimate instead of measureText: no per-frame allocation.
			const width = label.length * 3.9;
			roundRect(ctx, ctx.textAlign === "right" ? tx - width - 3 : tx - 3, y - 6, width + 6, 12, 3);
			ctx.fillStyle = "rgba(10,14,20,0.72)";
			ctx.fill();
			ctx.fillStyle = source ? "#ffb08c" : "#a8e2ff";
			ctx.fillText(label, tx, y);
		}
	}

	function makeAirMap(cell) {
		const w = Math.ceil(SIZE / cell);
		const h = Math.ceil((SIZE + G.POUR * 2) / cell);
		const c = document.createElement("canvas");
		c.width = w;
		c.height = h;
		const ctx = c.getContext("2d");
		return { canvas: c, ctx, img: ctx.createImageData(w, h), cell, w, h };
	}

	return {
		SPR,
		PLAYERS,
		PALETTES,
		buildScene,
		rebuildBackground,
		rebuildRotor,
		renderScene,
		renderSelection,
		renderDrag,
		renderGoals,
		makeAirMap,
		renderAirMap,
		renderGrains,
		renderPressure,
		makeFieldMap,
		renderField,
		renderPressureLegend,
		renderInlets,
		makeCanvas,
	};
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveRender;
