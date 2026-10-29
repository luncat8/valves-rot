// Headless smoke test for the shared page without a browser: a recording 2D
// context and a minimal DOM stub run the real render and control code. It proves
// wiring, coordinate alignment and draw calls, not pixels.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "prototype", "shared");
const calls = { total: 0, stroke: 0, fill: 0, drawImage: 0, putImageData: 0, arc: 0, fillRect: 0, canvases: 0 };
const mainTranslates = [];
const mainDrawImages = [];
const mainTexts = [];
const gradient = { addColorStop() {} };

function recordingContext(isMain) {
	const target = {
		createLinearGradient: () => gradient,
		createRadialGradient: () => gradient,
		createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
		getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
		putImageData: () => {
			calls.putImageData++;
			calls.total++;
		},
	};
	const drawOps = ["fill", "stroke", "beginPath", "clearRect", "save", "restore", "rotate", "scale", "setTransform", "clip", "closePath"];
	return new Proxy(target, {
		get(obj, prop) {
			if (prop in obj) return obj[prop];
			if (prop === "translate") {
				return (tx, ty) => {
					if (isMain) mainTranslates.push([tx, ty]);
					calls.total++;
				};
			}
			if (prop === "arc") {
				return () => {
					calls.arc++;
					calls.total++;
				};
			}
			if (prop === "fillRect") {
				return () => {
					calls.fillRect++;
					calls.total++;
				};
			}
			if (prop === "drawImage") {
				return (img, x, y, w, h) => {
					if (isMain) mainDrawImages.push([x, y, w, h]);
					calls.drawImage++;
					calls.total++;
				};
			}
			if (prop === "fillText") {
				return text => {
					if (isMain) mainTexts.push(text);
					calls.total++;
				};
			}
			if (drawOps.indexOf(prop) >= 0) {
				return () => {
					if (prop === "stroke") calls.stroke++;
					if (prop === "fill") calls.fill++;
					calls.total++;
				};
			}
			return () => {
				calls.total++;
			};
		},
		set() {
			return true;
		},
	});
}

const elements = {};
function element(id) {
	if (elements[id]) return elements[id];
	const el = {
		id,
		value: id === "seed" ? "7" : id === "speed" || id === "force" ? "1" : "",
		checked: id === "pressure-grid" || id === "pressure-draw",
		textContent: "",
		width: 0,
		height: 0,
		style: {},
		attributes: {},
		setAttribute(name, value) { this.attributes[name] = value; },
		removeAttribute(name) { delete this.attributes[name]; },
		getAttribute(name) { return this.attributes[name] ?? null; },
		addEventListener() {},
		focus() {},
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 720, height: 780 }),
	};
	if (id === "c") el.getContext = () => recordingContext(true);
	elements[id] = el;
	return el;
}

const frames = [];
const windowListeners = {};
global.window = {
	devicePixelRatio: 2,
	addEventListener: (ev, fn) => {
		windowListeners[ev] = fn;
	},
};
const copiedTexts = [];
Object.defineProperty(global, "navigator", {
	value: { clipboard: { writeText: text => { copiedTexts.push(text); return Promise.resolve(); } } },
	configurable: true,
});
global.document = {
	activeElement: null,
	hidden: false,
	getElementById: element,
	// Generated picker buttons exist only as innerHTML in this stub; brush
	// state is exercised through the delegated handlers below instead.
	querySelectorAll: () => [],
	createElement: tag => {
		if (tag !== "canvas") return {};
		calls.canvases++;
		return { width: 0, height: 0, getContext: () => recordingContext(false) };
	},
	addEventListener() {},
};
global.requestAnimationFrame = fn => frames.push(fn);
global.Path2D = class {
	moveTo() {}
	lineTo() {}
	arc() {}
};
global.performance.now = () => Date.now();

for (const file of ["geometry.js", "inlets.js", "air.js", "gas.js", "calibration.js", "render.js", "simulation.js", "game.js", "app.js"]) {
	const code = fs.readFileSync(path.join(root, file), "utf8");
	vm.runInThisContext(code, { filename: file });
}

