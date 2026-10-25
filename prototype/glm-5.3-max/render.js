const ValveRenderer = (() => {
	"use strict";
	const { N, S, SIZE, RV, CW, WALL, EDGE, TAU } = ValveEngine;
	const EDGE_C = "#15191f";
	const GROUT = "#1a1e24";
	const WALL_V = "#c6cfd9";
	const WALL_H = "#98a3af";
	const HALF_AIR = CW / 2;
	const HALF_WALL = CW / 2 + WALL;
	const HALF_OUT = CW / 2 + WALL + EDGE;
	const RB = RV - 0.4;
	const SPR = Math.ceil(2 * RV + 5);
	function mk(w, h, dpr) {
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
	function drawBackground(w, air, dpr) {
		const { c, ctx } = mk(SIZE, SIZE, dpr);
		ctx.fillStyle = GROUT;
		ctx.fillRect(0, 0, SIZE, SIZE);
		const inset = 1.6;
		const tile = S - inset * 2;
		for (const v of w.valves) {
			const x = v.cx - S / 2 + inset;
			const y = v.cy - S / 2 + inset;
			const g = ctx.createLinearGradient(x, y, x, y + tile);
			g.addColorStop(0, v.tileHi);
			g.addColorStop(1, v.tileLo);
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
			ctx.beginPath();
			ctx.arc(v.cx, v.cy, RV + 1.1, 0, TAU);
			ctx.lineWidth = 2.6;
			ctx.strokeStyle = "rgba(14,17,22,0.5)";
			ctx.stroke();
		}
		for (const v of w.valves) {
			for (let d = 0; d < 4; d++) {
				const a = (d * Math.PI) / 2;
				ctx.save();
				ctx.translate(v.cx, v.cy);
				ctx.rotate(a);
				const x0 = RV - 2.6;
				const x1 = S / 2 + 2.6;
				ctx.fillStyle = EDGE_C;
				ctx.fillRect(x0, -HALF_OUT, x1 - x0, HALF_OUT * 2);
				ctx.fillStyle = WALL_H;
				ctx.fillRect(x0, -HALF_WALL, x1 - x0, HALF_WALL * 2);
				ctx.fillStyle = air;
				ctx.fillRect(x0, -HALF_AIR, x1 - x0, HALF_AIR * 2);
				ctx.restore();
			}
		}
		for (const v of w.valves) {
			for (const sx of [-1, 1])
				for (const sy of [-1, 1]) {
					const bx = v.cx + sx * (S / 2 - 10.5);
					const by = v.cy + sy * (S / 2 - 10.5);
					ctx.beginPath();
					ctx.arc(bx, by, 4.4, 0, TAU);
					ctx.fillStyle = "rgba(20,24,30,0.55)";
					ctx.fill();
					ctx.beginPath();
					ctx.arc(bx, by, 3.2, 0, TAU);
					const bg = ctx.createLinearGradient(bx - 3, by - 3, bx + 3, by + 3);
					bg.addColorStop(0, "rgba(255,255,255,0.28)");
					bg.addColorStop(1, "rgba(0,0,0,0.28)");
					ctx.fillStyle = bg;
					ctx.fill();
					ctx.beginPath();
					ctx.moveTo(bx - 2.1, by);
					ctx.lineTo(bx + 2.1, by);
					ctx.lineWidth = 1.1;
					ctx.strokeStyle = "rgba(16,20,26,0.65)";
					ctx.stroke();
				}
		}
		return c;
	}
	function drawValve(v, air, dpr) {
		const { c, ctx } = mk(SPR, SPR, dpr);
		ctx.translate(SPR / 2, SPR / 2);
		const g = ctx.createRadialGradient(
			-RB * 0.34,
			-RB * 0.4,
			RB * 0.08,
			0,
			0,
			RB * 1.05,
		);
		g.addColorStop(0, v.bodyHi);
		g.addColorStop(1, v.bodyLo);
		ctx.beginPath();
		ctx.arc(0, 0, RB, 0, TAU);
		ctx.fillStyle = g;
		ctx.fill();
		ctx.beginPath();
		ctx.arc(0, 0, RB - 1.1, 0, TAU);
		ctx.lineWidth = 2.2;
		ctx.strokeStyle = EDGE_C;
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(0, 0, RB - 2.5, 0, TAU);
		ctx.lineWidth = 1;
		ctx.strokeStyle = "rgba(255,255,255,0.12)";
		ctx.stroke();
		ctx.beginPath();
		const ticks = 26;
		for (let k = 0; k < ticks; k++) {
			const a = (k / ticks) * TAU;
			const c0 = Math.cos(a);
			const s0 = Math.sin(a);
			ctx.moveTo(c0 * RB * 0.885, s0 * RB * 0.885);
			ctx.lineTo(c0 * RB * 0.965, s0 * RB * 0.965);
		}
		ctx.lineWidth = 1.5;
		ctx.strokeStyle = "rgba(10,13,17,0.4)";
		ctx.stroke();
		ctx.save();
		ctx.beginPath();
		ctx.arc(0, 0, RB, 0, TAU);
		ctx.clip();
		ctx.lineCap = "butt";
		ctx.lineJoin = "miter";
		const R = v.chamberR;
		const disc = (r, col) => {
			ctx.beginPath();
			ctx.arc(0, 0, r, 0, TAU);
			ctx.fillStyle = col;
			ctx.fill();
		};
		if (R > 0) disc(R + WALL + EDGE, EDGE_C);
		ctx.strokeStyle = EDGE_C;
		ctx.lineWidth = CW + 2 * WALL + 2 * EDGE;
		ctx.stroke(v.path);
		if (R > 0) disc(R + WALL, WALL_V);
		ctx.strokeStyle = WALL_V;
		ctx.lineWidth = CW + 2 * WALL;
		ctx.stroke(v.path);
		if (R > 0) disc(R, air);
		ctx.strokeStyle = air;
		ctx.lineWidth = CW;
		ctx.stroke(v.path);
		ctx.restore();
		if (v.solidCenter) {
			ctx.beginPath();
			ctx.arc(0, 0, 2.9, 0, TAU);
			ctx.fillStyle = "rgba(12,15,20,0.75)";
			ctx.fill();
			ctx.beginPath();
			ctx.arc(-0.6, -0.7, 1.5, 0, TAU);
			ctx.fillStyle = "rgba(255,255,255,0.22)";
			ctx.fill();
		}
		return c;
	}
	function buildScene(w, air, dpr) {
		return {
			bg: drawBackground(w, air, dpr),
			sprites: w.valves.map((v) => drawValve(v, air, dpr)),
			spriteSize: SPR,
			dpr,
		};
	}
	function renderScene(ctx, w, scene) {
		ctx.clearRect(0, 0, SIZE, SIZE);
		ctx.drawImage(scene.bg, 0, 0, SIZE, SIZE);
		const half = scene.spriteSize / 2;
		for (const v of w.valves) {
			if (v.angle === 0) {
				ctx.drawImage(
					scene.sprites[v.j * N + v.i],
					v.cx - half,
					v.cy - half,
					scene.spriteSize,
					scene.spriteSize,
				);
			} else {
				ctx.save();
				ctx.translate(v.cx, v.cy);
				ctx.rotate(v.angle);
				ctx.drawImage(
					scene.sprites[v.j * N + v.i],
					-half,
					-half,
					scene.spriteSize,
					scene.spriteSize,
				);
				ctx.restore();
			}
		}
		for (const p of w.particles) {
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.r, 0, TAU);
			ctx.fillStyle = p.color;
			ctx.fill();
			ctx.lineWidth = 1;
			ctx.strokeStyle = p.rim;
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(p.x - p.r * 0.28, p.y - p.r * 0.34, p.r * 0.3, 0, TAU);
			ctx.fillStyle = "rgba(255,255,255,0.55)";
			ctx.fill();
		}
	}

	return { buildScene, renderScene };
})();
if (typeof module !== "undefined") module.exports = ValveRenderer;
