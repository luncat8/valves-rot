(() => {
        "use strict";

        const G = ValveGeometry;
        const R = ValveRender;
        const S = ValveSimulation;
        const I = ValveInlets;
        const C = ValveCalibration;
        const Game = ValveGame;
        const Water = ValveWater;
        const Heat = ValveHeat;
        const $ = id => document.getElementById(id);

        const HEIGHT = G.SIZE + G.POUR * 2 + G.VENT_STRIP;
        const canvas = $("c");
        const ctx = canvas.getContext("2d");
        const legendRange = $("legend-range");
        const airMap = R.makeAirMap(4);
        const paint = { air: "#ffffff", skin: "glm" };
        const stats = { frames: 0, clock: 0 };
        const point = { x: 0, y: 0 };
        const at = { vent: -1, inlet: -1, cell: -1 };
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
                // A Lab press held still arms the selection long press; the
                // pre-press selection is remembered because the press itself
                // selects, and the toggle has to be relative to what was there.
                holdTimer: 0,
                holdCell: -1,
                selectBefore: -1,
                setBefore: null,
        };
        // Water source vent gesture, tuned like the valve dial: a slide arms after the
        // same travel, locks its axis to the first dominant movement (left/right picks
        // the hue, up/down the rate), one vent width sweeps a full hue revolution, and
        // this much vertical travel spans the whole rate range. A press that outlives
        // the long-click delay without moving toggles the vent.
        const VENT_ARM = 6;
        const VENT_LONG_PRESS = 480;
        const VALVE_LONG_PRESS = 480;
        const VENT_HUE_DEG_PX = 360 / G.S;
        const VENT_RATE_TRAVEL = 60;
        const ventDrag = {
                pointerId: -1,
                column: -1,
                armed: false,
                axis: 0,
                downX: 0,
                downY: 0,
                lastX: 0,
                lastY: 0,
                hue: 0,
                timer: 0,
                suppressClick: false,
        };
        // Reused share triple for gesture math; no allocation per move.
        const ventShares = new Float64Array(3);
        // Column of the vent a canvas picker session is editing.
        let pickerColumn = -1;
        let hoverVent = -1;
        // Last value the global column slider showed, so a move sweeps from there.
        let panelColumn = 5;

        let layout = G.createLayout(readSeed());
        let sim = S.create(layout);
        let game = Game.create(sim, { mode: "lab", botControl: true });
        let scene = null;
        let paused = false;
        let selected = -1;
        // Selection is explicit state, never a hover: `selected` is the anchor
        // the keyboard and the panels edit, and `selectedSet` is every cell the
        // Heat panel's Power slider applies to (the anchor is always its newest
        // member). A plain click replaces the set; Shift-click in Lab, a still
        // ~½ s press, or the panel buttons change it; nothing follows the cursor,
        // so a selection survives moving the hand away to reach a control.
        const selectedSet = new Set();
        let selectionVersion = 0;
        let hoverCell = -1;

        function setSelection(cell) {
                selected = cell;
                selectedSet.clear();
                if (cell >= 0) selectedSet.add(cell);
                selectionVersion++;
        }

        function toggleSelection(cell) {
                if (cell < 0) return;
                if (selectedSet.has(cell)) {
                        selectedSet.delete(cell);
                        if (selected === cell) selected = selectedSet.size ? selectedSet.values().next().value : -1;
                } else {
                        selectedSet.add(cell);
                        selected = cell;
                }
                selectionVersion++;
        }
        let hoverInlet = -1;
        let fieldMap = null;
        let pressureSpan = Number(C.DEFAULT_SPAN.toPrecision(6));
        let pressureSpanLabel = C.format(pressureSpan);
        let legendState = -1;
        let legendLabel = "";
        let legendReason = "";
        let fieldAlpha = 0;
        let waterField = null;
        let waterMap = null;
        // Display-only: 0 paints the liquid's own channels, 1 paints pigment level.
        let waterView = 0;
        // Heat overlays: the temperature field and the valve source badges. The
        // liquid sheet dims while the temperature view is on so both read.
        let heatViewOn = false;
        let heatMap = null;
        let heatSelSeen = -1;
        // Heat model scales relative to the shipped parameter table (ValveHeat.PARAMS),
        // edited live by the Capacity and Latent sliders in the Heat panel.
        let capacityScale = 1;
        let latentScale = 1;
        // Reused for the per-channel readout, so the status line allocates no array.
        const waterChannels = new Float64Array(3);
        // Inlet colour boxes: element id and the channel it selects.
        const POUR_IDS = [["water-pour-r", 0], ["water-pour-g", 1], ["water-pour-b", 2]];
        // Mixability boxes: element id and the channel it flags.
        const MIX_IDS = [["water-mix-r", 0], ["water-mix-g", 1], ["water-mix-b", 2]];
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
        let shownSelSize = -1;
        let shownQuarter = -1;
        let shownGameVersion = -1;
        let shownRosterVersion = -1;

        $("pressure-span").value = String(pressureSpan);
        if ($("auto-rotate").value === "") $("auto-rotate").value = "90";
        S.seed(sim);
        S.setAutoRotate(sim, readAutoPercent() / 100);
        S.setAirForce(sim, +$("force").value);
        S.setLubricant(sim, +$("lube").value);
        S.setLubricantStress(sim, +$("lube-stress").value);
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
                // The display grid is built for one water mask; a new field gets a new one.
                waterField = null;
                waterMap = null;
                S.setSpeed(sim, +$("speed").value);
                S.setAutoRotate(sim, readAutoPercent() / 100);
                S.setAirForce(sim, +$("force").value);
                S.setLubricant(sim, +$("lube").value);
                S.setLubricantStress(sim, +$("lube-stress").value);
                S.seed(sim);
                S.setPressure(sim, readMode());
                if ($("water-on").checked) applyWater();
                else syncWaterUI();
                syncHeatUI();
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
                S.setLubricantStress(sim, +$("lube-stress").value);
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

        // Pointer in world coordinates: [-POUR - VENT_STRIP, SIZE + POUR] vertically.
        function worldFromPointer(event) {
                const b = canvas.getBoundingClientRect();
                if (!(b.width > 0 && b.height > 0)) return null;
                point.x = ((event.clientX - b.left) / b.width) * G.SIZE;
                point.y = ((event.clientY - b.top) / b.height) * HEIGHT - G.POUR - G.VENT_STRIP;
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
                if (game.mode === "vent") {
                        if (Game.ventTurn(game, selected, quarters)) {
                                overlayDirty = true;
                                shownIndex = -2;
                                syncGameUI();
                                if (paused) drawFrame(true);
                                return;
                        }
                        Game.notice(game, Game.ventRefusal(game, selected));
                        syncGameUI();
                        return;
                }
                if (!canPlayerTurn(selected)) return;
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
                syncWaterUI();
                syncHeatUI();
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

        // A bot's difficulty is its pace, so the row carries the level it plays at.
        function levelOptions(level) {
                let out = "";
                for (let k = 0; k < Game.BOT_RATES.length; k++) {
                        out += '<option value="' + k + '"' + (k === level ? " selected" : "") + ">" + Game.BOT_LEVEL_NAMES[k] + "</option>";
                }
                return out;
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
                                '<select class="player-level" data-level="' + p + '" title="Bot pace: map changes per second">' + levelOptions(pl.botLevel) + "</select>" +
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
                        const turn = s === game.vent.turn;
                        const pass = turn && !pl.bot ? '<button type="button" data-pass="' + s + '">Pass</button>' : "";
                        const targetLeft = Math.max(0, Math.min(100, seat.lo * 100));
                        const targetWidth = Math.max(0, Math.min(100 - targetLeft, (seat.hi - seat.lo) * 100));
                        const current = Math.max(0, Math.min(100, seat.pressure * 100));
                        html +=
                                '<div class="vent-row' + (seat.ok ? " in" : " out") + (turn ? " turn" : "") + '" data-seat="' + s + '" title="Select the collector on the field" style="--seat-accent:' + pl.accent + '">' +
                                '<div class="vent-readout-head"><strong>' + pl.name + '</strong><span>' + seat.points + ' pts · ' + seat.rounds + ' held</span></div>' +
                                '<div class="vent-readout-values"><span><small>LIVE PRESSURE</small><strong class="vent-current">' + seat.pressure.toFixed(2) + '</strong></span>' +
                                '<span><small>REQUESTED RANGE</small><strong>' + seat.lo.toFixed(2) + '–' + seat.hi.toFixed(2) + '</strong></span></div>' +
                                '<div class="vent-scale" role="img" aria-label="Pressure ' + seat.pressure.toFixed(2) + ', target ' + seat.lo.toFixed(2) + ' to ' + seat.hi.toFixed(2) + '">' +
                                '<i class="vent-target-range" style="left:' + targetLeft.toFixed(2) + '%;width:' + targetWidth.toFixed(2) + '%"></i>' +
                                '<i class="vent-current-marker' + (seat.ok ? "" : " outside") + '" style="left:' + current.toFixed(2) + '%"></i></div>' +
                                '<div class="vent-scale-labels"><span>0</span><span>1</span></div>' +
                                '<div class="vent-hold-row"><span>4 s hold</span><span class="vent-hold"><i style="width:' + Math.round(seat.holdRatio * 100) + '%"></i></span></div>' +
                                (turn ? '<div class="vent-turn"><span>' + (pl.bot ? "Bot turn — one valve" : "Your turn — turn one valve") + "</span>" + pass + "</div>" : "") +
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
                const level = event.target.closest("[data-level]");
                if (level) {
                        Game.setPlayerLevel(game, Number(level.dataset.level), Number(level.value));
                        afterRosterChange();
                        return;
                }
                const box = event.target.closest("[data-bot]");
                if (!box) return;
                Game.setPlayerBot(game, Number(box.dataset.bot), box.checked);
                afterRosterChange();
        };

        // A vent row is the seat's locate button: the bottle is the only cell of the
        // rig a seat ever needs to look at.
        $("vent-list").onclick = event => {
                if (event.target.closest("[data-pass]")) {
                        if (Game.passVentTurn(game)) syncGameUI();
                        if (paused) drawFrame(true);
                        return;
                }
                const row = event.target.closest("[data-seat]");
                if (!row) return;
                const seat = game.vent.seats[Number(row.dataset.seat)];
                if (!seat || seat.bottle < 0) return;
                setSelection(seat.bottle);
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
                                        if (game.quests[k].id === id && game.quests[k].cellCount > 0) setSelection(game.quests[k].cells[0]);
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
                                        setSelection(game.quests[k].cells[0]);
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
                $("force-value").value = $("force").value + "×";
                if (paused) drawFrame(false);
        };
        $("lube").oninput = () => {
                S.setLubricant(sim, +$("lube").value);
                $("lube-value").value = $("lube").value;
                if (paused) drawFrame(false);
        };
        $("lube-stress").oninput = () => {
                S.setLubricantStress(sim, +$("lube-stress").value);
                $("lube-stress-value").value = $("lube-stress").value + "×";
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
                // Refused while water is on; syncPressureRadios puts the radios back.
                S.setPressure(sim, readMode());
                syncPressureRadios();
                overlayDirty = true;
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

        // ---- water --------------------------------------------------------------
        // Water is off by default, so the dry baseline is untouched. Turning it on
        // parks the air backend (the two are exclusive for now) and turning it off
        // gives the player their previous pressure mode back.
        const picker = $("water-picker");

        function syncWaterUI() {
                const on = !!(sim.water && sim.water.enabled);
                $("water-on").checked = on;
                // Game and vent run the grid gas, which water parks: the checkbox
                // is a Lab tool while those modes are up.
                $("water-on").disabled = game.mode !== "lab";
                $("water-vent").disabled = !on;
                $("water-column").disabled = !on;
                $("water-rate").disabled = !on;
                $("water-drain").disabled = !on;
                for (const [id, k] of POUR_IDS) {
                        $(id).disabled = !on;
                        $(id).checked = sim.water ? !!sim.water.pourMask[k] : $(id).checked;
                }
                for (const [id, k] of MIX_IDS) {
                        $(id).disabled = !on;
                        $(id).checked = sim.water ? !!sim.water.mixable[k] : $(id).checked;
                }
                $("water-vent").checked = on && sim.water.ventOpen;
                const rate = sim.water ? sim.water.rate : +$("water-rate").value;
                $("water-rate-value").value = Math.round(rate) + " px²/s";
                // The column slider points at the current vent: the one every other
                // water control edits.
                const column = sim.water ? sim.water.ventColumn : +$("water-column").value - 1;
                $("water-column").value = String(column + 1);
                $("water-column-value").value = String(column + 1);
                panelColumn = column;
                $("pressure-particles").disabled = on;
                $("pressure-grid").disabled = on;
                syncPressureRadios();
        }

        function applyWater() {
                const on = $("water-on").checked;
                S.setWater(sim, on);
                if (on) {
                        // The vent's column is the player's chosen column, clamped to the field.
                        const w = sim.water;
                        Water.setVent(w, +$("water-column").value - 1, $("water-vent").checked);
                        Water.setSupply(w, +$("water-rate").value);
                }
                syncWaterUI();
                if (paused) drawFrame(true);
        }

        $("water-on").onchange = applyWater;
        $("water-vent").onchange = () => {
                if (!sim.water) return;
                Water.setVent(sim.water, sim.water.ventColumn, $("water-vent").checked);
                if (paused) drawFrame(false);
        };
        // The global column control is a brush: moving it stamps the current vent's
        // settings onto every vent it passes, so setting red and sweeping the slider
        // from 1 to 10 turns the whole row red. Clicking a tab on the canvas selects
        // a vent without stamping anything.
        $("water-column").oninput = () => {
                if (!sim.water) return;
                Water.sweepVents(sim.water, panelColumn, +$("water-column").value - 1);
                panelColumn = sim.water.ventColumn;
                $("water-column-value").value = String(panelColumn + 1);
                syncWaterUI();
                if (paused) drawFrame(false);
        };
        $("water-rate").oninput = () => {
                if (sim.water) Water.setSupply(sim.water, +$("water-rate").value);
                $("water-rate-value").value = Math.round(+$("water-rate").value) + " px²/s";
        };
        $("water-drain").onclick = () => {
                if (sim.water) Water.drainAll(sim.water);
                if (paused) drawFrame(true);
        };
        // Pour colours split the current vent's rate equally; the last one stays on,
        // and the module refuses an empty mask, so the boxes are re-synced from state.
        // A hue-picked vent mirrors back as every channel it uses, so editing from the
        // boxes snaps the vent to that equal-share mix.
        function applyPour() {
                if (!sim.water) return;
                const mask = [0, 0, 0];
                for (const [id, k] of POUR_IDS) mask[k] = $(id).checked ? 1 : 0;
                Water.setPour(sim.water, mask);
                syncWaterUI();
        }
        for (const [id] of POUR_IDS) $(id).onchange = applyPour;
        // Mixability regroups the channels into phases; every combination holds,
        // including none mixable, so the boxes are never refused or re-synced. The
        // partition redraws at once: the same channels read as different layers.
        function applyMix() {
                if (!sim.water) return;
                const mask = [0, 0, 0];
                for (const [id, k] of MIX_IDS) mask[k] = $(id).checked ? 1 : 0;
                Water.setMixable(sim.water, mask);
                if (paused) drawFrame(false);
        }
        for (const [id] of MIX_IDS) $(id).onchange = applyMix;
        const applyView = () => {
                waterView = $("water-view-pigment").checked ? 1 : 0;
                if (paused) drawFrame(false);
        };
        $("water-view-color").onchange = applyView;
        $("water-view-pigment").onchange = applyView;
        syncWaterUI();

        // ---- heat -------------------------------------------------------------
        // Heat lives on the water grid: enabling it enables water with every vent
        // shut, and disabling water disables heat while each valve keeps its power.
        // The Power slider edits EVERY selected valve — click selects one,
        // Shift-click or a long press builds a multi-selection, and the Select
        // all / Unselect buttons set or clear it; a selection change re-reads
        // the anchor's power and the set's size.
        function syncHeatUI() {
                const h = sim.heat;
                const on = !!(h && h.enabled);
                $("heat-on").checked = on;
                // Heat rides the water grid, so it parks with water outside Lab.
                $("heat-on").disabled = game.mode !== "lab";
                $("heat-power").disabled = !on || selected < 0;
                // The bulk-selection buttons are heat-panel tools: they edit the
                // set the Power slider applies to.
                $("heat-select-all").disabled = !on || game.mode !== "lab";
                $("heat-unselect").disabled = !on;
                $("heat-ambient").disabled = !on;
                $("heat-view").disabled = !on;
                $("heat-capacity").disabled = !on;
                $("heat-latent").disabled = !on;
                if (on) {
                        $("heat-capacity").value = String(capacityScale);
                        $("heat-capacity-value").value = "×" + capacityScale.toFixed(2);
                        $("heat-latent").value = String(latentScale);
                        $("heat-latent-value").value = "×" + latentScale.toFixed(2);
                        if (selected >= 0) {
                                $("heat-power").value = String(h.power[selected]);
                                $("heat-power-value").value = Math.round(h.power[selected]) + " E/s" + (selectedSet.size > 1 ? " · " + selectedSet.size + " valves" : "");
                        } else {
                                // The slider is disabled with no valve selected, so its
                                // numeric value is meaningless; say so instead of showing
                                // "0 E/s" and looking broken.
                                $("heat-power").value = "0";
                                $("heat-power-value").value = "— select a valve";
                        }
                        $("heat-ambient").value = String(h.p.ambient);
                } else {
                        $("heat-power-value").value = "— select a valve";
                }
                $("heat-view").checked = on && heatViewOn;
        }

        function applyHeat() {
                S.setHeat(sim, $("heat-on").checked);
                syncHeatUI();
                syncWaterUI();
                if (paused) drawFrame(true);
        }

        $("heat-on").onchange = applyHeat;
        $("heat-power").oninput = () => {
                if (!sim.heat || selected < 0) return;
                const value = +$("heat-power").value;
                // One sweep heats or cools the whole selection: every cell in the
                // set takes the slider's value.
                for (const k of selectedSet) Heat.setPower(sim.heat, k, value);
                $("heat-power-value").value = Math.round(value) + " E/s" + (selectedSet.size > 1 ? " · " + selectedSet.size + " valves" : "");
                if (paused) drawFrame(false);
        };
        // Bulk selection from the panel: every valve at once, or none. Select all
        // keeps the current anchor so the readout keeps its context, and falls
        // back to the field's centre cell — the keyboard's default — when nothing
        // is selected.
        $("heat-select-all").onclick = () => {
                if (game.mode !== "lab" || !(sim.heat && sim.heat.enabled)) return;
                const keep = selected >= 0 ? selected : (((G.N >> 1) - 1) * G.N + (G.N >> 1) - 1);
                selectedSet.clear();
                for (let k = 0; k < layout.valves.length; k++) selectedSet.add(k);
                selected = selectedSet.has(keep) ? keep : 0;
                selectionVersion++;
                if (paused) drawFrame(false);
        };
        $("heat-unselect").onclick = () => {
                setSelection(-1);
                if (paused) drawFrame(false);
        };
        $("heat-ambient").oninput = () => {
                if (sim.heat) Heat.setAmbient(sim.heat, +$("heat-ambient").value, undefined, true);
                if (paused) drawFrame(false);
        };
        // Capacity and Latent are model knobs, not weights: they rescale the whole
        // field's specific heats (metal, liquid, grains) or latent book against the
        // shipped parameter table, live, through the same validating setParams the
        // fixtures use. A refused set (unstable parameter mix) snaps the slider back
        // to the last applied scale; setParams is atomic, so nothing half-applies.
        function applyModelScale(which, value) {
                const h = sim.heat;
                if (!h) return;
                const scale = Math.min(2, Math.max(0.25, value));
                const base = ValveHeat.PARAMS;
                const ok = which === "capacity"
                        ? Heat.setParams(h, { metalHeat: base.metalHeat * scale, liquidHeat: base.liquidHeat * scale, grainHeat: base.grainHeat * scale })
                        : Heat.setParams(h, { latent: [base.latent[0] * scale, base.latent[1] * scale, base.latent[2] * scale] });
                if (ok) {
                        if (which === "capacity") capacityScale = scale; else latentScale = scale;
                }
                const applied = which === "capacity" ? capacityScale : latentScale;
                $(which === "capacity" ? "heat-capacity" : "heat-latent").value = String(applied);
                $(which === "capacity" ? "heat-capacity-value" : "heat-latent-value").value = "×" + applied.toFixed(2);
                if (paused) drawFrame(false);
        }
        $("heat-capacity").oninput = () => applyModelScale("capacity", +$("heat-capacity").value);
        $("heat-latent").oninput = () => applyModelScale("latent", +$("heat-latent").value);
        $("heat-view").onchange = () => {
                heatViewOn = $("heat-view").checked;
                if (paused) drawFrame(false);
        };

        // The temperature view is one texel per water cell over the whole machine,
        // metal and passages alike, on a fixed labelled 0..240 °C scale; the liquid
        // sheet is dimmed under it so hue and temperature read together.
        function drawHeatMap() {
                const h = sim.heat;
                if (!heatMap || heatMap.nx !== h.nx || heatMap.ny !== h.ny) heatMap = R.makeFieldMap(h.nx, h.ny);
                R.renderHeat(heatMap, h);
                ctx.save();
                ctx.globalAlpha = 0.58;
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(heatMap.canvas, 0, -G.POUR, h.nx * h.cell, h.ny * h.cell);
                ctx.restore();
        }

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

        // Refreshed from drawFrame only when the selection, valve, its target
        // detent or the set size changed, so the frame loop keeps building no
        // strings.
        function syncSelectedValve() {
                if (selected < 0) {
                        if (shownIndex === -1 && shownSelSize === 0) return;
                        shownIndex = -1;
                        shownSelSize = 0;
                        shownValve = null;
                        $("selected-valve").textContent = "Click a valve to select it — Shift-click or hold to add more.";
                        return;
                }
                const v = sim.layout.valves[selected];
                const quarter = G.quarterOf(sim.target[selected]);
                const size = selectedSet.size;
                if (shownIndex === selected && shownValve === v && shownQuarter === quarter && shownSelSize === size) return;
                shownIndex = selected;
                shownValve = v;
                shownQuarter = quarter;
                shownSelSize = size;
                // The anchor's card, with the set's size appended when the
                // selection is more than one cell: the Power slider edits every
                // cell the count names.
                $("selected-valve").textContent = valveText(selected) + (size > 1 ? " · " + size + " cells selected" : "");
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

        function setHoverVent(vent) {
                if (hoverVent === vent) return;
                hoverVent = vent;
        }

        // The water vent strip above the pour band, one tab per column.
        function ventHit(x, y) {
                if (!sim.water || !sim.water.enabled) return -1;
                if (y < -G.POUR - G.VENT_STRIP || y >= -G.POUR) return -1;
                return Math.max(0, Math.min(G.N - 1, (x / G.S) | 0));
        }

        function pointerState(event) {
                const w = worldFromPointer(event);
                at.vent = w ? ventHit(w.x, w.y) : -1;
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
                if (at.vent >= 0) return "pointer";
                if (at.inlet >= 0) return S.canPressInlet(sim, at.inlet, 0) ? "pointer" : "not-allowed";
                if (at.cell >= 0 && canPlayerTurn(at.cell)) return "grab";
                return "default";
        }

        // ---- water source vent gestures -----------------------------------------
        // The strip tabs are controls in their own right: a plain click selects the
        // vent the global panel edits, a slide arms like the valve dial and locks its
        // axis (left/right sweeps the hue, up/down the rate), a double click opens the
        // colour picker, and a press held still past the long-click delay toggles the
        // vent open or shut. A gesture also makes its vent current, so the panel and
        // the column slider follow the hand.
        function ventSharesOf(column) {
                const w = sim.water;
                const o = column * Water.CH;
                ventShares[0] = w.ventShares[o];
                ventShares[1] = w.ventShares[o + 1];
                ventShares[2] = w.ventShares[o + 2];
                return ventShares;
        }

        function beginVentPress(event) {
                ventDrag.pointerId = event.pointerId === undefined ? 1 : event.pointerId;
                ventDrag.column = at.vent;
                ventDrag.armed = false;
                ventDrag.axis = 0;
                ventDrag.downX = ventDrag.lastX = point.x;
                ventDrag.downY = ventDrag.lastY = point.y;
                ventDrag.hue = Water.sharesHue(ventSharesOf(at.vent));
                ventDrag.suppressClick = false;
                ventDrag.timer = setTimeout(ventLongPress, VENT_LONG_PRESS);
        }

        function ventLongPress() {
                ventDrag.timer = 0;
                if (ventDrag.column < 0 || ventDrag.armed) return;
                Water.toggleVent(sim.water, ventDrag.column);
                ventDrag.suppressClick = true;
                if (navigator.vibrate) navigator.vibrate(10);
                syncWaterUI();
                if (paused) drawFrame(true);
        }

        // A Lab press held still past the delay toggles its cell into the
        // selection — the touch answer to Shift-click. The press itself had
        // selected the cell, so the pre-press selection is restored first and
        // the toggle is relative to it; the release's click is consumed, so the
        // hold never turns the valve.
        function valveLongPress() {
                drag.holdTimer = 0;
                if (drag.holdCell < 0 || drag.active) return;
                const cell = drag.holdCell;
                drag.holdCell = -1;
                selected = drag.selectBefore;
                selectedSet.clear();
                if (drag.setBefore) for (const k of drag.setBefore) selectedSet.add(k);
                toggleSelection(cell);
                drag.suppressClick = true;
                drag.cell = -1;
                canvas.style.cursor = cursorFor();
                if (navigator.vibrate) navigator.vibrate(10);
                if (paused) drawFrame(false);
        }

        function armVentSlide(event, w) {
                ventDrag.armed = true;
                // The axis is fixed by the first dominant movement, like the dial fixes
                // hub pull against rim orbit where the press landed.
                ventDrag.axis = Math.abs(w.x - ventDrag.downX) >= Math.abs(w.y - ventDrag.downY) ? 0 : 1;
                ventDrag.suppressClick = true;
                clearTimeout(ventDrag.timer);
                ventDrag.timer = 0;
                ventDrag.hue = Water.sharesHue(ventSharesOf(ventDrag.column));
                // Guarded like the release in endVentPress: a pointer that is no longer
                // active must not kill the gesture mid-arm.
                if (canvas.setPointerCapture && event.pointerId !== undefined) {
                        try {
                                canvas.setPointerCapture(event.pointerId);
                        } catch {}
                }
        }

        function applyVentSlide(dx, dy) {
                const c = ventDrag.column;
                if (ventDrag.axis === 0) {
                        ventDrag.hue = (((ventDrag.hue + dx * VENT_HUE_DEG_PX) % 360) + 360) % 360;
                        Water.setVentShares(sim.water, c, Water.hueShares(ventDrag.hue, ventShares));
                } else {
                        Water.setVentRate(sim.water, c, sim.water.ventRate[c] - dy * (sim.water.rateMax / VENT_RATE_TRAVEL));
                }
                Water.selectVent(sim.water, c);
                syncWaterUI();
        }

        function endVentPress(event) {
                if (ventDrag.column < 0) return;
                if (ventDrag.timer) {
                        clearTimeout(ventDrag.timer);
                        ventDrag.timer = 0;
                }
                if (ventDrag.armed && canvas.releasePointerCapture && event && event.pointerId !== undefined) {
                        try {
                                canvas.releasePointerCapture(event.pointerId);
                        } catch {}
                }
                ventDrag.column = -1;
                ventDrag.armed = false;
                if (paused) drawFrame(false);
        }

        canvas.onpointerdown = event => {
                if (event.button && event.button !== 0) return;
                if (event.ctrlKey) return;
                pointerState(event);
                if (at.vent >= 0) {
                        beginVentPress(event);
                        return;
                }
                if (at.inlet >= 0) return;
                // In Lab a Shift press is the selection toggle, not a turn, so it
                // must not replace the set the release's click will toggle. Game
                // and Vent keep Shift as the reverse turn and the turn gate as
                // before.
                const shifting = event.shiftKey && game.mode === "lab" && at.cell >= 0;
                if (!shifting && !canPlayerTurn(at.cell)) return;
                drag.selectBefore = selected;
                drag.setBefore = new Set(selectedSet);
                if (!shifting) setSelection(at.cell);
                // A Lab press held still past the delay toggles its cell into the
                // selection; any movement cancels it when the drag arms.
                if (game.mode === "lab" && at.cell >= 0 && !event.shiftKey) {
                        drag.holdCell = at.cell;
                        drag.holdTimer = setTimeout(valveLongPress, VALVE_LONG_PRESS);
                }
                // A Vent turn buys exactly one detent, so the press-drag dial is off there.
                if (game.mode === "vent") return;
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
                if (ventDrag.column >= 0) {
                        const w = worldFromPointer(event);
                        if (w) {
                                if (!ventDrag.armed && Math.hypot(w.x - ventDrag.downX, w.y - ventDrag.downY) >= VENT_ARM) armVentSlide(event, w);
                                if (ventDrag.armed) applyVentSlide(w.x - ventDrag.lastX, w.y - ventDrag.lastY);
                                ventDrag.lastX = w.x;
                                ventDrag.lastY = w.y;
                        }
                        if (paused) drawFrame(ventDrag.armed);
                        return;
                }
                if (drag.cell >= 0) {
                        const w = worldFromPointer(event);
                        if (!w) return;
                        const moved = Math.hypot(w.x - drag.downX, w.y - drag.downY);
                        if (!drag.active && moved >= DRAG_ARM) {
                                drag.active = true;
                                // A turn gesture cancels the pending selection hold: the
                                // press has become a drag, not a long press.
                                if (drag.holdTimer) {
                                        clearTimeout(drag.holdTimer);
                                        drag.holdTimer = 0;
                                        drag.holdCell = -1;
                                }
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
                setHoverVent(at.vent);
                // Selection never follows the cursor: the hover ring marks the
                // cell under the hand without committing to anything, and a
                // selection made by click, Shift-click or a long press survives
                // the hand moving away.
                hoverCell = at.cell;
                canvas.style.cursor = cursorFor();
                if (paused) drawFrame(false);
        };

        function endDrag(event) {
                if (drag.holdTimer) {
                        clearTimeout(drag.holdTimer);
                        drag.holdTimer = 0;
                }
                drag.holdCell = -1;
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

        canvas.onpointerup = event => {
                endVentPress(event);
                endDrag(event);
        };
        canvas.onpointercancel = event => {
                endVentPress(event);
                endDrag(event);
        };
        canvas.onpointerleave = () => {
                if (drag.active) return;
                if (drag.holdTimer) {
                        clearTimeout(drag.holdTimer);
                        drag.holdTimer = 0;
                        drag.holdCell = -1;
                }
                drag.cell = -1;
                if (ventDrag.column >= 0 && !ventDrag.armed) {
                        if (ventDrag.timer) clearTimeout(ventDrag.timer);
                        ventDrag.timer = 0;
                        ventDrag.column = -1;
                }
                if (document.activeElement === canvas) return;
                canvas.style.cursor = "default";
                hoverCell = -1;
                setHover(-1);
                setHoverVent(-1);
                if (paused) drawFrame(false);
        };
        canvas.onblur = () => {
                drag.cell = -1;
                drag.active = false;
                drag.hub = false;
                if (drag.holdTimer) {
                        clearTimeout(drag.holdTimer);
                        drag.holdTimer = 0;
                        drag.holdCell = -1;
                }
                if (ventDrag.column >= 0) endVentPress(null);
                hoverCell = -1;
                setHover(-1);
                setHoverVent(-1);
                if (paused) drawFrame(false);
        };
        canvas.onclick = event => {
                if (drag.suppressClick) {
                        drag.suppressClick = false;
                        return;
                }
                pointerState(event);
                if (at.vent >= 0) {
                        if (ventDrag.suppressClick) {
                                ventDrag.suppressClick = false;
                                return;
                        }
                        Water.selectVent(sim.water, at.vent);
                        syncWaterUI();
                        if (paused) drawFrame(true);
                        return;
                }
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
                // Lab Shift-click toggles the cell in the multi-selection without
                // turning it, so a heater bank can be picked without disturbing the
                // rotors. Game and Vent keep Shift-click as the reverse turn.
                if (event.shiftKey && game.mode === "lab" && at.cell >= 0) {
                        toggleSelection(at.cell);
                        if (paused) drawFrame(false);
                        return;
                }
                setSelection(at.cell);
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
                event.preventDefault();
                const w = worldFromPointer(event);
                if (!w) return;
                // Water vents answer in every mode: water is not part of the game roster.
                const vent = ventHit(w.x, w.y);
                if (vent >= 0) {
                        openVentPicker(vent);
                        return;
                }
                if (game.mode !== "lab") return;
                setSelection(cellFromPointer(w.x, w.y));
                if (selected < 0 || event.ctrlKey) return;
                // The first click of the gesture already turned this valve; undo that
                // turn so the brush (notably direction "not change") is measured from
                // before the double-click.
                S.turn(sim, selected, event.shiftKey ? 1 : -1);
                placeBrushAt(selected);
        };

        // The vent's own colour picker: a hidden native color input opened at the
        // double click. Its value starts from the vent's normalized colour, and every
        // pick maps to proportional channel shares — pure black is refused like an
        // empty pour mask, because there is no ink ratio in black.
        function openVentPicker(column) {
                pickerColumn = column;
                const shares = ventSharesOf(column);
                const m = Math.max(shares[0], shares[1], shares[2]);
                if (m > 0) {
                        const r = Math.round(shares[0] / m * 255);
                        const g = Math.round(shares[1] / m * 255);
                        const b = Math.round(shares[2] / m * 255);
                        picker.value = "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
                }
                if (picker.showPicker) {
                        try {
                                picker.showPicker();
                                return;
                        } catch {}
                }
                if (typeof picker.click === "function") picker.click();
        }

        function applyPickerColor() {
                if (!sim.water || pickerColumn < 0) return;
                const hex = picker.value;
                if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
                ventShares[0] = parseInt(hex.slice(1, 3), 16) / 255;
                ventShares[1] = parseInt(hex.slice(3, 5), 16) / 255;
                ventShares[2] = parseInt(hex.slice(5, 7), 16) / 255;
                if (!Water.setVentShares(sim.water, pickerColumn, ventShares)) return;
                Water.selectVent(sim.water, pickerColumn);
                syncWaterUI();
                if (paused) drawFrame(true);
        }
        picker.oninput = applyPickerColor;
        picker.onchange = applyPickerColor;
        canvas.onkeydown = event => {
                if (event.key === "p" || event.key === "P") {
                        if (game.mode !== "lab") return;
                        event.preventDefault();
                        if (selected < 0) setSelection(44);
                        placeBrushAt(selected);
                        return;
                }
                if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        if (selected < 0) setSelection(44);
                        turnSelected(event.shiftKey ? -1 : 1);
                        return;
                }
                if (!event.key.startsWith("Arrow")) return;
                event.preventDefault();
                // The keyboard is a single-cursor tool: the arrows move the anchor
                // and collapse the set to it, so navigation can never smear a
                // multi-selection across the grid.
                if (selected < 0) setSelection(44);
                let row = (selected / G.N) | 0;
                let col = selected % G.N;
                if (event.key === "ArrowUp" && row > 0) row--;
                else if (event.key === "ArrowDown" && row < G.N - 1) row++;
                else if (event.key === "ArrowLeft" && col > 0) col--;
                else if (event.key === "ArrowRight" && col < G.N - 1) col++;
                setSelection(row * G.N + col);
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

        // The fill is the solver's own 2 px mask grid: passability and waterline come
        // from one sample per texel, so metal never reads as wet and the sheet cannot
        // disagree with the mask. It is drawn behind the grains and kept translucent,
        // so a submerged grain stays legible. The surface line goes on top of the
        // texture: behind a bright grain the sheet alone would not read as a level.
        function drawWater(dim) {
                const w = sim.water;
                if (!waterField) {
                        waterField = Water.makeDisplay(w);
                        waterMap = R.makeWaterMap(waterField.nx, waterField.ny);
                }
                Water.sampleDisplay(sim, waterField);
                R.renderWater(waterMap, waterField, waterView, dim);
                ctx.save();
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(waterMap.canvas, 0, -G.POUR, waterMap.nx * waterField.cell, waterMap.ny * waterField.cell);
                R.renderWaterSurface(ctx, waterField);
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
                // The heat panel re-reads the selection whenever it changed — a
                // version counter, because a multi-selection can change without
                // the anchor moving (Shift-click off the anchor's cell).
                if (selectionVersion !== heatSelSeen) {
                        heatSelSeen = selectionVersion;
                        if (sim.heat && sim.heat.enabled) syncHeatUI();
                }
                syncLegend();
                syncSelectedValve();
                ctx.save();
                // Shift world [-POUR - VENT_STRIP, SIZE + POUR] down into the canvas.
                ctx.translate(0, G.POUR + G.VENT_STRIP);
                R.renderScene(ctx, layout, scene);
                if ($("model").checked) drawOverlay(forceOverlay);
                const pressure = sim.pressure;
                const drawPressure = $("pressure-draw").checked && pressure;
                if (drawPressure) {
                        if (pressure.kind === "grid") drawPressureGrid();
                        else R.renderPressure(ctx, pressure);
                }
                const heatOn = !!(sim.heat && sim.heat.enabled);
                if (sim.water && sim.water.enabled) drawWater(heatOn && heatViewOn ? 0.42 : 1);
                if (heatOn && heatViewOn) drawHeatMap();
                // Mouths sit under the grain piles that share the bands; the ownership
                // tabs are redrawn above them so a player's own mouths never get buried.
                R.renderInlets(ctx, sim.inlets, hoverInlet);
                R.renderGrains(ctx, sim, scene);
                R.renderInletBadges(ctx, sim.inlets, hoverInlet);
                // The water vent strip rides above the pour band, clear of the mouths.
                R.renderWaterVents(ctx, sim.water, hoverVent, ventDrag);
                R.renderGoals(ctx, layout, game);
                R.renderVents(ctx, layout, game);
                // The faint hover ring sits under the selection: it marks where a
                // click would land without ever committing to it.
                R.renderHover(ctx, layout, hoverCell >= 0 && !selectedSet.has(hoverCell) ? hoverCell : -1);
                R.renderSelection(ctx, layout, selected, selectedSet);
                R.renderDrag(ctx, layout, sim, drag);
                if (heatOn) R.renderHeatBadges(ctx, layout, sim.heat, selectedSet);
                if (heatOn && heatViewOn) R.renderHeatLegend(ctx);
                if (drawPressure && pressure.kind === "grid") R.renderPressureLegend(ctx, pressureSpanLabel);
                ctx.restore();
        }

        function formatStats(fps) {
                const purged = sim.purged > 0 ? " · purged " + sim.purged : "";
                let water = "";
                if (sim.water) {
                        const held = Water.storedVol(sim.water);
                        Water.channelTotals(sim.water, waterChannels);
                        const rgb = held > 1e-6
                                ? Math.round(waterChannels[0] / held * 100) + "/" + Math.round(waterChannels[1] / held * 100) + "/" + Math.round(waterChannels[2] / held * 100)
                                : "0/0/0";
                        water = " · water " + Water.volumeSI(held).toFixed(2) + " L" +
                                " (" + Math.round(held).toString() + " px²)" +
                                " · rgb " + rgb + "%" +
                                " · wet " + Water.wetCount(sim.water) +
                                " · vents " + Water.ventOpenCount(sim.water) + " open" +
                                " · over " + Math.round(sim.water.overflowed) +
                                " · drained " + Math.round(sim.water.drained);
                }
                let heat = "";
                if (sim.heat && sim.heat.enabled) {
                        let sum = 0;
                        for (let i = 0; i < sim.heat.count; i++) sum += sim.heat.T[i];
                        heat = " · heat " + (sum / sim.heat.count).toFixed(1) + " °C mean"
                                + " · room " + Math.round(sim.heat.p.ambient) + " °C"
                                + " · src " + Math.round(sim.heat.source)
                                + " · net " + Math.round(sim.heat.ambient)
                                + " · mat " + Math.round(sim.heat.material)
                                + " · res " + Number(Heat.residual(sim.heat)).toExponential(0);
                }
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
                        gas +
                        water +
                        heat
                );
        }

        // The Heat fieldset readout: the ledger as four numbers plus the phase
        // change masses, so a long run can be judged without the console.
        function updateHeatReadout() {
                const h = sim.heat;
                const el = $("heat-readout");
                if (!h || !h.enabled) {
                        el.hidden = true;
                        return;
                }
                el.hidden = false;
                // `h.ambient` is the cumulative room transfer (negative when the room
                // has cooled the field), not the room temperature itself, so the two
                // are reported separately: the room setting the user typed, then the
                // net transfer the room has done since opening.
                el.textContent = "room " + Math.round(h.p.ambient) + " °C"
                        + " · field " + Math.round(Heat.stored(h)) + " E"
                        + " · source " + Math.round(h.source)
                        + " · net " + Math.round(h.ambient)
                        + " · material " + Math.round(h.material)
                        + " · residual " + Number(Heat.residual(h)).toExponential(1)
                        + " · melted " + h.melted.toFixed(1) + " mg"
                        + " · frozen " + h.frozen.toFixed(1) + " mg"
                        + " · " + h.substeps + " substep(s)";
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
                        updateHeatReadout();
                        stats.frames = 0;
                        stats.clock = 0;
                }
                requestAnimationFrame(frame);
        }

        rebuild(true);
        requestAnimationFrame(frame);
})();
