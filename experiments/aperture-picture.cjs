// Aperture picture: the grid-gas field on a machine whose 100 rotors all sit at
// 0.113 rad, rendered twice — a reference git revision of gas.js on the left,
// the working tree on the right — and written to logs/grid-gas-aperture-0.2.png.
// Run: node experiments/aperture-picture.cjs [git-rev-of-the-old-build]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SHARED = path.join(ROOT, "prototype/shared");
const REV = process.argv[2] || "a733b2d";
const OUT = path.join(__dirname, "logs", "grid-gas-aperture-0.2.png");
const CELL = 6;
const ANGLE = 0.113;

// A gas backend that is not on disk: copy the revision's gas.js beside the
// current geometry so it can be required like the live one.
function backendFrom(rev) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gas-rev-"));
	for (const file of ["geometry.js", "inlets.js", "air.js", "simulation.js"]) fs.copyFileSync(path.join(SHARED, file), path.join(dir, file));
	fs.writeFileSync(path.join(dir, "gas.js"), execFileSync("git", ["show", `${rev}:prototype/shared/gas.js`], { cwd: ROOT }));
	return dir;
}

// One field at one rotor angle, as raw RGB rows plus its connectivity.
function render(dir, angle) {
	const G = require(path.join(dir, "geometry.js"));
	const GAS = require(path.join(dir, "gas.js"));
	const S = require(path.join(dir, "simulation.js"));
	const layout = G.createLayout(7);
	for (let k = 0; k < layout.valves.length; k++) G.setAngle(layout.valves[k], angle);
	const sim = S.create(layout, { turning: false });
	S.setPressure(sim, "grid");
	for (let k = 0; k < 24; k++) S.settlePressure(sim, 1 / 30);
	const gas = sim.pressure;
	const w = G.SIZE;
	const h = G.SIZE + 2 * G.POUR;
	const rgb = Buffer.alloc(w * h * 3);
	for (let i = 0; i < rgb.length; i += 3) {
		rgb[i] = 16;
		rgb[i + 1] = 18;
		rgb[i + 2] = 26;
	}
	for (let n = 0; n < gas.count; n++) {
		const k = gas.list[n];
		const x0 = (k % gas.nx) * CELL;
		const y0 = ((k / gas.nx) | 0) * CELL;
		const colour = gas.active[k] ? ramp(gas.p[k]) : POCKET;
		for (let y = y0; y < Math.min(y0 + CELL, h); y++) {
			for (let x = x0; x < Math.min(x0 + CELL, w); x++) {
				const o = (y * w + x) * 3;
				rgb[o] = colour[0];
				rgb[o + 1] = colour[1];
				rgb[o + 2] = colour[2];
			}
		}
	}
	let live = 0;
	for (let n = 0; n < gas.count; n++) if (gas.active[gas.list[n]]) live++;
	return { rgb, w, h, live, cells: gas.count, comps: gas.compCount };
}

// Blue to red with cyan and amber between, the same ramp the overlay uses.
const STOPS = [
	[24, 40, 120],
	[40, 120, 200],
	[70, 200, 200],
	[240, 190, 70],
	[220, 60, 50],
];
const POCKET = [58, 60, 72];
function ramp(p) {
	const t = Math.max(0, Math.min(1, p)) * (STOPS.length - 1);
	const i = Math.min(STOPS.length - 2, Math.floor(t));
	const f = t - i;
	const a = STOPS[i];
	const b = STOPS[i + 1];
	return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function crc32(buf) {
	let table = crc32.table;
	if (!table) {
		table = crc32.table = new Int32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			table[n] = c;
		}
	}
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

function writePng(panels, width, height, bars) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const image = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width * 3 + 1);
		image[row] = 0;
		image.fill(16, row + 1, row + 1 + width * 3);
	}
	const pad = 10;
	const bar = 6;
	for (let p = 0; p < panels.length; p++) {
		const px = pad + p * (panels[p].w + pad);
		for (let y = 0; y < bar; y++) {
			for (let x = 0; x < panels[p].w; x++) {
				const o = y * (width * 3 + 1) + 1 + (px + x) * 3;
				image[o] = bars[p][0];
				image[o + 1] = bars[p][1];
				image[o + 2] = bars[p][2];
			}
		}
		for (let y = 0; y < panels[p].h; y++) {
			const dst = (y + bar + pad) * (width * 3 + 1) + 1 + px * 3;
			panels[p].rgb.copy(image, dst, y * panels[p].w * 3, (y + 1) * panels[p].w * 3);
		}
	}
	fs.writeFileSync(
		OUT,
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", ihdr),
			chunk("IDAT", zlib.deflateSync(image, { level: 9 })),
			chunk("IEND", Buffer.alloc(0)),
		]),
	);
}

const oldDir = backendFrom(REV);
const old = render(oldDir, ANGLE);
const current = render(SHARED, ANGLE);
writePng([old, current], old.w * 2 + 30, old.h + 26, [
	[200, 70, 60],
	[70, 190, 110],
]);
console.log(
	`${REV}: ${old.live} of ${old.cells} air cells reach a mouth (${((100 * old.live) / old.cells).toFixed(1)}%), ${old.comps} components\n` +
		`working tree: ${current.live} of ${current.cells} (${((100 * current.live) / current.cells).toFixed(1)}%), ${current.comps} components\n` +
		`wrote ${path.relative(ROOT, OUT)} (red bar: ${REV}, green bar: working tree)`,
);
