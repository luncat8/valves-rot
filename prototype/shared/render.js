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
		{ id: 4, name: "Kai", bot: true, hex: "#e0a13c", accent: "#ffc978", tileHi: "hsl(36,52%,46%)", tileLo: "hsl(36,54%,31%)", gptTile: "#8a6a35" },
	];
	// Gauge geometry for a vent bottle: a 0..1 rail down the right of its cell.
	const GAUGE_W = 5;
	const GAUGE_H = S - 24;
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

	// Drag dial. The rotor keeps quarter-turn detents, so the gesture is drawn as
	// an arc the hand winds around a fixed ring, a bold notch on the detent the
	// rotor is committed to, and a dot where the hand grips the rim; a wobble is
	// a short arc and never a turn. A hub pull shows its own horizontal rail
	// instead, with one tick per detent and a knob under the hand.
	function renderDrag(ctx, layout, sim, drag) {
		if (!drag || !drag.active || drag.cell < 0 || drag.cell >= layout.valves.length) return;
		const v = layout.valves[drag.cell];
		const base = drag.baseTarget;
		const target = sim.target[drag.cell];
		ctx.save();
		if (drag.hub) {
			const rail = S / 2 - 5;
			ctx.beginPath();
			ctx.moveTo(v.cx - rail, v.cy);
			ctx.lineTo(v.cx + rail, v.cy);
			ctx.strokeStyle = "rgba(239,193,121,0.3)";
			ctx.lineWidth = 1;
			ctx.stroke();
			for (let n = -3; n <= 3; n++) {
				const tx = v.cx + n * drag.tick;
				if (n === 0 || Math.abs(tx - v.cx) > rail) continue;
				ctx.beginPath();
				ctx.moveTo(tx, v.cy - 2.6);
				ctx.lineTo(tx, v.cy + 2.6);
				ctx.strokeStyle = "rgba(239,193,121,0.4)";
				ctx.lineWidth = 1;
				ctx.stroke();
			}
			const pull = Math.max(-rail, Math.min(rail, drag.pull));
			ctx.beginPath();
			ctx.arc(v.cx + pull, v.cy, 2.6, 0, TAU);
			ctx.fillStyle = "#fff6e4";
			ctx.fill();
		} else {
			const radius = RV + 4.6;
			ctx.beginPath();
			ctx.arc(v.cx, v.cy, radius, 0, TAU);
			ctx.strokeStyle = "rgba(239,193,121,0.26)";
			ctx.lineWidth = 1;
			ctx.stroke();
			for (let q = 0; q < 4; q++) {
				const a = q * G.HALF_PI;
				const ax = Math.cos(a);
				const ay = Math.sin(a);
				ctx.beginPath();
				ctx.moveTo(v.cx + ax * (radius + 1.2), v.cy + ay * (radius + 1.2));
				ctx.lineTo(v.cx + ax * (radius + 3.4), v.cy + ay * (radius + 3.4));
				ctx.strokeStyle = "rgba(239,193,121,0.38)";
				ctx.lineWidth = 1.1;
				ctx.stroke();
			}
			if (Math.abs(drag.sweep) > 0.004) {
				ctx.beginPath();
				ctx.arc(v.cx, v.cy, radius, base, base + drag.sweep, drag.sweep < 0);
				ctx.strokeStyle = "rgba(239,193,121,0.82)";
				ctx.lineWidth = 3;
				ctx.stroke();
			}
			const hx = drag.lastX - v.cx;
			const hy = drag.lastY - v.cy;
			const reach = Math.hypot(hx, hy);
			if (reach > 1) {
				ctx.beginPath();
				ctx.arc(v.cx + (hx / reach) * radius, v.cy + (hy / reach) * radius, 2.4, 0, TAU);
				ctx.fillStyle = "#fff6e4";
				ctx.fill();
			}
		}
		const ux = Math.cos(target);
		const uy = Math.sin(target);
		ctx.beginPath();
		ctx.moveTo(v.cx + ux * (RV - 3), v.cy + uy * (RV - 3));
		ctx.lineTo(v.cx + ux * (RV + 5.4), v.cy + uy * (RV + 5.4));
		ctx.strokeStyle = SELECT_C;
		ctx.lineWidth = 2.6;
		ctx.stroke();
		ctx.restore();
	}

	// Goal bottles carry a hold-completion arc and a cached status tag so players
	// can watch progress directly on the field with zero per-frame allocations.
	function drawHoldArc(ctx, v, ratio, player) {
		if (!(ratio > 0)) return;
		ctx.beginPath();
		ctx.arc(v.cx, v.cy, RV + 3.4, -Math.PI / 2, -Math.PI / 2 + TAU * ratio);
		ctx.strokeStyle = player.accent;
		ctx.lineWidth = 2.8;
		ctx.stroke();
	}

	// Cached one-line status pinned to the cell's lower left. Callers set the font.
	function drawCellTag(ctx, v, tag, player) {
		if (!tag) return;
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
				const v = layout.valves[quest.cells[s]];
				drawHoldArc(ctx, v, quest.holdRatio, player);
				drawCellTag(ctx, v, quest.cellTags[s], player);
			}
		}
		ctx.restore();
	}

	// A vent bottle is an instrument: a 0..1 rail beside the rotor with the target
	// band marked in the owner's color and a needle on the live chamber pressure.
	// The rail sits just outside the rotor rim, so the hold arc passes under it.
	function drawGauge(ctx, v, seat, player) {
		const x = v.cx + RV + 0.6;
		const y = v.cy - GAUGE_H / 2;
		roundRect(ctx, x, y, GAUGE_W, GAUGE_H, 2);
		ctx.fillStyle = "rgba(8,12,18,0.78)";
		ctx.fill();
		const bandY = y + (1 - seat.hi) * GAUGE_H;
		const bandH = Math.max(2, (seat.hi - seat.lo) * GAUGE_H);
		ctx.fillStyle = seat.ok ? player.accent : player.hex;
		ctx.globalAlpha = seat.ok ? 0.85 : 0.45;
		ctx.fillRect(x + 0.6, bandY, GAUGE_W - 1.2, bandH);
		ctx.globalAlpha = 1;
		const ny = y + (1 - (seat.pressure < 0 ? 0 : seat.pressure > 1 ? 1 : seat.pressure)) * GAUGE_H;
		ctx.beginPath();
		ctx.moveTo(x - 2.4, ny);
		ctx.lineTo(x + GAUGE_W + 2.4, ny);
		ctx.strokeStyle = seat.ok ? "#fff6e4" : "#ff7d6b";
		ctx.lineWidth = 1.6;
		ctx.stroke();
	}

	// The seat that holds the turn wears a wider ring on its collector, so the
	// turn is visible on the field without reading the panel.
	function drawTurnRing(ctx, v, player) {
		ctx.beginPath();
		ctx.arc(v.cx, v.cy, RV + 7, 0, TAU);
		ctx.strokeStyle = player.accent;
		ctx.globalAlpha = 0.7;
		ctx.lineWidth = 1.2;
		ctx.stroke();
		ctx.globalAlpha = 1;
	}

	function renderVents(ctx, layout, game) {
		if (!game || game.mode !== "vent") return;
		const vent = game.vent;
		ctx.save();
		for (let s = 0; s < vent.count; s++) {
			const seat = vent.seats[s];
			if (seat.bottle < 0) continue;
			const player = PLAYERS[seat.player];
			const v = layout.valves[seat.bottle];
			drawHoldArc(ctx, v, seat.holdRatio, player);
			drawGauge(ctx, v, seat, player);
			if (s === vent.turn) drawTurnRing(ctx, v, player);
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

	// One texel per gas cell. The pressure is state: even a machine with every
	// mouth sealed keeps the air it had, so the field is always drawn.
	function renderField(map, gas) {
		const data = map.img.data;
		const lut = PRESS_LUT;
		const air = gas.air;
		const p = gas.p;
		const n = air.length;
		for (let k = 0, o = 0; k < n; k++, o += 4) {
			if (!air[k]) {
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

	// A dealt mouth that opens onto a mapped route wears the owner's casing — a
	// wide stem down to the field edge and a tinted disc — so each player can read
	// their two in and two out at a glance even before `renderInletBadges`
	// brackets the column ends.
	function drawMouthStem(ctx, x, y, top, open, player) {
		ctx.beginPath();
		ctx.moveTo(x, y + (top ? 5.5 : -5.5));
		ctx.lineTo(x, top ? 0 : SIZE);
		ctx.strokeStyle = player.accent;
		ctx.globalAlpha = open ? 0.34 : 0.12;
		ctx.lineWidth = 7;
		ctx.stroke();
		ctx.globalAlpha = 1;
	}

	function drawMouthDisc(ctx, x, y, k, inlets, active, open, inward, player) {
		ctx.beginPath();
		ctx.arc(x, y, 6.2, 0, TAU);
		ctx.fillStyle = player ? player.hex : active ? "rgba(240,248,255,0.34)" : "rgba(8,12,18,0.46)";
		ctx.globalAlpha = player ? (open ? 0.72 : 0.3) : 1;
		ctx.fill();
		ctx.globalAlpha = 1;
		if (player) {
			ctx.beginPath();
			ctx.arc(x, y, 6.2, 0, TAU);
			ctx.strokeStyle = player.accent;
			ctx.lineWidth = active ? 2.2 : 1.4;
			ctx.stroke();
		}
		if (open) {
			ctx.beginPath();
			ctx.moveTo(x, y + inward * 4.2);
			ctx.lineTo(x - 3.3, y - inward * 2.2);
			ctx.lineTo(x + 3.3, y - inward * 2.2);
			ctx.closePath();
			ctx.fillStyle = player ? player.accent : inlets.level[k] === I.HIGH ? "#ff8a5c" : "#5cc8ff";
			ctx.fill();
			return;
		}
		ctx.beginPath();
		ctx.moveTo(x - 2.6, y - 2.6);
		ctx.lineTo(x + 2.6, y + 2.6);
		ctx.moveTo(x + 2.6, y - 2.6);
		ctx.lineTo(x - 2.6, y + 2.6);
		ctx.lineWidth = 1.4;
		ctx.strokeStyle = player ? player.accent : "rgba(190,202,214,0.6)";
		ctx.globalAlpha = player ? 0.7 : 1;
		ctx.stroke();
		ctx.globalAlpha = 1;
	}

	// A mouth with no route to a collector is a passive boundary hole: an owner
	// ring only. A stem or a flow arrow there would promise a control the field
	// does not follow.
	function drawMouthMark(ctx, x, y, active, player) {
		ctx.beginPath();
		ctx.arc(x, y, 4.6, 0, TAU);
		ctx.lineWidth = active ? 1.8 : 1.2;
		ctx.strokeStyle = player.accent;
		ctx.globalAlpha = 0.55;
		ctx.stroke();
		ctx.globalAlpha = 1;
	}

	// Hovering names the mouth: whose it is, its in/out role, whether it holds the
	// field and, when it has no route, that it cannot move the collector.
	function drawMouthLabel(ctx, x, y, player, source, open, linked) {
		const label = (player ? player.name + " " : "") + (source ? "in" : "out") + (open ? "" : " sealed") + (linked ? "" : " · no route");
		ctx.font = "7px system-ui, sans-serif";
		ctx.textBaseline = "middle";
		ctx.textAlign = x > SIZE - 90 ? "right" : "left";
		const tx = x > SIZE - 90 ? x - 10 : x + 10;
		// Fixed estimate instead of measureText: no per-frame allocation.
		const width = label.length * 3.9;
		roundRect(ctx, ctx.textAlign === "right" ? tx - width - 3 : tx - 3, y - 6, width + 6, 12, 3);
		ctx.fillStyle = "rgba(10,14,20,0.72)";
		ctx.fill();
		ctx.fillStyle = player ? player.accent : source ? "#ffb08c" : "#a8e2ff";
		ctx.fillText(label, tx, y);
	}

	// One marker per mouth: an arrow into the field while it is open, a cross while
	// sealed, and the hover ring names it.
	function renderInlets(ctx, inlets, hover) {
		for (let k = 0; k < inlets.count; k++) {
			if (!inlets.present[k]) continue;
			const x = inlets.x[k];
			const y = inlets.y[k];
			const active = k === hover;
			const open = inlets.open[k] === 1;
			const top = inlets.side[k] === I.TOP;
			const inward = top ? 1 : -1;
			const owner = inlets.owner[k];
			const player = owner >= 0 ? PLAYERS[owner] : null;
			const linked = inlets.linked[k] === 1;
			if (player && linked) drawMouthStem(ctx, x, y, top, open, player);
			if (player && !linked) drawMouthMark(ctx, x, y, active, player);
			else drawMouthDisc(ctx, x, y, k, inlets, active, open, inward, player);
			if (!active) continue;
			ctx.beginPath();
			ctx.arc(x, y, 7.6, 0, TAU);
			ctx.lineWidth = 1.2;
			ctx.strokeStyle = SELECT_C;
			ctx.stroke();
			drawMouthLabel(ctx, x, y, player, inlets.level[k] === I.HIGH, open, linked);
		}
	}

	// A dealt mouth is bracketed by owner-coloured plates on both band edges,
	// above the grain piles that share the band, so a player always finds their
	// own two in and two out mouths even under a pile. An unlinked mouth keeps
	// only the band-edge plate: the field-edge tab would draw a pipe it lacks.
	function renderInletBadges(ctx, inlets, hover) {
		ctx.globalAlpha = 1;
		for (let k = 0; k < inlets.count; k++) {
			const owner = inlets.owner[k];
			if (owner < 0 || !inlets.present[k]) continue;
			const player = PLAYERS[owner];
			const top = inlets.side[k] === I.TOP;
			const x = inlets.x[k];
			ctx.fillStyle = "rgba(8,12,18,0.72)";
			roundRect(ctx, x - 7, top ? -G.POUR + 0.6 : SIZE + G.POUR - 4.6, 14, 4, 1.6);
			ctx.fill();
			ctx.globalAlpha = inlets.open[k] === 1 ? 1 : 0.4;
			ctx.fillStyle = k === hover ? SELECT_C : player.accent;
			roundRect(ctx, x - 6, top ? -G.POUR + 1.2 : SIZE + G.POUR - 4, 12, 2.8, 1.3);
			ctx.fill();
			if (inlets.linked[k] === 1) {
				roundRect(ctx, x - 6, top ? -4 : SIZE + 1.2, 12, 2.8, 1.3);
				ctx.fill();
			}
			ctx.globalAlpha = 1;
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
		renderVents,
		makeAirMap,
		renderAirMap,
		renderGrains,
		renderPressure,
		makeFieldMap,
		renderField,
		renderPressureLegend,
		renderInlets,
		renderInletBadges,
		makeCanvas,
	};
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveRender;
