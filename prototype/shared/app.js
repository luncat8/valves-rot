(() => {
	"use strict";

	const G = ValveGeometry;
	const R = ValveRender;
	const S = ValveSimulation;
	const I = ValveInlets;
	const C = ValveCalibration;
	const Game = ValveGame;
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
	const drag = {
		pointerId: -1,
		cell: -1,
		downX: 0,
		downY: 0,
		lastX: 0,
		lastY: 0,
		r0: 0,
		baseTarget: 0,
		orbitAcc: 0,
		active: false,
		suppressClick: false,
	};

	let layout = G.createLayout(readSeed());
	let sim = S.create(layout);
	let game = Game.create(sim, { mode: "lab", botControl: true });
	let scene = null;
	let paused = false;
	let selected = -1;
	let hoverInlet = -1;
	let fieldMap = null;
	let pressureSpan = Number(C.DEFAULT_SPAN.toPrecision(6));
	let pressureSpanLabel = C.format(pressureSpan);
	let legendState = -1;
	let legendLabel = "";
	let legendReason = "";
	let fieldAlpha = 0;
	let previous = performance.now();
	let overlayTick = 0;
	let overlayDirty = true;
	// Valve brush placed by double-click: type id / "random" / null, direction
	// quarter / "random" / null, case tint -1..3 / null; null means keep current.
	const brush = { type: "random", dir: null, tint: null };
	const DIR_ARROWS = ["→", "↓", "←", "↑"];
	let openDrawerId = null;
	let shownValve = null;
	let shownIndex = -2;
	let shownQuarter = -1;
	let shownGameVersion = -1;

	$("pressure-span").value = String(pressureSpan);
	if ($("auto-rotate").value === "") $("auto-rotate").value = "90";
	S.seed(sim);
	S.setAutoRotate(sim, readAutoPercent() / 100);
	S.setAirForce(sim, +$("force").value);
	S.setPressure(sim, readMode());

	function readSeed() {
		const value = parseInt($("seed").value, 10);
		return Number.isFinite(value) ? value : 1;
	}

	function readAutoPercent() {
		const raw = $("auto-rotate").value;
		const v = raw === "" ? 90 : Number(raw);
		return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 90;
	}

	function setAutoSlider(percent) {
		const clamped = Math.max(0, Math.min(100, Math.round(percent)));
		$("auto-rotate").value = String(clamped);
		$("auto-rotate-value").value = clamped + "%";
		$("auto-rotate-value").textContent = clamped + "%";
		S.setAutoRotate(sim, clamped / 100);
	}

	function rebuild(force) {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		if (!force && scene && scene.dpr === dpr) return;
		canvas.width = Math.round(G.SIZE * dpr);
		canvas.height = Math.round(HEIGHT * dpr);
		ctx.setTransform(canvas.width / G.SIZE, 0, 0, canvas.height / HEIGHT, 0, 0);
		scene = R.buildScene(layout, paint.air, dpr, paint.skin, sim.caseTint);
		overlayDirty = true;
	}

	function newLayout() {
		layout = G.createLayout(readSeed());
		sim = S.create(layout);
		S.setSpeed(sim, +$("speed").value);
		S.setAutoRotate(sim, readAutoPercent() / 100);
		S.setAirForce(sim, +$("force").value);
		S.seed(sim);
		S.setPressure(sim, readMode());
		Game.resetMatch(game, sim);
		if (game.mode === "game") setAutoSlider(Math.round(Game.GAME_AUTO * 100));
		rebuild(true);
		shownIndex = -2;
		shownGameVersion = -1;
		if (paused) drawFrame(true);
	}

	function resetSim() {
		S.reset(sim);
		S.setSpeed(sim, +$("speed").value);
		S.setAutoRotate(sim, readAutoPercent() / 100);
		S.setAirForce(sim, +$("force").value);
		S.seed(sim);
		if (game.mode === "game") {
			Game.resetMatch(game, sim);
			setAutoSlider(Math.round(Game.GAME_AUTO * 100));
		}
		rebuild(true);
		shownIndex = -2;
		shownGameVersion = -1;
		if (paused) drawFrame(true);
	}

	function readMode() {
		if ($("pressure-grid").checked) return "grid";
		if ($("pressure-particles").checked) return "particles";
		return "off";
	}

	function syncPressureRadios() {
		$("pressure-off").checked = sim.pressureMode === "off";
		$("pressure-particles").checked = sim.pressureMode === "particles";
		$("pressure-grid").checked = sim.pressureMode === "grid";
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

	function canPlayerTurn(index) {
		if (index < 0) return false;
		return game.mode !== "game" || sim.goalOwner[index] <= 0;
	}

	function turnSelected(quarters) {
		if (!canPlayerTurn(selected)) return;
		S.turn(sim, selected, quarters);
		overlayDirty = true;
		if (paused) drawFrame(true);
	}

	// ---- Lab / Game mode ----------------------------------------------------
	function applyPlayMode(mode) {
		const isGame = mode === "game";
		Game.setMode(game, mode);
		$("mode-lab").checked = !isGame;
		$("mode-game").checked = isGame;
		$("game-panel").hidden = !isGame;
		$("drain").disabled = isGame;
		$("open-valves").disabled = isGame;
		$("brush-summary").hidden = isGame;
		if (isGame && openDrawerId === "valve-drawer") setDrawer(null);
		setAutoSlider(Math.round((isGame ? Game.GAME_AUTO : Game.LAB_AUTO) * 100));
		Game.consumeDirty(game, scene);
		if (!isGame && scene) R.rebuildBackground(scene, layout, sim.caseTint);
		overlayDirty = true;
		shownIndex = -2;
		shownGameVersion = -1;
		syncGameUI();
		if (paused) drawFrame(true);
	}

	$("mode-lab").onchange = () => { if ($("mode-lab").checked) applyPlayMode("lab"); };
	$("mode-game").onchange = () => { if ($("mode-game").checked) applyPlayMode("game"); };
	$("bot-enable").onchange = () => {
		Game.setBotControl(game, $("bot-enable").checked);
		syncGameUI();
	};
	$("new-match").onclick = resetSim;

	function syncGameUI() {
		if (game.mode !== "game" || game.version === shownGameVersion) return;
		shownGameVersion = game.version;
		syncPressureRadios();
		$("game-status").textContent = game.lastEvent;

		let pHtml = "";
		for (let p = 0; p < game.players.length; p++) {
			const pl = game.players[p];
			let task = "idle";
			if (pl.questId >= 0) {
				for (let q = 0; q < game.quests.length; q++) {
					if (game.quests[q].id === pl.questId) {
						task = game.quests[q].title;
						break;
					}
				}
			}
			const role = pl.bot ? (game.botControl ? " [bot]" : " [paused]") : "";
			pHtml +=
				'<div class="player-row">' +
				'<span class="player-swatch" style="background:' + pl.hex + '"></span>' +
				"<strong>" + pl.name + role + "</strong>" +
				'<span class="player-task">' + task + "</span>" +
				'<span class="player-score">' + pl.score + " pts (" + pl.completed + ")</span>" +
				"</div>";
		}
		$("player-list").innerHTML = pHtml;

		const userBusy = game.players[0].questId >= 0;
		let qHtml = "";
		for (let k = 0; k < game.quests.length; k++) {
			const q = game.quests[k];
			const owner = q.owner >= 0 ? game.players[q.owner] : null;
			const mine = q.owner === 0;
			const timer = q.timeLimit > 0 ? " · ⏱ " + Math.max(0, Math.ceil(q.remaining)) + "s" : "";
			const swatch = q.swatch ? '<span class="quest-swatch" style="background:' + q.swatch + '"></span>' : "";
			let btns = "";
			if (!owner) {
				btns = '<button type="button" data-sign="' + q.id + '"' + (userBusy ? " disabled" : "") + ">Sign</button>";
			} else if (mine) {
				btns =
					'<button type="button" data-locate="' + q.id + '">Locate</button>' +
					'<button type="button" data-drop="' + q.id + '">Drop</button>';
			} else {
				btns = '<span style="color:' + owner.accent + ';font-weight:600">' + owner.name + "</span>";
			}
			qHtml +=
				'<div class="quest-card' + (mine ? " mine" : "") + '">' +
				'<div class="quest-top">' +
				'<div class="quest-badges"><span class="tier-pill tier-' + q.tier + '">' + q.tier + "</span><span>+" + q.points + " pts" + timer + "</span></div>" +
				'<div class="quest-btns">' + btns + "</div>" +
				"</div>" +
				'<div class="quest-title">' + swatch + "<span>" + q.title + "</span></div>" +
				'<div class="quest-foot"><span>' + (owner ? q.progressText : "Spawns " + q.bottles + "× hollow single ↑ N") + "</span></div>" +
				"</div>";
		}
		$("quest-list").innerHTML = qHtml;
	}

	$("quest-list").onclick = event => {
		const signBtn = event.target.closest("[data-sign]");
		if (signBtn) {
			const id = Number(signBtn.dataset.sign);
			if (Game.signQuest(game, id, 0)) {
				Game.consumeDirty(game, scene);
				syncPressureRadios();
				for (let k = 0; k < game.quests.length; k++) {
					if (game.quests[k].id === id && game.quests[k].cellCount > 0) selected = game.quests[k].cells[0];
				}
				overlayDirty = true;
				shownIndex = -2;
				syncGameUI();
				if (paused) drawFrame(true);
			}
			return;
		}
		const locateBtn = event.target.closest("[data-locate]");
		if (locateBtn) {
			const id = Number(locateBtn.dataset.locate);
			for (let k = 0; k < game.quests.length; k++) {
				if (game.quests[k].id === id && game.quests[k].cellCount > 0) {
					selected = game.quests[k].cells[0];
					canvas.focus();
					if (paused) drawFrame(false);
					break;
				}
			}
			return;
		}
		const dropBtn = event.target.closest("[data-drop]");
		if (dropBtn) {
			if (Game.dropQuest(game, 0)) {
				Game.consumeDirty(game, scene);
				overlayDirty = true;
				shownIndex = -2;
				syncGameUI();
				if (paused) drawFrame(true);
			}
		}
	};

	// ---- core controls ------------------------------------------------------
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
		if (game.mode === "game") return;
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
		if (game.mode === "game") {
			Game.step(game, S.STEP);
			Game.consumeDirty(game, scene);
			syncGameUI();
		}
		drawFrame(true);
	};
	$("speed").oninput = () => {
		S.setSpeed(sim, +$("speed").value);
		$("speed-value").value = $("speed").value;
	};
	$("auto-rotate").oninput = () => {
		setAutoSlider(readAutoPercent());
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
		if (id === "valve-drawer" && game.mode === "game") return;
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
		else if ((event.key === "v" || event.key === "V") && game.mode !== "game") toggleDrawer("valve-drawer");
		else if (event.key === "g" || event.key === "G") applyPlayMode(game.mode === "game" ? "lab" : "game");
	});

	// ---- valve brush --------------------------------------------------------
	function dirLabel(quarter) {
		return DIR_ARROWS[quarter] + " " + G.DIR_NAMES[quarter] + " · " + quarter * 90 + "°";
	}

	function brushType() {
		return brush.type && brush.type !== "random" ? G.typeById(brush.type) : null;
	}

	function dirText() {
		return brush.dir === "random" ? "random direction" : brush.dir === null ? "keep current direction" : "direction " + dirLabel(brush.dir);
	}

	function tintText() {
		if (brush.tint === null) return "";
		if (brush.tint < 0) return " · grey case";
		const pl = R.PLAYERS[brush.tint];
		return pl ? " · " + pl.name + " case" : "";
	}

	// Chat-ready name of a type, with the selected direction (and the ports
	// it will face) appended whenever a direction is selected.
	function typeText(type) {
		if (brush.dir === null) return type.name;
		const ports = typeof brush.dir === "number" ? " (ports " + G.portsText(G.rotatePorts(type.ports, brush.dir)) + ")" : "";
		return type.name + " · " + dirText() + ports;
	}

	function brushText() {
		const type = brushType();
		let text = brush.type === "random" ? "random valve type" : type ? type.name : "keep current type";
		if (type && typeof brush.dir === "number") text += " (ports " + G.portsText(G.rotatePorts(type.ports, brush.dir)) + ")";
		return text + " · " + dirText() + tintText();
	}

	function syncBrush() {
		for (const b of document.querySelectorAll("[data-type]")) {
			b.setAttribute("aria-pressed", b.dataset.type === brush.type ? "true" : "false");
		}
		const dir = brush.dir === null ? "" : String(brush.dir);
		for (const b of document.querySelectorAll("[data-dir]")) {
			b.setAttribute("aria-pressed", b.dataset.dir === dir ? "true" : "false");
		}
		const tint = brush.tint === null ? "" : String(brush.tint);
		for (const b of document.querySelectorAll("[data-tint]")) {
			b.setAttribute("aria-pressed", b.dataset.tint === tint ? "true" : "false");
		}
		$("brush-summary").textContent = "Double-click places: " + brushText();
		const nothing = brush.type === null && brush.dir === null && brush.tint === null;
		$("brush-detail").textContent = brushText() + (nothing ? " — pick a type or a direction, this changes nothing." : "");
	}

	function typeIcon(type) {
		let passage = "";
		if (type.id === "solid-elbow") {
			passage = '<path d="M 29 16 A 13 13 0 0 1 16 3"/>';
		} else {
			for (const p of type.ports) {
				passage += '<line x1="16" y1="16" x2="' + (16 + G.DX[p] * 13) + '" y2="' + (16 + G.DY[p] * 13) + '"/>';
			}
		}
		const chamber = type.kind === "hollow" ? '<circle class="chamber" cx="16" cy="16" r="6"/>' : "";
		return '<svg class="type-icon" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"><circle class="rotor" cx="16" cy="16" r="13"/>' + passage + chamber + "</svg>";
	}

	function typeRow(value, badge, name, note, copyId) {
		let row = '<div class="type-row"><button type="button" class="type-pick" data-type="' + value + '" aria-pressed="false">' + badge + "<span>" + name + "<small>" + note + "</small></span></button>";
		if (copyId) row += '<button type="button" class="copy-name" data-copy-type="' + copyId + '" title="Copy “' + name + '” (plus the selected direction) to the clipboard" aria-label="Copy name ' + name + '">⧉</button>';
		return row + "</div>";
	}

	function buildValveTypes() {
		let html = typeRow("random", '<span class="type-badge">?</span>', "? Random type", "any different type", "");
		let kind = "";
		for (const type of G.TYPES) {
			if (type.kind !== kind) {
				kind = type.kind;
				html += "<h4>" + kind + "</h4>";
			}
			html += typeRow(type.id, typeIcon(type), type.name, "ports " + G.portsText(type.ports) + " at 0°", type.id);
		}
		$("valve-types").innerHTML = html;

		let tHtml = '<button type="button" data-tint="-1" aria-pressed="false">Default grey</button>';
		for (const pl of R.PLAYERS) {
			tHtml += '<button type="button" data-tint="' + pl.id + '" aria-pressed="false"><span class="tint-dot" style="background:' + pl.hex + '"></span> ' + pl.name + "</button>";
		}
		$("tint-picker").innerHTML = tHtml;
	}

	$("valve-types").onclick = event => {
		const copy = event.target.closest("[data-copy-type]");
		if (copy) {
			const type = G.typeById(copy.dataset.copyType);
			if (type) copyText(typeText(type));
			return;
		}
		const pick = event.target.closest("[data-type]");
		if (!pick) return;
		// A second click on the selected button unselects it (not change).
		brush.type = pick.dataset.type === brush.type ? null : pick.dataset.type;
		syncBrush();
	};
	$("dir-picker").onclick = event => {
		const pick = event.target.closest("[data-dir]");
		if (!pick) return;
		const dir = pick.dataset.dir === "random" ? "random" : Number(pick.dataset.dir);
		brush.dir = dir === brush.dir ? null : dir;
		syncBrush();
	};
	$("tint-picker").onclick = event => {
		const pick = event.target.closest("[data-tint]");
		if (!pick) return;
		const tint = Number(pick.dataset.tint);
		brush.tint = tint === brush.tint ? null : tint;
		syncBrush();
	};

	function placeBrushAt(index) {
		if (game.mode === "game") return false;
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
			if (scene) {
				R.rebuildRotor(scene, layout, index);
				if (brush.tint !== null) R.rebuildBackground(scene, layout, sim.caseTint);
			}
			overlayDirty = true;
		} else if (done === "tint") {
			if (scene) R.rebuildBackground(scene, layout, sim.caseTint);
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
		const tintId = sim.caseTint[index];
		const tint = tintId >= 0 && R.PLAYERS[tintId] ? " · " + R.PLAYERS[tintId].name + " case" : "";
		return "cell (" + (v.i + 1) + "," + (v.j + 1) + ") · " + type.name + " · ports " + G.portsText(G.worldPorts(v, quarter)) + " · " + dir + tint;
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

	// ---- press-drag rotation + pointer gestures ------------------------------
	canvas.onpointerdown = event => {
		if (event.button && event.button !== 0) return;
		if (event.ctrlKey) return;
		pointerState(event);
		if (at.inlet >= 0 || !canPlayerTurn(at.cell)) return;
		selected = at.cell;
		const v = layout.valves[at.cell];
		drag.pointerId = event.pointerId === undefined ? 1 : event.pointerId;
		drag.cell = at.cell;
		drag.downX = drag.lastX = point.x;
		drag.downY = drag.lastY = point.y;
		drag.r0 = Math.hypot(point.x - v.cx, point.y - v.cy);
		drag.baseTarget = Math.round(sim.target[at.cell] / G.HALF_PI) * G.HALF_PI;
		drag.orbitAcc = 0;
		drag.active = false;
	};

	canvas.onpointermove = event => {
		if (drag.cell >= 0) {
			const w = worldFromPointer(event);
			if (!w) return;
			const moved = Math.hypot(w.x - drag.downX, w.y - drag.downY);
			if (!drag.active && moved >= 6) {
				drag.active = true;
				if (canvas.setPointerCapture && event.pointerId !== undefined) canvas.setPointerCapture(event.pointerId);
			}
			if (drag.active) {
				const v = layout.valves[drag.cell];
				const rMid = Math.hypot((drag.lastX + w.x) * 0.5 - v.cx, (drag.lastY + w.y) * 0.5 - v.cy);
				if (rMid > 5) {
					let da = Math.atan2(w.y - v.cy, w.x - v.cx) - Math.atan2(drag.lastY - v.cy, drag.lastX - v.cx);
					if (da > Math.PI) da -= G.TAU;
					else if (da < -Math.PI) da += G.TAU;
					drag.orbitAcc += da;
				}
				const quarters =
					drag.r0 < 10 && Math.abs(drag.orbitAcc) < 0.45
						? Math.round((w.x - drag.downX) / 26)
						: Math.trunc(drag.orbitAcc / G.HALF_PI + Math.sign(drag.orbitAcc) * 0.42);
				if (S.setTarget(sim, drag.cell, drag.baseTarget + quarters * G.HALF_PI)) {
					overlayDirty = true;
					shownIndex = -2;
				}
			}
			drag.lastX = w.x;
			drag.lastY = w.y;
			if (paused) drawFrame(true);
			return;
		}
		pointerState(event);
		setHover(at.inlet);
		selected = at.inlet >= 0 ? -1 : at.cell;
		if (paused) drawFrame(false);
	};

	function endDrag(event) {
		if (drag.cell < 0) return;
		if (drag.active) {
			drag.suppressClick = true;
			if (canvas.releasePointerCapture && event && event.pointerId !== undefined) {
				try {
					canvas.releasePointerCapture(event.pointerId);
				} catch {}
			}
		}
		drag.cell = -1;
		drag.active = false;
		drag.pointerId = -1;
		if (paused) drawFrame(false);
	}

	canvas.onpointerup = endDrag;
	canvas.onpointercancel = endDrag;
	canvas.onpointerleave = () => {
		if (drag.active) return;
		drag.cell = -1;
		if (document.activeElement === canvas) return;
		selected = -1;
		setHover(-1);
		if (paused) drawFrame(false);
	};
	canvas.onblur = () => {
		drag.cell = -1;
		drag.active = false;
		selected = -1;
		setHover(-1);
		if (paused) drawFrame(false);
	};
	canvas.onclick = event => {
		if (drag.suppressClick) {
			drag.suppressClick = false;
			return;
		}
		pointerState(event);
		if (at.inlet >= 0) {
			S.toggleInlet(sim, at.inlet, event.shiftKey);
			if (paused) drawFrame(true);
			return;
		}
		selected = at.cell;
		if (selected < 0 || event.detail > 1) return;
		if (event.ctrlKey) {
			if (game.mode !== "game") S.fillValve(sim, selected);
		} else turnSelected(event.shiftKey ? -1 : 1);
		if (paused) drawFrame(true);
	};
	canvas.ondblclick = event => {
		if (game.mode === "game") return;
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
			if (game.mode === "game") return;
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

	const FIELD_ALPHA = 0.62;

	// The pressure is state, not a difference between two live mouths: a sealed
	// machine keeps its air, so the overlay and its scale never disappear.
	function drawPressureGrid() {
		const gas = sim.pressure;
		fieldAlpha += (FIELD_ALPHA - fieldAlpha) * 0.16;
		if (!fieldMap || fieldMap.nx !== gas.nx || fieldMap.ny !== gas.ny) fieldMap = R.makeFieldMap(gas.nx, gas.ny);
		R.renderField(fieldMap, gas);
		ctx.save();
		ctx.globalAlpha = fieldAlpha;
		ctx.imageSmoothingEnabled = true;
		ctx.drawImage(fieldMap.canvas, 0, -G.POUR, gas.nx * gas.cell, gas.ny * gas.cell);
		ctx.restore();
	}

	function pressureState() {
		const gas = sim.pressure;
		if (!$("pressure-draw").checked || !gas || gas.kind !== "grid") return 0;
		return 1;
	}

	function pressureReason() {
		const gas = sim.pressure;
		if (!gas.pins) return " · all mouths sealed";
		if (!gas.sources) return " · no source open";
		if (!gas.vents) return " · no vent open";
		return "";
	}

	function syncLegend() {
		const state = pressureState();
		const reason = state ? pressureReason() : "";
		if (state === legendState && reason === legendReason && (state === 0 || legendLabel === pressureSpanLabel)) return;
		legendState = state;
		legendReason = reason;
		legendLabel = pressureSpanLabel;
		legendRange.hidden = state === 0;
		legendRange.textContent = state ? "· 0–" + pressureSpanLabel + " Pa equivalent" + reason : "";
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
		R.renderGoals(ctx, layout, game);
		R.renderSelection(ctx, layout, selected);
		R.renderDrag(ctx, layout, sim, drag);
		if (drawPressure && pressure.kind === "grid") R.renderPressureLegend(ctx, pressureSpanLabel);
		ctx.restore();
	}

	function formatStats(fps) {
		const purged = sim.purged > 0 ? " · purged " + sim.purged : "";
		let gas = "";
		if (sim.pressure && sim.pressure.kind === "grid") {
			const field = sim.pressure;
			gas = " · pressure " + field.mean.toFixed(2) + " · flow " + field.flow.toFixed(0) + " px/s" +
				(field.pins ? "" : " · sealed");
		}
		return (
			fps.toFixed(0).padStart(3) +
			" fps · seed " +
			layout.seed +
			" · auto " +
			Math.round(sim.autoRotate * 100) +
			"% · active " +
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
		if (!paused) {
			const steps = S.advance(sim, dt);
			if (steps > 0 && game.mode === "game") {
				Game.step(game, steps * S.STEP);
				Game.consumeDirty(game, scene);
				syncGameUI();
			}
		} else {
			// The air field only answers the mouths, so a paused page still lets it
			// settle while the grains stay frozen.
			S.settlePressure(sim, dt);
		}
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
