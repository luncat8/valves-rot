(() => {
	"use strict";

	const G = ValveGeometry;
	const R = ValveRender;
	const S = ValveSimulation;
	const $ = (id) => document.getElementById(id);

	const canvas = $("c");
	const ctx = canvas.getContext("2d");
	const airMap = R.makeAirMap(4);
	const paint = { air: "#ffffff" };
	const stats = { frames: 0, clock: 0 };

	let layout = G.createLayout(readSeed());
	let sim = S.create(layout);
	let scene = null;
	let paused = false;
	let previous = performance.now();
	let overlayTick = 0;

	S.seed(sim);

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

	// A new layout means a new machine: the simulation owns the valve angles and
	// the grain state, so it is rebuilt with the geometry.
	function newLayout() {
		layout = G.createLayout(readSeed());
		sim = S.create(layout);
		S.setSpeed(sim, +$("speed").value);
		S.seed(sim);
		rebuild();
	}

	$("seed").onchange = newLayout;
	$("shuffle").onclick = () => {
		$("seed").value = String((Math.random() * 99999) | 0);
		newLayout();
	};
	$("reset").onclick = newLayout;
	$("pour").onclick = () => S.pour(sim, 24);
	$("drain").onclick = () => S.drain(sim);
	$("pause").onclick = () => {
		paused = !paused;
		$("pause").textContent = paused ? "Resume" : "Pause";
	};
	$("step").onclick = () => {
		if (!paused) return;
		S.step(sim, S.STEP);
		drawFrame(true);
	};
	$("speed").oninput = () => {
		S.setSpeed(sim, +$("speed").value);
		$("speed-value").value = $("speed").value;
	};
	$("air").onchange = () => {
		paint.air = $("air").checked ? "#000000" : "#ffffff";
		rebuild();
	};
	window.addEventListener("resize", rebuild);
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) return;
		previous = performance.now();
		S.resume(sim);
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
		R.renderGrains(ctx, sim, S.GRAIN_COLORS);
		ctx.restore();
	}

	function frame(now) {
		const dt = Math.min(0.25, (now - previous) / 1000);
		previous = now;
		if (!paused) S.advance(sim, dt);
		drawFrame(false);
		stats.frames++;
		stats.clock += dt;
		if (stats.clock > 0.4) {
			$("stats").textContent =
				(stats.frames / stats.clock).toFixed(0).padStart(3) +
				" fps · seed " +
				layout.seed +
				" · active " +
				sim.count +
				" · injected " +
				sim.injected +
				" · drained " +
				sim.drained +
				" · recovered " +
				sim.recovered +
				" · pushes " +
				sim.pushed;
			stats.frames = 0;
			stats.clock = 0;
		}
		requestAnimationFrame(frame);
	}

	rebuild();
	requestAnimationFrame(frame);
})();