const G = vm.runInThisContext("ValveGeometry");
const R = vm.runInThisContext("ValveRender");
const INL = vm.runInThisContext("ValveInlets");
const SIM = vm.runInThisContext("ValveSimulation");
assert.ok(SIM.STEP > 0 && SIM.GRAIN_COLORS.length >= 4);
assert.equal(G.N, 10);
assert.ok(calls.total > 0, "startup must draw");

// Static help lives in the Help drawer, and the valve drawer lists every
// catalogue type with a clipboard copy button for its name.
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
for (const id of ["help-drawer", "valve-drawer", "open-help", "open-valves", "valve-types", "dir-picker", "brush-summary", "selected-valve"]) {
	assert.ok(html.includes('id="' + id + '"'), "page has #" + id);
}
assert.ok(html.indexOf("Shortcuts") > html.indexOf('id="help-drawer"'), "shortcuts are inside the Help drawer");
assert.ok(html.indexOf('id="calibration-note"') > html.indexOf('id="help-drawer"'), "calibration note moved into Help");
assert.ok(!html.includes('data-dir="keep"'), "no 'not change' direction button: re-click unselects instead");
const styleCss = fs.readFileSync(path.join(root, "..", "style.css"), "utf8");
assert.ok(styleCss.includes(".combined header") && styleCss.includes("flex-wrap: nowrap"), "compact one-line header styles present");
const typeList = element("valve-types").innerHTML;
assert.ok(!typeList.includes('data-type="keep"'), "no 'not change' type button: re-click unselects instead");
for (const type of G.TYPES) assert.ok(typeList.includes('data-type="' + type.id + '"') && typeList.includes(type.name), "picker lists " + type.id);
assert.equal(typeList.split("data-copy-type").length - 1, G.TYPES.length, "one copy-name button per type");
assert.ok(element("brush-summary").textContent.includes("random valve type"), "default brush keeps double-click random");

// Only one drawer opens at a time, with aria-expanded kept in sync.
element("open-help").onclick();
assert.equal(element("help-drawer").hidden, false);
assert.equal(element("open-help").getAttribute("aria-expanded"), "true");
element("open-valves").onclick();
assert.equal(element("help-drawer").hidden, true);
assert.equal(element("valve-drawer").hidden, false);
element("close-valves").onclick();
assert.equal(element("valve-drawer").hidden, true);
assert.equal(element("open-valves").getAttribute("aria-expanded"), "false");

// Resize with unchanged DPR must reuse cached scene canvases.
const canvasesAfterBoot = calls.canvases;
windowListeners.resize();
assert.equal(calls.canvases, canvasesAfterBoot, "unchanged DPR resize must not rebuild sprites");

// Grow an isolated scene: housings plus one rotor sprite per valve.
const layout = G.createLayout(7);
const strokesBefore = calls.stroke;
const scene = R.buildScene(layout, "#ffffff", 2);
assert.equal(scene.sprites.length, 100);
assert.ok(scene.bg.width > 0 && scene.bg.height > 0);
assert.ok(calls.stroke - strokesBefore >= 300, "passages must be stroked for material and air");
const before = { drawImage: calls.drawImage };
const ctx = recordingContext(false);
R.renderScene(ctx, layout, scene);
assert.equal(calls.drawImage - before.drawImage, 101, "one background plus one sprite per valve");

for (const air of ["#000000", "#ffffff"]) {
	const s = R.buildScene(layout, air, 2);
	assert.equal(s.sprites.length, 100);
}
const map = R.makeAirMap(4);
R.renderAirMap(map, layout);
assert.equal(map.canvas.width, Math.ceil(G.SIZE / 4));
const alpha = map.img.data.filter((_, k) => k % 4 === 3 && map.img.data[k] > 0).length;
assert.ok(alpha > 1000, "air model must mark air pixels");

// Drive the page: check frame transform (+POUR, never -POUR), steady overlay and controls.
let now = 0;
mainTranslates.length = 0;
frames.shift()((now += 16.7));
assert.deepEqual(mainTranslates[0], [0, G.POUR], "root frame transform must shift down by +POUR");

for (let i = 0; i < 5; i++) {
	const fn = frames.shift();
	assert.ok(fn, "page must schedule animation frames");
	fn((now += 16.7));
}

