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
		value: id === "seed" ? "7" : id === "speed" ? "1" : "",
		checked: false,
		textContent: "",
		width: 0,
		height: 0,
		style: {},
		addEventListener() {},
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
global.document = {
	activeElement: null,
	hidden: false,
	getElementById: element,
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

for (const file of ["geometry.js", "render.js", "simulation.js", "app.js"]) {
	const code = fs.readFileSync(path.join(root, file), "utf8");
	vm.runInThisContext(code, { filename: file });
}

const G = vm.runInThisContext("ValveGeometry");
const R = vm.runInThisContext("ValveRender");
const SIM = vm.runInThisContext("ValveSimulation");
assert.ok(SIM.STEP > 0 && SIM.GRAIN_COLORS.length >= 4);
assert.equal(G.N, 10);
assert.ok(calls.total > 0, "startup must draw");

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
	assert.equal(mainDrawImages.length, 102, "bg + 100 rotors + steady air overlay every frame");
	assert.deepEqual(mainDrawImages[0], [0, -G.POUR, G.SIZE, G.SIZE + G.POUR * 2]);
	assert.deepEqual(mainDrawImages[101], [0, -G.POUR, G.SIZE, G.SIZE + G.POUR * 2]);
}

// Pointer and keyboard valve selection + rotation.
const c = element("c");
c.onpointermove({ clientX: 4.5 * G.S, clientY: G.POUR + 2.5 * G.S });
const strokesPreSelect = calls.stroke;
frames.shift()((now += 16.7));
assert.ok(calls.stroke > strokesPreSelect, "selected valve must render highlight");
c.onclick({ clientX: 4.5 * G.S, clientY: G.POUR + 2.5 * G.S, shiftKey: false });
c.onkeydown({ key: "ArrowRight", preventDefault() {} });
c.onkeydown({ key: "Enter", shiftKey: true, preventDefault() {} });
c.onpointerleave();

element("pause").onclick();
element("step").onclick();
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
