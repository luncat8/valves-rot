// Headless smoke test for the shared page without a browser: a recording 2D
// context and a minimal DOM stub run the real render and control code. It proves
// wiring and draw calls, not pixels.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "prototype", "shared");
const calls = { total: 0, stroke: 0, fill: 0, drawImage: 0, putImageData: 0, arc: 0, fillRect: 0 };
const gradient = { addColorStop() {} };

function recordingContext() {
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
	const drawOps = ["fill", "stroke", "beginPath", "clearRect", "save", "restore", "translate", "rotate", "scale", "setTransform", "clip", "closePath"];
	return new Proxy(target, {
		get(obj, prop) {
			if (prop in obj) return obj[prop];
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
				return () => {
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
		id: id,
		value: id === "seed" ? "7" : id === "speed" ? "1" : "",
		checked: false,
		textContent: "",
		width: 0,
		height: 0,
		style: {},
		addEventListener() {},
	};
	if (id === "c") el.getContext = () => recordingContext();
	elements[id] = el;
	return el;
}

const frames = [];
global.window = { addEventListener() {}, devicePixelRatio: 2 };
global.document = {
	getElementById: element,
	createElement: (tag) => (tag === "canvas" ? { width: 0, height: 0, getContext: () => recordingContext() } : {}),
	addEventListener() {},
};
global.requestAnimationFrame = (fn) => frames.push(fn);
global.Path2D = class {
	moveTo() {}
	lineTo() {}
	arc() {}
};
global.performance.now = () => Date.now();

for (const file of ["geometry.js", "render.js", "app.js"]) {
	const code = fs.readFileSync(path.join(root, file), "utf8");
	vm.runInThisContext(code, { filename: file });
}

const G = vm.runInThisContext("ValveGeometry");
const R = vm.runInThisContext("ValveRender");
assert.equal(G.N, 10);
assert.ok(calls.total > 0, "startup must draw");

// Grow the scene: housings plus one rotor sprite per valve.
const layout = G.createLayout(7);
const strokesBefore = calls.stroke;
const scene = R.buildScene(layout, "#ffffff", 2);
assert.equal(scene.sprites.length, 100);
assert.ok(scene.bg.width > 0 && scene.bg.height > 0);
// every passage is stroked three times: dark edge, material, air
assert.ok(calls.stroke - strokesBefore >= 300, "passages must be stroked for material and air");
const before = { drawImage: calls.drawImage };
const ctx = recordingContext();
R.renderScene(ctx, layout, scene);
assert.equal(calls.drawImage - before.drawImage, 101, "one background plus one sprite per valve");

// Air colours change the sprite set but not its count; the air map fills a coarse grid.
for (const air of ["#000000", "#ffffff"]) {
	const s = R.buildScene(layout, air, 2);
	assert.equal(s.sprites.length, 100);
}
const map = R.makeAirMap(4);
R.renderAirMap(map, layout);
assert.equal(map.canvas.width, Math.ceil(G.SIZE / 4));
const alpha = map.img.data.filter((_, k) => k % 4 === 3 && map.img.data[k] > 0).length;
assert.ok(alpha > 1000, "air model must mark air pixels");

// Drive the page: frames, controls, and a rebuilt layout.
let now = 0;
for (let i = 0; i < 6; i++) {
	const fn = frames.shift();
	assert.ok(fn, "page must schedule animation frames");
	fn((now += 16.7));
}
element("pause").onclick();
element("step").onclick();
element("model").checked = true;
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

// Deterministic layouts: same seed, same valves.
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