// Overlay must draw every frame at (0, -POUR) without strobing, while throttling putImageData.
element("model").checked = true;
element("model").onchange();
for (let i = 0; i < 3; i++) {
	mainDrawImages.length = 0;
	frames.shift()((now += 16.7));
	assert.equal(mainDrawImages.length, 103, "bg + 100 rotors + steady air and gas overlays every frame");
	assert.deepEqual(mainDrawImages[0], [0, -G.POUR, G.SIZE, G.SIZE + G.POUR * 2]);
	assert.deepEqual(mainDrawImages[101], [0, -G.POUR, G.SIZE, G.SIZE + G.POUR * 2]);
	assert.deepEqual(mainDrawImages[102], [0, -G.POUR, G.SIZE, G.SIZE + G.POUR * 2]);
}

// The calibrated legend is visible and editable while paused. Sealing every
// mouth keeps the ramp on screen because the trapped air is still described.
const CAL = vm.runInThisContext("ValveCalibration");
assert.ok(Math.abs(Number(element("pressure-span").value) - CAL.DEFAULT_SPAN) < 1e-6);
element("pause").onclick();
mainTexts.length = 0;
element("pressure-span").value = "2.5";
element("pressure-span").oninput();
assert.ok(mainTexts.includes("eq. Pa") && mainTexts.includes("2.5") && mainTexts.includes("0"));
assert.equal(element("legend-range").textContent, "· 0–2.5 Pa equivalent", "the scale is available outside the canvas");
element("pressure-span").value = "-1";
element("pressure-span").oninput();
assert.equal(element("pressure-span").getAttribute("aria-invalid"), "true");
assert.equal(element("pressure-error").hidden, false);
mainTexts.length = 0;
element("pressure-draw").onchange();
assert.ok(mainTexts.includes("2.5"), "invalid input does not replace the last valid scale");
element("pressure-reference").onclick();
assert.equal(element("pressure-span").getAttribute("aria-invalid"), null);
assert.equal(element("pressure-error").hidden, true);
assert.ok(Math.abs(Number(element("pressure-span").value) - CAL.DEFAULT_SPAN) < 1e-6, "reference span can be restored");
element("pressure-span").value = "1.25";
element("pressure-span").oninput();
assert.equal(element("pressure-span").getAttribute("aria-invalid"), null);

const c = element("c");
function clickMouth(side, column) {
	c.onclick({ clientX: (column + 0.5) * G.S, clientY: side === 0 ? 2 : G.SIZE + G.POUR * 2 - 2, shiftKey: false, detail: 1 });
}
for (let side = 0; side < 2; side++) {
	for (let column = 0; column < G.N; column++) {
		if (side === 1 && column === G.N - 1) {
			mainTexts.length = 0;
			mainDrawImages.length = 0;
		}
		clickMouth(side, column);
	}
}
assert.ok(mainTexts.includes("eq. Pa"), "the ramp still describes the trapped air");
assert.equal(element("legend-range").textContent, "· 0–1.25 Pa equivalent · all mouths sealed");
// The overlay keeps drawing trapped pressure instead of hiding the field.
for (let i = 0; i < 20; i++) {
	mainDrawImages.length = 0;
	frames.shift()((now += 16.7));
}
assert.equal(mainDrawImages.length, 103, "a sealed grid still draws the air field");

// With one polarity open the legend names the missing side.
clickMouth(1, 3);
assert.equal(element("legend-range").textContent, "· 0–1.25 Pa equivalent · no vent open");
clickMouth(0, 3);
assert.equal(element("legend-range").textContent, "· 0–1.25 Pa equivalent", "both polarities give a clean scale");
mainTexts.length = 0;
clickMouth(0, 0);
assert.ok(mainTexts.includes("eq. Pa") && mainTexts.includes("1.25"), "reopening a mouth restores the selected scale");
for (let side = 0; side < 2; side++) {
	for (let column = 0; column < G.N; column++) {
		if (side === 0 && column === 0) continue;
		clickMouth(side, column);
	}
}
element("pause").onclick();

