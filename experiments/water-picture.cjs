// Water picture: two panels written to logs/water-state-0.3.png so a colour or
// alpha change can be judged without a browser. Left is the seeded field mid-fill
// from the vent; right is a sealed pool with one grain of every material, so the
// float/sink result of slice 3 is visible in the same picture.
// It composites the same layers the page does — dark ceramic, pale passages, the
// translucent water sheet, then the grains — and is a colour preview, not a render
// test (that is render-smoke.cjs).
// Run: node experiments/water-picture.cjs [seed] [seconds]
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const SHARED = path.join(ROOT, "prototype", "shared");
const G = require(path.join(SHARED, "geometry.js"));
const S = require(path.join(SHARED, "simulation.js"));
const W = require(path.join(SHARED, "water.js"));

const SEED = Number(process.argv[2]) || 7;
const SECONDS = Number(process.argv[3]) || 6;
const OUT = path.join(__dirname, "logs", "water-state-0.3.png");
const GRAIN = S.GRAIN_COLORS.map(hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);

// The page's water sheet, kept next to render.js's constants so a change there
// shows up here: deep blue, alpha ramping in over a short band.
const WATER_RGB = [30, 112, 210];
const WATER_ALPHA_MIN = 0.58;
const WATER_ALPHA_FULL = 1;
const WATER_BAND = 6;

function fieldSim() {
	const sim = S.create(G.createLayout(SEED));
	S.setPressure(sim, "off");
	const w = S.setWater(sim, true);
	S.seed(sim);
	W.setVent(w, 4, true);
	W.setSupply(w, 600);
	for (let k = 0; k < SECONDS * 120; k++) S.step(sim, S.STEP);
	return sim;
}

// A sealed two-cell pool: water stays in it, so it is the honest "does colour
// read as water" case and the only place a floating grain can come to rest.
function poolSim() {
	const N = G.N;
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			const pool = j === 5 && (i === 4 || i === 5);
			valves.push(G.makeValve(i, j, pool ? "hollow" : "solid", pool ? [i === 4 ? 0 : 2] : [], 0, pool ? G.RV * 0.85 : 0));
		}
	}
	const sim = S.create({ seed: 3, valves }, { turning: false });
	S.setPressure(sim, "off");
	const w = S.setWater(sim, true);
	W.rebuild(sim);
	const v = sim.layout.valves[5 * N + 4];
	w.vol[Math.floor((v.cy + G.POUR) / w.cell) * w.nx + Math.floor(v.cx / w.cell)] = 1400;
	for (let c = 0; c < 6; c++) S.addGrain(sim, v.cx + (c - 2.5) * 8.4, v.cy - 12, 2.7, c);
	for (let c = 0; c < 6; c++) S.addGrain(sim, v.cx + (c - 2.5) * 8.4 + 4, v.cy - 3, 2.7, c);
	for (let k = 0; k < 12 * 120; k++) S.step(sim, S.STEP);
	return sim;
}

function mix(px, o, rgb, a) {
	px[o] += (rgb[0] - px[o]) * a;
	px[o + 1] += (rgb[1] - px[o + 1]) * a;
	px[o + 2] += (rgb[2] - px[o + 2]) * a;
}

