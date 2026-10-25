(() => {
	"use strict";

	const G = ValveGeometry;
	const R = ValveRender;
	const $ = (id) => document.getElementById(id);
	const STEP = 1 / 120;
	const MAX_STEPS = 12;
	const TURN_SLOTS = 3;

	const canvas = $("c");
	const ctx = canvas.getContext("2d");
	const airMap = R.makeAirMap(4);
	const turns = new Float64Array(G.N * G.N * TURN_SLOTS);
	const stats = { frames: 0, clock: 0 };
	const paint = { air: "#ffffff" };

	let layout = G.createLayout(readSeed());
	let scene = null;
	let speed = 1;
	let paused = false;
	let accumulator = 0;
	let previous = performance.now();
	let overlayTick = 0;

	function seedTurns() {
		for (const v of layout.valves) {
			const k = v.j * G.N + v.i;
			const angle = (((G.hashUnit(layout.seed, k, 1) * 4) | 0) * G.HALF_PI) % G.TAU;
			G.setAngle(v, angle);
			turns[k * TURN_SLOTS] = angle;
			turns[k * TURN_SLOTS + 1] = angle;
			turns[k * TURN_SLOTS + 2] = 0.4 + G.hashUnit(layout.seed, k, 2) * 3;
		}
	}

	// Quarter-turn dwell cycle in fixed steps, so the motion is frame-rate
	// independent and repeatable for a given seed.
	function stepTurns(dt) {
		for (const v of layout.valves) {
			const base = (v.j * G.N + v.i) * TURN_SLOTS;
			const current = turns[base];
			const target = turns[base + 1];
			if (current === target) {
				turns[base + 2] -= dt;
				if (turns[base + 2] > 0) continue;
				const dir = G.hashUnit(layout.seed, base, 7) < 0.5 ? -1 : 1;
				turns[base + 1] = target + dir * G.HALF_PI;
				turns[base + 2] = 0.8 + G.hashUnit(layout.seed, base, 11) * 3.4;
			}
			const rate = (0.55 + G.hashUnit(layout.seed, base, 13) * 0.5) * speed;
			const remaining = turns[base + 1] - turns[base];
			const move = rate * G.TAU * 0.5 * dt;
			turns[base] += Math.sign(remaining) * Math.min(Math.abs(remaining), move);
		}
	}

	function commitAngles() {
		for (const v of layout.valves) {
			const angle = turns[(v.j * G.N + v.i) * TURN_SLOTS];
			if (angle !== v.angle) G.setAngle(v, angle);
		}
	}

	function readSeed() {
		const value = parseInt($("seed").value, 10);
		return Number.isFinite(value) ? value : 1;
	}

	function rebuild() {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const height = G.SIZE + G.POUR * 2;
		canvas.width = Math.round(G.SIZE * dpr);
		canvas.height = Math.round(height * dpr);
		ctx.setTransform(canvas.width / G.SIZE, 0, 0, canvas.height / height, 0, 0);
		scene = R.buildScene(layout, paint.air, dpr);
	}

	function newLayout() {
		layout = G.createLayout(readSeed());
		seedTurns();
		accumulator = 0;
		rebuild();
	}

	$("seed").onchange = newLayout;
	$("shuffle").onclick = () => {
		$("seed").value = String((Math.random() * 99999) | 0);
		newLayout();
	};
	$("reset").onclick = newLayout;
	$("pause").onclick = () => {
		paused = !paused;
		$("pause").textContent = paused ? "Resume" : "Pause";
	};
	$("step").onclick = () => {
		if (!paused) return;
		stepTurns(STEP);
		commitAngles();
		drawFrame(true);
	};
	$("speed").oninput = () => {
		speed = +$("speed").value;
		$("speed-value").value = String(speed);
	};
	$("air").onchange = () => {
		paint.air = $("air").checked ? "#000000" : "#ffffff";
		rebuild();
	};
	window.addEventListener("resize", rebuild);
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) return;
		previous = performance.now();
		accumulator = 0;
	});

	function drawOverlay() {
		R.renderAirMap(airMap, layout);
		ctx.save();
		ctx.globalAlpha = 0.45;
		ctx.drawImage(airMap.canvas, 0, 0, airMap.w * airMap.cell, airMap.h * airMap.cell);
		ctx.restore();
	}

	function drawFrame(forceOverlay) {
		ctx.save();
		ctx.translate(0, -G.POUR);
		R.renderScene(ctx, layout, scene);
		if ($("model").checked && (forceOverlay || ++overlayTick % 8 === 0)) drawOverlay();
		ctx.restore();
	}

	function frame(now) {
		const dt = Math.min(0.25, (now - previous) / 1000);
		previous = now;
		if (!paused) {
			accumulator += dt;
			let steps = 0;
			while (accumulator >= STEP && steps < MAX_STEPS) {
				stepTurns(STEP);
				accumulator -= STEP;
				steps++;
			}
			if (steps === MAX_STEPS) accumulator = 0;
			commitAngles();
		}
		drawFrame(false);
		stats.frames++;
		stats.clock += dt;
		if (stats.clock > 0.5) {
			$("stats").textContent =
				(stats.frames / stats.clock).toFixed(0) +
				" fps · seed " +
				layout.seed +
				" · 100 valves · air model " +
				($("model").checked ? "on" : "off");
			stats.frames = 0;
			stats.clock = 0;
		}
		requestAnimationFrame(frame);
	}

	seedTurns();
	rebuild();
	requestAnimationFrame(frame);
})();