const fieldMap = R.makeFieldMap(2, 1);
const field = { air: new Uint8Array([1, 0]), p: new Float32Array([0.5, 1]) };
R.renderField(fieldMap, field);
assert.equal(fieldMap.img.data[3], 255, "a sealed field keeps its colours");
assert.equal(fieldMap.img.data[7], 0, "metal remains transparent");
const lowColor = fieldMap.img.data[2];
field.p[0] = 0;
R.renderField(fieldMap, field);
assert.notEqual(fieldMap.img.data[2], lowColor, "the texel follows the live pressure");

// Pointer and keyboard valve selection + rotation.
c.onpointermove({ clientX: 4.5 * G.S, clientY: G.POUR + 2.5 * G.S });
const strokesPreSelect = calls.stroke;
frames.shift()((now += 16.7));
assert.ok(calls.stroke > strokesPreSelect, "selected valve must render highlight");
c.onclick({ clientX: 4.5 * G.S, clientY: G.POUR + 2.5 * G.S, shiftKey: false });
c.onkeydown({ key: "ArrowRight", preventDefault() {} });
c.onkeydown({ key: "Enter", shiftKey: true, preventDefault() {} });
c.onpointerleave();
for (const skin of ["glm", "combined", "gpt"]) {
	element("skin").value = skin;
	element("skin").onchange();
	frames.shift()((now += 16.7));
}
c.onclick({ clientX: 4.5 * G.S, clientY: G.POUR + 2.5 * G.S, ctrlKey: true, detail: 1 });
c.ondblclick({ clientX: 4.5 * G.S, clientY: G.POUR + 2.5 * G.S, preventDefault() {} });

// Valve brush picking through the delegated drawer handlers, clipboard copy
// as text, and placement by a real click + double-click gesture.
function pickType(type) {
	element("valve-types").onclick({ target: { closest: sel => (sel === "[data-type]" ? { dataset: { type } } : null) } });
}
function pickDir(dir) {
	element("dir-picker").onclick({ target: { closest: () => ({ dataset: { dir } }) } });
}
pickType("random");
assert.ok(element("brush-summary").textContent.includes("keep current type"), "re-clicking the selected ? unselects the type");
pickType("solid-elbow");
pickDir("1");
assert.ok(element("brush-summary").textContent.includes("solid elbow (ports E,S)"), "brush summary names type, ports and direction");
assert.ok(element("brush-detail").textContent.includes("direction ↓ S"));
element("copy-brush").onclick();
assert.ok(copiedTexts.some(text => text.includes("solid elbow (ports E,S)")), "brush name copied as text");
element("valve-types").onclick({ target: { closest: sel => (sel === "[data-copy-type]" ? { dataset: { copyType: "hollow-tee" } } : null) } });
assert.ok(
	copiedTexts.includes("hollow tee · direction ↓ S · 90° (ports S,W,N)"),
	"a type row copy includes the selected direction and its ports, got: " + copiedTexts[copiedTexts.length - 1],
);

const cellX = 4.5 * G.S;
const cellY = G.POUR + 2.5 * G.S;
c.onpointermove({ clientX: cellX, clientY: cellY });
c.onclick({ clientX: cellX, clientY: cellY, shiftKey: false, detail: 1 });
c.ondblclick({ clientX: cellX, clientY: cellY, preventDefault() {} });
frames.shift()((now += 16.7));
const placedText = element("selected-valve").textContent;
assert.ok(placedText.includes("solid elbow") && placedText.includes("ports E,S"), "double-click placed the picked type and direction, got: " + placedText);

element("use-selected").onclick();
assert.ok(element("brush-summary").textContent.includes("solid elbow"), "copy-to-brush loads the field valve");
element("copy-selected").onclick();
assert.ok(copiedTexts.some(text => text.includes("cell (5,3)") && text.includes("solid elbow")), "field valve copied as text");