// `view` is the world rect to draw and how many pixels per world px, so the
// sealed pool can be inspected at a scale where a 2.7 px grain still reads.
function render(sim, view) {
	const w = sim.water;
	const vx0 = view ? view.x0 : 0;
	const vy0 = view ? view.y0 : -G.POUR;
	const sc = view ? view.scale : 1;
	const wdt = Math.round((view ? view.w : G.SIZE) * sc);
	const hgt = Math.round((view ? view.h : G.SIZE + 2 * G.POUR) * sc);
	const px = Buffer.alloc(wdt * hgt * 3);
	for (let i = 0; i < px.length; i += 3) {
		px[i] = 18;
		px[i + 1] = 22;
		px[i + 2] = 29;
	}
	// Passages: pale ceramic where the shared clearance admits a grain-sized disc.
	for (let y = 0; y < hgt; y++) {
		for (let x = 0; x < wdt; x++) {
			const clear = G.airClearance(sim.layout, vx0 + (x + 0.5) / sc, vy0 + (y + 0.5) / sc);
			const o = (y * wdt + x) * 3;
			if (clear >= 2.7) {
				px[o] = 236;
				px[o + 1] = 240;
				px[o + 2] = 244;
			} else if (clear > 0) {
				px[o] = 118;
				px[o + 1] = 128;
				px[o + 2] = 140;
			}
		}
	}
	// Water sheet: alpha grows with the depth below the waterline, read from the
	// same published levels the buoyancy uses.
	for (let y = 0; y < hgt; y++) {
		for (let x = 0; x < wdt; x++) {
			const wy = vy0 + (y + 0.5) / sc;
			const level = W.surfaceAt(w, vx0 + (x + 0.5) / sc, wy);
			const depth = wy - level;
			if (!(depth > 0)) continue;
			let t = depth / WATER_BAND;
			if (t > 1) t = 1;
			mix(px, (y * wdt + x) * 3, WATER_RGB, WATER_ALPHA_MIN + (WATER_ALPHA_FULL - WATER_ALPHA_MIN) * t);
		}
	}
	// Grains on top, so a submerged grain is read through the sheet.
	for (let k = 0; k < sim.count; k++) {
		const cx = (sim.x[k] - vx0) * sc;
		const cy = (sim.y[k] - vy0) * sc;
		const rad = sim.r[k] * sc;
		const col = GRAIN[sim.color[k]];
		const edge = (rad - 1) * (rad - 1);
		for (let dy = -Math.ceil(rad); dy <= rad; dy++) {
			for (let dx = -Math.ceil(rad); dx <= rad; dx++) {
				const d2 = dx * dx + dy * dy;
				if (d2 > rad * rad) continue;
				const x = Math.round(cx + dx);
				const y = Math.round(cy + dy);
				if (x < 0 || x >= wdt || y < 0 || y >= hgt) continue;
				mix(px, (y * wdt + x) * 3, col, d2 > edge ? 0.55 : 1);
			}
		}
	}
	return { px, wdt, hgt };
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

function writePng(panels) {
	const pad = 10;
	const width = panels.reduce((sum, p) => sum + p.wdt + pad, pad);
	const height = panelHeight(panels) + pad * 2;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const image = Buffer.alloc((width * 3 + 1) * height);
	for (let i = 0; i < image.length; i++) image[i] = 12;
	for (let y = 0; y < height; y++) image[y * (width * 3 + 1)] = 0;
	let x0 = pad;
	for (const p of panels) {
		for (let y = 0; y < p.hgt; y++) {
			const dst = (y + pad) * (width * 3 + 1) + 1 + x0 * 3;
			p.px.copy(image, dst, y * p.wdt * 3, (y + 1) * p.wdt * 3);
		}
		x0 += p.wdt + pad;
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

function panelHeight(panels) {
	let h = 0;
	for (const p of panels) if (p.hgt > h) h = p.hgt;
	return h;
}

const field = fieldSim();
const pool = poolSim();
const chamber = pool.layout.valves[5 * G.N + 4];
writePng([
	render(field),
	render(pool, { x0: chamber.cx - 62, y0: chamber.cy - 42, w: 124, h: 84, scale: 3 }),
]);
if (process.env.WATER_DEBUG) {
	for (let k = 0; k < pool.count; k++) {
		const f = W.submerged(pool.water, pool.x[k], pool.y[k], pool.r[k]);
		console.log(S.MATERIAL_NAMES[pool.color[k]].padEnd(14), "y", pool.y[k].toFixed(1), "vy", pool.vy[k].toFixed(1), "f", f.toFixed(2), "line", W.surfaceAt(pool.water, pool.x[k], pool.y[k]).toFixed(1));
	}
}
const fw = field.water;
const pw = pool.water;
console.log(
	`left  seed ${SEED} after ${SECONDS}s: stored ${W.storedVol(fw).toFixed(0)} px² in ${W.wetCount(fw)} cells, ` +
		`overflow ${fw.overflowed.toFixed(0)}, grains ${field.count}\n` +
		`right sealed pool at 3x: stored ${W.storedVol(pw).toFixed(0)} px², grains ${pool.count}, ` +
		`waterline ${W.surfaceAt(pw, chamber.cx, chamber.cy).toFixed(1)}\n` +
		`wrote ${path.relative(ROOT, OUT)}`,
);
