(() => {
	"use strict";

	const G = ValveGeometry;
	const R = ValveRender;
	const S = ValveSimulation;
	const I = ValveInlets;
	const C = ValveCalibration;
	const $ = id => document.getElementById(id);

	const HEIGHT = G.SIZE + G.POUR * 2;
	const canvas = $("c");
	const ctx = canvas.getContext("2d");
	const legendRange = $("legend-range");
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
	let pressureSpan = Number(C.DEFAULT_SPAN.toPrecision(6));
	let pressureSpanLabel = C.format(pressureSpan);
	let legendState = -1;
	let legendLabel = "";
	let previous = performance.now();
	let overlayTick = 0;
	let overlayDirty = true;
	// Valve brush placed by double-click: type id / "random" / null (not
	// change), direction quarter / "random" / null (not change). The default
	// keeps the old double-click behaviour: a random different type.
	const brush = { type: "random", dir: null };
	const DIR_ARROWS = ["→", "↓", "←", "↑"];
	let openDrawerId = null;
	let shownValve = null;
	let shownIndex = -2;
	let shownQuarter = -1;

	$("pressure-span").value = String(pressureSpan);
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
	$("pressure-span").oninput = () => {
		const input = $("pressure-span");
		const value = Number(input.value);
		if (!Number.isFinite(value) || value <= 0) {
			input.setAttribute("aria-invalid", "true");
			$("pressure-error").hidden = false;
			return;
		}
		input.removeAttribute("aria-invalid");
		$("pressure-error").hidden = true;
		pressureSpan = value;
		pressureSpanLabel = C.format(C.equivalentPressure(1, pressureSpan));
		if (paused) drawFrame(false);
	};
	$("pressure-reference").onclick = () => {
		$("pressure-span").value = String(Number(C.DEFAULT_SPAN.toPrecision(6)));
		$("pressure-span").oninput();
	};

	// ---- drawers ----------------------------------------------------------
	// One drawer at a time, non-modal so the field beside it stays clickable.
	function setDrawer(id) {
		openDrawerId = id;
		$("help-drawer").hidden = id !== "help-drawer";
		$("valve-drawer").hidden = id !== "valve-drawer";
		$("open-help").setAttribute("aria-expanded", id === "help-drawer" ? "true" : "false");
		$("open-valves").setAttribute("aria-expanded", id === "valve-drawer" ? "true" : "false");
		if (id) $(id === "help-drawer" ? "close-help" : "close-valves").focus();
	}

	function toggleDrawer(id) {
		setDrawer(openDrawerId === id ? null : id);
	}

	function closeDrawers() {
		setDrawer(null);
		canvas.focus();
	}

	$("open-help").onclick = () => toggleDrawer("help-drawer");
	$("open-valves").onclick = () => toggleDrawer("valve-drawer");
	$("close-help").onclick = closeDrawers;
	$("close-valves").onclick = closeDrawers;
	document.addEventListener("keydown", event => {
		const tag = event.target && event.target.tagName;
		if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
		if (event.key === "Escape" && openDrawerId) closeDrawers();
		else if (event.key === "?" || event.key === "h" || event.key === "H") toggleDrawer("help-drawer");
		else if (event.key === "v" || event.key === "V") toggleDrawer("valve-drawer");
	});

	// ---- valve brush --------------------------------------------------------
	function dirLabel(quarter) {
		return DIR_ARROWS[quarter] + " " + G.DIR_NAMES[quarter] + " · " + quarter * 90 + "°";
	}

	function brushType() {
		return brush.type && brush.type !== "random" ? G.typeById(brush.type) : null;
	}

	// Chat-ready name of the brush, with the ports it will face when the
	// direction is fixed.
	function brushText() {
		const type = brushType();
		let text = brush.type === "random" ? "random valve type" : type ? type.name : "keep valve type (not change)";
		if (type && typeof brush.dir === "number") text += " (ports " + G.portsText(G.rotatePorts(type.ports, brush.dir)) + ")";
		return text + " · " + (brush.dir === "random" ? "random direction" : brush.dir === null ? "direction not change" : "direction " + dirLabel(brush.dir));
	}

	function syncBrush() {
		for (const b of document.querySelectorAll("[data-type]")) {
			const active = b.dataset.type === brush.type || (b.dataset.type === "keep" && brush.type === null);
			b.setAttribute("aria-pressed", active ? "true" : "false");
		}
		const dir = brush.dir === null ? "keep" : String(brush.dir);
		for (const b of document.querySelectorAll("[data-dir]")) {
			b.setAttribute("aria-pressed", b.dataset.dir === dir ? "true" : "false");
		}
		$("brush-summary").textContent = "Double-click places: " + brushText();
		const nothing = brush.type === null && brush.dir === null;
		$("brush-detail").textContent = brushText() + (nothing ? " — pick a type or a direction, this changes nothing." : "");
	}

	function typeIcon(type) {
		let lines = "";
		for (const p of type.ports) {
			lines += '<line x1="16" y1="16" x2="' + (16 + G.DX[p] * 13) + '" y2="' + (16 + G.DY[p] * 13) + '"/>';
		}
		const chamber = type.kind === "hollow" ? '<circle class="chamber" cx="16" cy="16" r="6"/>' : "";
		return '<svg class="type-icon" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"><circle class="rotor" cx="16" cy="16" r="13"/>' + lines + chamber + "</svg>";
	}

	function typeRow(value, badge, name, note, copyName) {
		let row = '<div class="type-row"><button type="button" class="type-pick" data-type="' + value + '" aria-pressed="false">' + badge + "<span>" + name + "<small>" + note + "</small></span></button>";
		if (copyName) row += '<button type="button" class="copy-name" data-copy-name="' + copyName + '" title="Copy “' + copyName + '” to the clipboard" aria-label="Copy name ' + copyName + '">⧉</button>';
		return row + "</div>";
	}

	function buildValveTypes() {
		let html = typeRow("random", '<span class="type-badge">?</span>', "? Random type", "any different type", "");
		html += typeRow("keep", '<span class="type-badge">=</span>', "= Not change", "keep this valve's type", "");
		let kind = "";
		for (const type of G.TYPES) {
			if (type.kind !== kind) {
				kind = type.kind;
				html += "<h4>" + kind + "</h4>";
			}
			html += typeRow(type.id, typeIcon(type), type.name, "ports " + G.portsText(type.ports) + " at 0°", type.name);
		}
		$("valve-types").innerHTML = html;
	}

	$("valve-types").onclick = event => {
		const copy = event.target.closest("[data-copy-name]");
		if (copy) {
			copyText(copy.dataset.copyName);
			return;
		}
		const pick = event.target.closest("[data-type]");
		if (!pick) return;
		brush.type = pick.dataset.type === "keep" ? null : pick.dataset.type;
		syncBrush();
	};
	$("dir-picker").onclick = event => {
		const pick = event.target.closest("[data-dir]");
		if (!pick) return;
		brush.dir = pick.dataset.dir === "keep" ? null : pick.dataset.dir === "random" ? "random" : Number(pick.dataset.dir);
		syncBrush();
	};

	function placeBrushAt(index) {
		if (index < 0) {
			$("copy-status").textContent = "Select a valve on the field first.";
			return false;
		}
		const done = S.placeValve(sim, index, brush);
		if (!done) {
			$("copy-status").textContent = "Nothing to change for that valve: " + brushText();
			return false;
		}
		if (done === "replace") {
			hoverInlet = -1;
			rebuild(true);
		} else overlayDirty = true;
		shownIndex = -2;
		if (paused) drawFrame(true);
		return true;
	}

	$("apply-brush").onclick = () => placeBrushAt(selected);
	$("copy-brush").onclick = () => copyText(brushText());

	// ---- clipboard ----------------------------------------------------------
	// file:// pages may not get the async Clipboard API, so keep a fallback.
	function fallbackCopy(text) {
		try {
			const box = document.createElement("textarea");
			box.value = text;
			box.setAttribute("readonly", "");
			box.style.position = "fixed";
			box.style.opacity = "0";
			document.body.appendChild(box);
			box.select();
			const ok = document.execCommand("copy");
			box.remove();
			return ok;
		} catch {
			return false;
		}
	}

	function copyText(text) {
		const show = ok => {
			$("copy-status").textContent = ok ? "Copied: " + text : "Could not copy automatically — copy this: " + text;
		};
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).then(() => show(true), () => show(fallbackCopy(text)));
			return;
		}
		show(fallbackCopy(text));
	}

	// ---- valve on the field --------------------------------------------------
	function valveText(index) {
		const v = sim.layout.valves[index];
		const type = G.typeOf(v);
		if (!type) return "";
		const quarter = G.quarterOf(sim.target[index]);
		const dir = type.turns === 1 ? "direction –" : "direction " + dirLabel(G.orientationOf(v, quarter));
		return "cell (" + (v.i + 1) + "," + (v.j + 1) + ") · " + type.name + " · ports " + G.portsText(G.worldPorts(v, quarter)) + " · " + dir;
	}

	// Refreshed from drawFrame only when the selection, valve or its target
	// detent changed, so the frame loop keeps building no strings.
	function syncSelectedValve() {
		if (selected < 0) {
			if (shownIndex === -1) return;
			shownIndex = -1;
			shownValve = null;
			$("selected-valve").textContent = "Hover or select a valve on the field.";
			return;
		}
		const v = sim.layout.valves[selected];
		const quarter = G.quarterOf(sim.target[selected]);
		if (shownIndex === selected && shownValve === v && shownQuarter === quarter) return;
		shownIndex = selected;
		shownValve = v;
		shownQuarter = quarter;
		$("selected-valve").textContent = valveText(selected);
	}

	$("use-selected").onclick = () => {
		if (selected < 0) {
			$("copy-status").textContent = "Select a valve on the field first.";
			return;
		}
		const v = sim.layout.valves[selected];
		const type = G.typeOf(v);
		if (!type) return;
		brush.type = type.id;
		brush.dir = G.orientationOf(v, G.quarterOf(sim.target[selected]));
		syncBrush();
		$("copy-status").textContent = "Brush: " + brushText();
	};
	$("copy-selected").onclick = () => {
		if (selected >= 0) copyText(valveText(selected));
	};

	buildValveTypes();
	setDrawer(null);
	syncBrush();

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
		if (selected < 0 || event.ctrlKey) return;
		// The first click of the gesture already turned this valve; undo that
		// turn so the brush (notably direction "not change") is measured from
		// before the double-click.
		S.turn(sim, selected, event.shiftKey ? 1 : -1);
		placeBrushAt(selected);
	};
	canvas.onkeydown = event => {
		if (event.key === "p" || event.key === "P") {
			event.preventDefault();
			if (selected < 0) selected = 44;
			placeBrushAt(selected);
			return;
		}
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

	// Without a boundary there is no reference for the potential or its ramp.
	function drawPressureGrid() {
		const gas = sim.pressure;
		if (!gas.pins) return;
		if (!fieldMap || fieldMap.nx !== gas.nx || fieldMap.ny !== gas.ny) fieldMap = R.makeFieldMap(gas.nx, gas.ny);
		R.renderField(fieldMap, gas);
		ctx.save();
		ctx.globalAlpha = 0.62;
		ctx.imageSmoothingEnabled = true;
		ctx.drawImage(fieldMap.canvas, 0, -G.POUR, gas.nx * gas.cell, gas.ny * gas.cell);
		ctx.restore();
	}

	function syncLegend() {
		const gas = sim.pressure;
		const state = !$("pressure-draw").checked || !gas || gas.kind !== "grid" ? 0 : gas.pins ? 2 : 1;
		if (state === legendState && (state !== 2 || legendLabel === pressureSpanLabel)) return;
		legendState = state;
		legendLabel = pressureSpanLabel;
		legendRange.hidden = state === 0;
		legendRange.textContent = state === 1 ? "· unanchored" : state === 2 ? "· 0–" + pressureSpanLabel + " Pa equivalent" : "";
	}

	function drawFrame(forceOverlay) {
		syncLegend();
		syncSelectedValve();
		ctx.save();
		// Shift world [-POUR, SIZE + POUR] down into canvas [0, SIZE + 2 * POUR].
		ctx.translate(0, G.POUR);
		R.renderScene(ctx, layout, scene);
		if ($("model").checked) drawOverlay(forceOverlay);
		const pressure = sim.pressure;
		const drawPressure = $("pressure-draw").checked && pressure;
		if (drawPressure) {
			if (pressure.kind === "grid") drawPressureGrid();
			else R.renderPressure(ctx, pressure);
		}
		// Mouths sit under the grain piles that share the bands.
		R.renderInlets(ctx, sim.inlets, hoverInlet);
		R.renderGrains(ctx, sim, scene);
		R.renderSelection(ctx, layout, selected);
		if (drawPressure && pressure.kind === "grid" && pressure.pins) {
			R.renderPressureLegend(ctx, pressureSpanLabel);
		}
		ctx.restore();
	}

	function formatStats(fps) {
		const purged = sim.purged > 0 ? " · purged " + sim.purged : "";
		let gas = "";
		if (sim.pressure && sim.pressure.kind === "grid") {
			gas = sim.pressure.pins ? " · potential " + sim.pressure.mean.toFixed(2) + " · flow " + sim.pressure.flow.toFixed(0) + " px/s" : " · potential unanchored";
		}
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