// Re-clicking the selected type and direction unselects both (unselected =
// not change); a double-click gesture must then leave the valve exactly as
// it was: the first click's turn is undone.
pickType("solid-elbow");
assert.ok(element("brush-summary").textContent.includes("keep current type"), "re-click unselects the type");
pickDir("1");
assert.ok(element("brush-detail").textContent.includes("changes nothing"));
c.onclick({ clientX: cellX, clientY: cellY, shiftKey: false, detail: 1 });
c.ondblclick({ clientX: cellX, clientY: cellY, preventDefault() {} });
frames.shift()((now += 16.7));
assert.equal(element("selected-valve").textContent, placedText, "unselected type/direction double-click is a no-op");
element("valve-types").onclick({ target: { closest: sel => (sel === "[data-copy-type]" ? { dataset: { copyType: "hollow-tee" } } : null) } });
assert.ok(copiedTexts.includes("hollow tee"), "with no direction selected, a type row copies just its name");
assert.ok(typeList.includes("<path d="), "solid-elbow icon uses a rounded arc path");
c.onkeydown({ key: "p", preventDefault() {} });

// Press-drag rotation: dragging around a valve center turns it by 90° and
// suppresses the trailing click event so release does not turn a second time.
c.onpointerdown({ clientX: cellX, clientY: cellY - 22, button: 0, pointerId: 1 });
c.onpointermove({ clientX: cellX + 22, clientY: cellY, pointerId: 1 });
c.onpointerup({ pointerId: 1 });
c.onclick({ clientX: cellX + 22, clientY: cellY, shiftKey: false, detail: 1 });
frames.shift()((now += 16.7));
const draggedText = element("selected-valve").textContent;
assert.ok(draggedText.includes("ports S,W"), "orbital press-drag stepped +90° once without extra click turn, got: " + draggedText);

// A short wobble must not step the dial: one quarter turn of the hand (plus the
// grip slack and the half-notch snap) is what buys a detent, so 25° of orbit is
// not enough. The old mapping stepped after 33°.
const wobble = (cellX + 22 * Math.sin(0.44)).toFixed(2);
const wobbleY = (cellY - 22 * Math.cos(0.44)).toFixed(2);
c.onpointerdown({ clientX: cellX, clientY: cellY - 22, button: 0, pointerId: 2 });
c.onpointermove({ clientX: Number(wobble), clientY: Number(wobbleY), pointerId: 2 });
c.onpointerup({ pointerId: 2 });
c.onclick({ clientX: Number(wobble), clientY: Number(wobbleY), shiftKey: false, detail: 1 });
frames.shift()((now += 16.7));
assert.equal(element("selected-valve").textContent, draggedText, "a 25° wobble must not turn the valve");

// Half a turn of the hand is two detents, in two steps around the rim.
c.onpointerdown({ clientX: cellX, clientY: cellY - 22, button: 0, pointerId: 3 });
c.onpointermove({ clientX: cellX + 22, clientY: cellY, pointerId: 3 });
c.onpointermove({ clientX: cellX, clientY: cellY + 22, pointerId: 3 });
c.onpointerup({ pointerId: 3 });
c.onclick({ clientX: cellX, clientY: cellY + 22, shiftKey: false, detail: 1 });
frames.shift()((now += 16.7));
assert.ok(element("selected-valve").textContent.includes("ports E,N"), "half a turn of the hand gives two detents, got: " + element("selected-valve").textContent);

// A press near the hub pulls horizontally: 35 px (9 px of grip + half a step)
// is the first detent, so 30 px must still be inert.
const hubText = element("selected-valve").textContent;
c.onpointerdown({ clientX: cellX, clientY: cellY, button: 0, pointerId: 4 });
c.onpointermove({ clientX: cellX + 30, clientY: cellY, pointerId: 4 });
c.onpointerup({ pointerId: 4 });
c.onclick({ clientX: cellX + 30, clientY: cellY, shiftKey: false, detail: 1 });
frames.shift()((now += 16.7));
assert.equal(element("selected-valve").textContent, hubText, "a 30 px hub pull must not turn the valve");
c.onpointerdown({ clientX: cellX, clientY: cellY, button: 0, pointerId: 5 });
c.onpointermove({ clientX: cellX + 40, clientY: cellY, pointerId: 5 });
c.onpointerup({ pointerId: 5 });
c.onclick({ clientX: cellX + 40, clientY: cellY, shiftKey: false, detail: 1 });
frames.shift()((now += 16.7));
assert.ok(element("selected-valve").textContent.includes("ports E,S"), "a 40 px hub pull steps one detent, got: " + element("selected-valve").textContent);

