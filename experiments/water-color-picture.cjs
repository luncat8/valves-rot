"use strict";
// Four panels, left to right: mixed color, mixed pigment, layered color,
// layered pigment. The shared painter calls the page's water renderer.
const path = require("node:path");
const G = require("../prototype/shared/geometry.js");
const W = require("../prototype/shared/water.js");
const C = require("./water-color-scenario.cjs");
const P = require("./water-paint.cjs");
const { writePng } = require("./png-writer.cjs");
const mixed = C.create();
const layered = C.create();
W.setMixable(layered.water, [0, 0, 0]);
C.steps(mixed, 10);
C.steps(layered, 10);
const view = { x0: 3 * G.S, y0: 7 * G.S, w: 3 * G.S, h: 2.5 * G.S };
const out = path.join(__dirname, "logs", "water-color.png");
writePng(out, [P.panel(mixed, view, 1, false), P.panel(mixed, view, 1, true), P.panel(layered, view, 1, false), P.panel(layered, view, 1, true)]);
console.log("wrote experiments/logs/water-color.png: mixed color/pigment, layered color/pigment; seed 3, 10 s");
