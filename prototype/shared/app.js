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
	// Press-drag tuning: a gesture has to travel before it does anything, and one
	// quarter turn costs a quarter turn of the hand (plus the grip slack and the
	// half-notch snap), so the rotor tracks the hand instead of outrunning it.
	const DRAG_ARM = 6;
	const DRAG_GRIP = 0.22;
	const DRAG_HUB_RADIUS = 12;
	const DRAG_HUB_GRIP = 9;
	const DRAG_HUB_STEP = 52;
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
		sweep: 0,
		quarters: 0,
		pull: 0,
		tick: 0,
		hub: false,
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
	let shownRosterVersion = -1;

	$("pressure-span").value = String(pressureSpan);
	if ($("auto-rotate").value === "") $("auto-rotate").value = "90";
	S.seed(sim);
	S.setAutoRotate(sim, readAutoPercent() / 100);
	S.setAirForce(sim, +$("force").value);
	S.setLubricant(sim, +$("lube").value);
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
		S.setLubricant(sim, +$("lube").value);
		S.seed(sim);
		S.setPressure(sim, readMode());
		Game.resetMatch(game, sim);
		if (game.mode !== "lab") setAutoSlider(Math.round(Game.autoFor(game.mode) * 100));
		rebuild(true);
		syncPressureRadios();
		shownIndex = -2;
		shownGameVersion = -1;
		shownRosterVersion = -1;
		if (paused) drawFrame(true);
	}

	function resetSim() {
		S.reset(sim);
		S.setSpeed(sim, +$("speed").value);
		S.setAutoRotate(sim, readAutoPercent() / 100);
		S.setAirForce(sim, +$("force").value);
		S.setLubricant(sim, +$("lube").value);
		S.seed(sim);
		if (game.mode !== "lab") {
			Game.resetMatch(game, sim);
			setAutoSlider(Math.round(Game.autoFor(game.mode) * 100));
		}
		rebuild(true);
		syncPressureRadios();
		shownIndex = -2;
		shownGameVersion = -1;
		shownRosterVersion = -1;
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
		return Game.canTurn(game, index);
	}

	function turnSelected(quarters) {
		if (!canPlayerTurn(selected)) {
			if (game.mode === "vent") Game.notice(game, "Vent mode is mouth-only control; valves still rotate on their automatic schedule.");
			return;
		}
		S.turn(sim, selected, quarters);
		overlayDirty = true;
		if (paused) drawFrame(true);
	}

	// ---- Lab / Game / Vent mode ---------------------------------------------
	const MODE_TITLES = { lab: "Lab bench", game: "Game goals", vent: "Vent seats" };

	function applyPlayMode(mode) {
		const lab = mode === "lab";
		const vent = mode === "vent";
		Game.setMode(game, mode);
		$("mode-lab").checked = lab;
		$("mode-game").checked = mode === "game";
		$("mode-vent").checked = vent;
		$("mode-title").textContent = MODE_TITLES[mode];
		$("game-panel").hidden = lab;
		$("quest-heading").hidden = vent;
		$("quest-list").hidden = vent;
		$("vent-heading").hidden = !vent;
		$("vent-list").hidden = !vent;
		$("mouth-hint").hidden = vent;
		$("vent-hint").hidden = !vent;
		$("add-seat").textContent = vent ? "Add seat" : "Add competitor";
		$("drain").disabled = !lab;
		$("pour").disabled = vent;
		$("open-valves").disabled = !lab;
		$("brush-summary").hidden = !lab;
		// A vent seat reads the grid gas; without it there is no pressure to hold.
		$("pressure-off").disabled = vent;
		$("pressure-particles").disabled = vent;
		if (!lab && openDrawerId === "valve-drawer") setDrawer(null);
		setAutoSlider(Math.round(Game.autoFor(mode) * 100));
		Game.consumeDirty(game, scene);
		if (lab && scene) R.rebuildBackground(scene, layout, sim.caseTint);
		syncPressureRadios();
		overlayDirty = true;
		shownIndex = -2;
		shownGameVersion = -1;
		shownRosterVersion = -1;
		syncGameUI();
		if (paused) drawFrame(true);
	}

	// G walks the three modes, so a keyboard never has to pass through Lab to
	// reach Vent.
	function nextMode(mode) {
		if (mode === "lab") return "game";
		if (mode === "game") return "vent";
		return "lab";
	}

	$("mode-lab").onchange = () => { if ($("mode-lab").checked) applyPlayMode("lab"); };
	$("mode-game").onchange = () => { if ($("mode-game").checked) applyPlayMode("game"); };
	$("mode-vent").onchange = () => { if ($("mode-vent").checked) applyPlayMode("vent"); };
	$("bot-enable").onchange = () => {
		Game.setBotControl(game, $("bot-enable").checked);
		syncGameUI();
	};
	$("new-match").onclick = resetSim;

	// The panel is split by what changes: the seat list only when a seat comes,
	// goes, or changes hands, and the mode's own list on every game version bump.
	function syncGameUI() {
		if (game.mode === "lab") return;
		syncRosterUI();
		if (game.version === shownGameVersion) return;
		shownGameVersion = game.version;
		syncPressureRadios();
		$("game-status").textContent = game.lastEvent;
		if (game.mode === "vent") syncVentUI();
		else syncQuestUI();
	}

	function rosterTask(player) {
		if (game.mode === "vent") {
			const seat = game.vent.seats[player.id];
			return seat && seat.bottle >= 0 ? "band " + seat.tag : "no route";
		}
		if (player.questId < 0) return "idle";
		for (let q = 0; q < game.quests.length; q++) {
			if (game.quests[q].id === player.questId) return game.quests[q].title;
		}
		return "idle";
	}

	function rosterScore(player) {
		if (game.mode !== "vent") return player.score + " pts (" + player.completed + ")";
		return player.score + " pts · " + player.completed + " held · " + player.failed + " lost";
	}

	function syncRosterUI() {
		if (game.rosterVersion === shownRosterVersion) return;
		shownRosterVersion = game.rosterVersion;
		const limit = game.mode === "vent" ? Game.VENT_MAX : Game.MAX_SEATS;
		let html = "";
		for (let p = 0; p < game.players.length; p++) {
			const pl = game.players[p];
			const held = pl.bot && !game.botControl ? " · paused" : "";
			html +=
				'<div class="player-row">' +
				'<span class="player-swatch" style="background:' + pl.hex + '"></span>' +
				"<strong>" + pl.name + held + "</strong>" +
				'<span class="player-task">' + rosterTask(pl) + "</span>" +
				'<span class="player-score">' + rosterScore(pl) + "</span>" +
				'<label class="player-bot"><input type="checkbox" data-bot="' + p + '"' + (pl.bot ? " checked" : "") + "> bot</label>" +
				'<button type="button" data-remove="' + p + '"' + (p === 0 ? " disabled" : "") + ">Remove</button>" +
				"</div>";
		}
		$("player-list").innerHTML = html;
		$("add-seat").disabled = game.players.length >= limit;
	}

	function syncVentUI() {
		let html = "";
		for (let s = 0; s < game.vent.count; s++) {
			const seat = game.vent.seats[s];
			const pl = game.players[seat.player];
			if (seat.bottle < 0) {
				html += '<div class="vent-row out"><strong>' + pl.name + '</strong><span>no route fits this seed</span></div>';
				continue;
			}
			const targetLeft = Math.max(0, Math.min(100, seat.lo * 100));
			const targetWidth = Math.max(0, Math.min(100 - targetLeft, (seat.hi - seat.lo) * 100));
			const current = Math.max(0, Math.min(100, seat.pressure * 100));
			html +=
				'<div class="vent-row' + (seat.ok ? " in" : " out") + '" data-seat="' + s + '" title="Select the collector on the field" style="--seat-accent:' + pl.accent + '">' +
				'<div class="vent-readout-head"><strong>' + pl.name + '</strong><span>' + seat.points + ' pts · ' + seat.rounds + ' held</span></div>' +
				'<div class="vent-readout-values"><span><small>LIVE PRESSURE</small><strong class="vent-current">' + seat.pressure.toFixed(2) + '</strong></span>' +
				'<span><small>REQUESTED RANGE</small><strong>' + seat.lo.toFixed(2) + '–' + seat.hi.toFixed(2) + '</strong></span></div>' +
				'<div class="vent-scale" role="img" aria-label="Pressure ' + seat.pressure.toFixed(2) + ', target ' + seat.lo.toFixed(2) + ' to ' + seat.hi.toFixed(2) + '">' +
				'<i class="vent-target-range" style="left:' + targetLeft.toFixed(2) + '%;width:' + targetWidth.toFixed(2) + '%"></i>' +
				'<i class="vent-current-marker' + (seat.ok ? "" : " outside") + '" style="left:' + current.toFixed(2) + '%"></i></div>' +
				'<div class="vent-scale-labels"><span>0</span><span>1</span></div>' +
				'<div class="vent-hold-row"><span>4 s hold</span><span class="vent-hold"><i style="width:' + Math.round(seat.holdRatio * 100) + '%"></i></span></div>' +
				"</div>";
		}
		$("vent-list").innerHTML = html;
	}

	function syncQuestUI() {
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
				'<div class="quest-foot"><span>' + (owner ? q.progressText : "Spawns " + q.bottles + "× " + (q.kind === "pressure" ? "hollow cross" : "hollow single ↑ N")) + "</span></div>" +
				"</div>";
		}
		$("quest-list").innerHTML = qHtml;
	}

	// A seat that came, went, or changed hands moves mouths and routes, so the scene
	// and the air overlay are rebuilt around the new seat list.
	function afterRosterChange() {
		Game.consumeDirty(game, scene);
		overlayDirty = true;
		shownIndex = -2;
		syncGameUI();
		if (paused) drawFrame(true);
	}

	$("player-list").onclick = event => {
		const remove = event.target.closest("[data-remove]");
		if (!remove) return;
		Game.removePlayer(game, Number(remove.dataset.remove));
		afterRosterChange();
	};

	$("player-list").onchange = event => {
		const box = event.target.closest("[data-bot]");
		if (!box) return;
		Game.setPlayerBot(game, Number(box.dataset.bot), box.checked);
		afterRosterChange();
	};

	// A vent row is the seat's locate button: the bottle is the only cell of the
	// rig a seat ever needs to look at.
	$("vent-list").onclick = event => {
		const row = event.target.closest("[data-seat]");
		if (!row) return;
		const seat = game.vent.seats[Number(row.dataset.seat)];
		if (!seat || seat.bottle < 0) return;
		selected = seat.bottle;
		canvas.focus();
		if (paused) drawFrame(false);
	};

	$("add-seat").onclick = () => {
		Game.addPlayer(game);
		afterRosterChange();
	};

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
			} else {
				Game.notice(game, "Could not sign that goal — its bottle has no free cell.");
				syncGameUI();
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
		if (game.mode === "vent") return;
		S.pour(sim, 24);
		if (paused) drawFrame(false);
	};
	$("drain").onclick = () => {
		if (game.mode !== "lab") return;
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
		if (game.mode !== "lab") {
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
	$("lube").oninput = () => {
		S.setLubricant(sim, +$("lube").value);
		$("lube-value").value = $("lube").value;
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
		else if ((event.key === "v" || event.key === "V") && game.mode === "lab") toggleDrawer("valve-drawer");
		else if (event.key === "g" || event.key === "G") applyPlayMode(nextMode(game.mode));
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
	// The hand drives a dial around the rotor: a quarter turn of travel buys one
	// detent, with a little grip slack before it moves and a half-notch snap
	// before it steps, so a small wobble never flips the target. A press close to
	// the hub pulls horizontally across detents instead of orbiting.
	//
	// Signed detent pull for the current pointer x: + clockwise, - the other way.
	// The orbital hand is measured in radians, the hub pull in pixels, so each
	// mode carries its own slack and its own distance per detent.
	function dragPull(x) {
		const travel = drag.hub ? x - drag.downX : drag.orbitAcc;
		const slack = drag.hub ? DRAG_HUB_GRIP : DRAG_GRIP;
		const unit = drag.hub ? DRAG_HUB_STEP : G.HALF_PI;
		const mag = Math.max(0, Math.abs(travel) - slack) / unit;
		drag.pull = drag.hub ? travel : 0;
		drag.sweep = (travel < 0 ? -mag : mag) * G.HALF_PI;
		return travel < 0 ? -mag : mag;
	}

	function cursorFor() {
		if (drag.active) return "grabbing";
		if (at.inlet >= 0) return S.canPressInlet(sim, at.inlet, 0) ? "pointer" : "not-allowed";
		if (at.cell >= 0 && canPlayerTurn(at.cell)) return "grab";
		return "default";
	}

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
		drag.sweep = 0;
		drag.quarters = 0;
		drag.pull = 0;
		drag.tick = DRAG_HUB_STEP;
		// The mode is fixed where the press landed: near the hub it is a
		// horizontal pull, on the rim it is an orbit, and it cannot flip halfway.
		drag.hub = drag.r0 < DRAG_HUB_RADIUS;
		drag.active = false;
	};

	canvas.onpointermove = event => {
		if (drag.cell >= 0) {
			const w = worldFromPointer(event);
			if (!w) return;
			const moved = Math.hypot(w.x - drag.downX, w.y - drag.downY);
			if (!drag.active && moved >= DRAG_ARM) {
				drag.active = true;
				canvas.style.cursor = "grabbing";
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
				const quarters = Math.round(dragPull(w.x));
				// A short tick as the dial crosses a detent: the gesture's only non-visual cue.
				if (quarters !== drag.quarters && navigator.vibrate) navigator.vibrate(6);
				drag.quarters = quarters;
				if (S.setTarget(sim, drag.cell, drag.baseTarget + drag.quarters * G.HALF_PI)) {
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
		canvas.style.cursor = cursorFor();
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
		drag.hub = false;
		drag.sweep = 0;
		drag.pull = 0;
		drag.quarters = 0;
		drag.pointerId = -1;
		canvas.style.cursor = "default";
		if (paused) drawFrame(false);
	}

	canvas.onpointerup = endDrag;
	canvas.onpointercancel = endDrag;
	canvas.onpointerleave = () => {
		if (drag.active) return;
		drag.cell = -1;
		if (document.activeElement === canvas) return;
		canvas.style.cursor = "default";
		selected = -1;
		setHover(-1);
		if (paused) drawFrame(false);
	};
	canvas.onblur = () => {
		drag.cell = -1;
		drag.active = false;
		drag.hub = false;
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
			// A mouth answers only to the seat that owns it, and only while a person
			// plays that seat. It keeps its in/out role, so the shift-click swap stays
			// a Lab-mode move.
			const actor = Game.pressActor(game, at.inlet);
			if (actor < 0) {
				refuseMouth(at.inlet);
				return;
			}
			const pressed = S.toggleInlet(sim, at.inlet, event.shiftKey, actor);
			if (!pressed) {
				Game.notice(game, "A dealt mouth keeps its in/out role — the polarity swap is a Lab move.");
				syncGameUI();
			}
			if (paused) drawFrame(pressed);
			return;
		}
		selected = at.cell;
		if (selected < 0 || event.detail > 1) return;
		if (event.ctrlKey) {
			if (game.mode === "lab") S.fillValve(sim, selected);
		} else turnSelected(event.shiftKey ? -1 : 1);
		if (paused) drawFrame(true);
	};
	// The status line answers a press that was not allowed, naming the seat that
	// holds the mouth instead of leaving the click silently dead.
	function refuseMouth(inlet) {
		const owner = sim.inlets.owner[inlet];
		const player = owner >= 0 ? game.players[owner] : null;
		if (!player) {
			Game.notice(game, game.mode === "vent" ? "Only your source and vent mouths are in the bands here." : "No mouth was dealt in that slot.");
		} else if (player.bot) {
			Game.notice(game, player.name + " is bot controlled — untick its bot box to play that seat.");
		} else {
			Game.notice(game, "That mouth belongs to " + player.name + ".");
		}
		syncGameUI();
	}

	canvas.ondblclick = event => {
		if (game.mode !== "lab") return;
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
			if (game.mode !== "lab") return;
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
		// Mouths sit under the grain piles that share the bands; the ownership
		// tabs are redrawn above them so a player's own mouths never get buried.
		R.renderInlets(ctx, sim.inlets, hoverInlet);
		R.renderGrains(ctx, sim, scene);
		R.renderInletBadges(ctx, sim.inlets, hoverInlet);
		R.renderGoals(ctx, layout, game);
		R.renderVents(ctx, layout, game);
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
			if (steps > 0 && game.mode !== "lab") {
				Game.step(game, steps * S.STEP);
				Game.consumeDirty(game, scene);
				syncGameUI();
			}
		} else {
			// A paused page still lets the air field settle while grains stay frozen.
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