// Case tint brush in Lab mode repaints the background without allocating canvases.
const canvasesPreTint = calls.canvases;
element("tint-picker").onclick({ target: { closest: () => ({ dataset: { tint: "0" } }) } });
c.onclick({ clientX: cellX, clientY: cellY, shiftKey: false, detail: 1 });
c.ondblclick({ clientX: cellX, clientY: cellY, preventDefault() {} });
frames.shift()((now += 16.7));
assert.equal(calls.canvases, canvasesPreTint, "case tint brush allocates zero extra canvases");
assert.ok(element("selected-valve").textContent.includes("You case"), "case tint shown in valve readout");
element("tint-picker").onclick({ target: { closest: () => ({ dataset: { tint: "0" } }) } });

// Lab mode defaults auto-rotate to 90%; switching to Game mode sets 20%,
// shows the game panel, lets the user sign a goal, and returns to 90% in Lab.
assert.equal(element("auto-rotate").value, "90", "Lab mode auto-rotate default is 90%");
element("mode-lab").checked = false;
element("mode-game").checked = true;
element("mode-game").onchange();
assert.equal(element("auto-rotate").value, "20", "Game mode auto-rotate default is 20%");
assert.equal(element("game-panel").hidden, false, "Game panel opens in Game mode");
assert.ok(element("player-list").innerHTML.includes("You") && element("player-list").innerHTML.includes("Ada"), "Competitors list rendered");
const signMatch = element("quest-list").innerHTML.match(/data-sign="(\d+)"/);
assert.ok(signMatch, "Unsigned quest offers a Sign button");
element("quest-list").onclick({ target: { closest: sel => (sel === "[data-sign]" ? { dataset: { sign: signMatch[1] } } : null) } });
frames.shift()((now += 16.7));
assert.ok(element("selected-valve").textContent.includes("hollow single") && element("selected-valve").textContent.includes("ports N"), "Signing spawns upright hollow single ↑ N");
element("quest-list").onclick({ target: { closest: sel => (sel === "[data-drop]" ? { dataset: { drop: signMatch[1] } } : null) } });
element("mode-game").checked = false;
element("mode-lab").checked = true;
element("mode-lab").onchange();
assert.equal(element("auto-rotate").value, "90", "Returning to Lab mode restores 90% auto-rotate");
assert.equal(element("game-panel").hidden, true);


element("force").value = "1.5";
element("force").oninput();
assert.equal(element("force-value").value, "1.5", "air force slider is wired");
element("pause").onclick();
element("pressure-grid").checked = false;
element("pressure-particles").checked = true;
element("pressure-particles").onchange();
assert.equal(element("legend-range").hidden, true, "particle mode does not claim a grid scale");
element("pressure-draw").checked = true;
element("pressure-draw").onchange();
element("step").onclick();
element("pressure-particles").checked = false;
element("pressure-off").onchange();
element("pour").onclick();
const arcsBefore = calls.arc;
frames.shift()((now += 16.7));
assert.ok(calls.arc > arcsBefore, "grains must be drawn as arcs");
element("drain").onclick();
const madeFrames = frames.length;
frames.shift()((now += 16.7));
assert.ok(calls.putImageData > 0, "air model overlay must be painted");
element("air").checked = true;
element("air").onchange();
element("speed").value = "0";
element("speed").oninput();
frames.shift()((now += 16.7));
frames.shift()((now += 1600));
element("seed").value = "321";
element("seed").onchange();
assert.ok(frames.length > 0);
frames.shift()((now += 16.7));
element("shuffle").onclick();
frames.shift()((now += 16.7));
element("reset").onclick();
element("pause").onclick();
for (let i = 0; i < 3; i++) frames.shift()((now += 33));

const a = G.createLayout(321);
const b = G.createLayout(321);
assert.equal(JSON.stringify(a.valves.map(G.describe)), JSON.stringify(b.valves.map(G.describe)));
assert.ok(madeFrames > 0);
console.log(
	"OK  shared page smoke: sprites 100, drawCalls " +
		calls.total +
		" stroke " +
		calls.stroke +
		" fill " +
		calls.fill +
		" fillRect " +
		calls.fillRect +
		" drawImage " +
		calls.drawImage +
		" overlay " +
		calls.putImageData,
);
