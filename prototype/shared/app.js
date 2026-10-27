(() => {
	"use strict";

	const G = ValveGeometry;
	const R = ValveRender;
	const S = ValveSimulation;
	const I = ValveInlets;
	const $ = id => document.getElementById(id);

	const HEIGHT = G.SIZE + G.POUR * 2;
	const canvas = $("c");
	const ctx = canvas.getContext("2d");
	const airMap = R.makeAirMap(4);
	const paint = { air: "#ffffff", skin: "glm" };
	const stats = { frames: 0, clock: 0 };
	const point = { x: 0, y: 0 };
	const at = { inlet: -1, cell: -1 };

	let layout = G.createLayout(readSeed());
	let sim = S.create(layout);
	let scene = null;
	let paused = false;
	let selected = -1;
	let hoverInlet = -1;
	let fieldMap = null;
	let previous = performance.now();
	let overlayTick = 0;
	let overlayDirty = true;

	S.seed(sim);
	S.setAirForce(sim, +$("force").value);
	S.setPressure(sim, readMode());

	function readSeed() {
		const value = parseInt($("seed").value, 10);
		return Number.isFinite(value) ? value : 1;
	}

	function rebuild(force) {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		if (!force && scene && scene.dpr === dpr) return;
		canvas.width = Math.round(G.SIZE * dpr);
		canvas.height = Math.round(HEIGHT * dpr);
		ctx.setTransform(canvas.width / G.SIZE, 0, 0, canvas.height / HEIGHT, 0, 0);
		scene = R.buildScene(layout, paint.air, dpr, paint.skin);
		overlayDirty = true;
	}

	function newLayout() {
		layout = G.createLayout(readSeed());
		sim = S.create(layout);
		S.setSpeed(sim, +$("speed").value);
		S.setAirForce(sim, +$("force").value);
		S.seed(sim);
		S.setPressure(sim, readMode());
		rebuild(true);
		if (paused) drawFrame(true);
	}

	function resetSim() {
		S.reset(sim);
		S.setSpeed(sim, +$("speed").value);
		S.setAirForce(sim, +$("force").value);
		S.seed(sim);
		overlayDirty = true;
		if (paused) drawFrame(true);
	}

	function readMode() {
		if ($("pressure-grid").checked) return "grid";
		if ($("pressure-particles").checked) return "particles";
		return "off";
	}

	// Pointer in world coordinates: [-POUR, SIZE + POUR] vertically.
	function worldFromPointer(event) {
		const b = canvas.getBoundingClientRect();
		if (!(b.width > 0 && b.height > 0)) return null;
		point.x = ((event.clientX - b.left) / b.width) * G.SIZE;
		point.y = ((event.clientY - b.top) / b.height) * HEIGHT - G.POUR;
		return point;
	}

	function cellFromPointer(wx, wy) {
		if (wx < 0 || wx >= G.SIZE || wy < 0 || wy >= G.SIZE) return -1;
		return ((wy / G.S) | 0) * G.N + ((wx / G.S) | 0);
	}

	function turnSelected(quarters) {
		if (selected < 0) return;
		S.turn(sim, selected, quarters);
		overlayDirty = true;
		if (paused) drawFrame(true);
	}

	$("seed").onchange = newLayout;
	$("shuffle").onclick = () => {
		$("seed").value = String((Math.random() * 99999) | 0);
		newLayout();
	};
	$("reset").onclick = resetSim;
	$("pour").onclick = () => {
		S.pour(sim, 24);
		if (paused) drawFrame(false);
	};
	$("drain").onclick = () => {
		S.drain(sim);
		if (paused) drawFrame(false);
	};
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
	$("force").oninput = () => {
		S.setAirForce(sim, +$("force").value);
		$("force-value").value = $("force").value;
		if (paused) drawFrame(false);
	};
	$("air").onchange = () => {
		paint.air = $("air").checked ? "#000000" : "#ffffff";
		rebuild(true);
		if (paused) drawFrame(true);
	};
	$("skin").onchange = () => {
		paint.skin = $("skin").value;
		rebuild(true);
		if (paused) drawFrame(true);
	};
	$("model").onchange = () => {
		overlayDirty = true;
		if (paused) drawFrame(true);
	};

	function pressureChanged() {
		S.setPressure(sim, readMode());
		if (paused) drawFrame(true);
	}
	$("pressure-off").onchange = pressureChanged;
	$("pressure-particles").onchange = pressureChanged;
	$("pressure-grid").onchange = pressureChanged;
	$("pressure-draw").onchange = () => { if (paused) drawFrame(false); };

	function setHover(inlet) {
		if (hoverInlet === inlet) return;
		hoverInlet = inlet;
		if (paused) drawFrame(false);
	}

	function pointerState(event) {
		const w = worldFromPointer(event);
		at.inlet = w ? I.hit(sim.inlets, w.x, w.y) : -1;
		at.cell = w ? cellFromPointer(w.x, w.y) : -1;
		return at;
	}

	canvas.onpointermove = event => {
		pointerState(event);
		setHover(at.inlet);
		selected = at.inlet >= 0 ? -1 : at.cell;
		if (paused) drawFrame(false);
	};
	canvas.onpointerleave = () => {
		if (document.activeElement === canvas) return;
		selected = -1;
		setHover(-1);
		if (paused) drawFrame(false);
	};
	canvas.onblur = () => {
		selected = -1;
		setHover(-1);
		if (paused) drawFrame(false);
	};
	canvas.onclick = event => {
		pointerState(event);
		if (at.inlet >= 0) {
			S.toggleInlet(sim, at.inlet, event.shiftKey);
			if (paused) drawFrame(true);
			return;
		}
		selected = at.cell;
		if (selected < 0 || event.detail > 1) return;
		if (event.ctrlKey) S.fillValve(sim, selected);
		else turnSelected(event.shiftKey ? -1 : 1);
		if (paused) drawFrame(true);
	};
	canvas.ondblclick = event => {
		event.preventDefault();
		const w = worldFromPointer(event);
		if (!w) return;
		selected = cellFromPointer(w.x, w.y);
		if (selected < 0 || event.ctrlKey || !S.replaceValve(sim, selected)) return;
		hoverInlet = -1;
		rebuild(true);
		if (paused) drawFrame(true);
	};
	canvas.onkeydown = event => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			if (selected < 0) selected = 44;
			turnSelected(event.shiftKey ? -1 : 1);
			return;
		}
		if (!event.key.startsWith("Arrow")) return;
		event.preventDefault();
		if (selected < 0) selected = 44;
		let row = (selected / G.N) | 0;
		let col = selected % G.N;
		if (event.key === "ArrowUp" && row > 0) row--;
		else if (event.key === "ArrowDown" && row < G.N - 1) row++;
		else if (event.key === "ArrowLeft" && col > 0) col--;
		else if (event.key === "ArrowRight" && col < G.N - 1) col++;
		selected = row * G.N + col;
		if (paused) drawFrame(false);
	};

	window.addEventListener("resize", () => rebuild(false));
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) return;
		previous = performance.now();
		S.resume(sim);
	});

	function drawOverlay(forceOverlay) {
		if (forceOverlay || overlayDirty || (++overlayTick & 7) === 0) {
			R.renderAirMap(airMap, layout);
			overlayDirty = false;
		}
		ctx.save();
		ctx.globalAlpha = 0.45;
		ctx.drawImage(airMap.canvas, 0, -G.POUR, airMap.w * airMap.cell, airMap.h * airMap.cell);
		ctx.restore();
	}

	// Scalar field, drawn as one smoothed texel per gas cell plus the legend.
	function drawPressureGrid() {
		const gas = sim.pressure;
		if (!fieldMap || fieldMap.nx !== gas.nx || fieldMap.ny !== gas.ny) fieldMap = R.makeFieldMap(gas.nx, gas.ny);
		R.renderField(fieldMap, gas);
		ctx.save();
		ctx.globalAlpha = 0.62;
		ctx.imageSmoothingEnabled = true;
		ctx.drawImage(fieldMap.canvas, 0, -G.POUR, gas.nx * gas.cell, gas.ny * gas.cell);
		ctx.restore();
		R.renderPressureLegend(ctx);
	}

	function drawFrame(forceOverlay) {
		ctx.save();
		// Shift world [-POUR, SIZE + POUR] down into canvas [0, SIZE + 2 * POUR].
		ctx.translate(0, G.POUR);
		R.renderScene(ctx, layout, scene);
		if ($("model").checked) drawOverlay(forceOverlay);
		if ($("pressure-draw").checked && sim.pressure) {
			if (sim.pressure.kind === "grid") drawPressureGrid();
			else R.renderPressure(ctx, sim.pressure);
		}
		// Mouths sit under the grain piles that share the bands.
		R.renderInlets(ctx, sim.inlets, hoverInlet);
		R.renderGrains(ctx, sim, scene);
		R.renderSelection(ctx, layout, selected);
		ctx.restore();
	}

	function formatStats(fps) {
		const purged = sim.purged > 0 ? " · purged " + sim.purged : "";
		const gas = sim.pressure && sim.pressure.kind === "grid" ? " · gas p " + sim.pressure.mean.toFixed(2) + " · flow " + sim.pressure.flow.toFixed(0) : "";
		return (
			fps.toFixed(0).padStart(3) +
			" fps · seed " +
			layout.seed +
			" · active " +
			sim.count +
			" · injected " +
			sim.injected +
			" · drained " +
			sim.drained +
			purged +
			" · recovered " +
			sim.recovered +
			" · pushes " +
			sim.pushed +
			gas
		);
	}

	function frame(now) {
		const dt = Math.min(0.25, (now - previous) / 1000);
		previous = now;
		if (!paused) S.advance(sim, dt);
		drawFrame(false);
		stats.frames++;
		stats.clock += dt;
		if (stats.clock > 0.4) {
			$("stats").textContent = formatStats(stats.frames / stats.clock);
			stats.frames = 0;
			stats.clock = 0;
		}
		requestAnimationFrame(frame);
	}

	rebuild(true);
	requestAnimationFrame(frame);
})();
