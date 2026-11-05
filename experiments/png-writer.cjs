// Minimal PNG writer for the picture scripts: panels of raw RGB rows side by
// side, an optional colour bar above each panel, no dependencies.
// Run under node only; the page never loads this file.
"use strict";
const fs = require("node:fs");
const zlib = require("node:zlib");

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

// panels: [{ w, h, rgb, bar? }]. `bar` is an [r, g, b] strip above that panel,
// so a side-by-side comparison can say which build is which.
function writePng(file, panels, options) {
	const opts = options || {};
	const pad = opts.pad === undefined ? 10 : opts.pad;
	const bar = opts.bar === undefined ? 0 : opts.bar;
	const bg = opts.background === undefined ? 16 : opts.background;
	let width = pad;
	let height = pad * 2 + bar;
	for (const p of panels) width += p.w + pad;
	for (const p of panels) if (p.h > height - pad * 2 - bar) height = p.h + pad * 2 + bar;
	const stride = width * 3 + 1;
	const image = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const row = y * stride;
		image[row] = 0; // no per-row filter
		image.fill(bg, row + 1, row + stride);
	}
	let x0 = pad;
	for (const p of panels) {
		if (bar && p.bar) {
			for (let y = 0; y < bar; y++) {
				const row = (pad + y) * stride + 1 + x0 * 3;
				for (let x = 0; x < p.w; x++) {
					image[row + x * 3] = p.bar[0];
					image[row + x * 3 + 1] = p.bar[1];
					image[row + x * 3 + 2] = p.bar[2];
				}
			}
		}
		for (let y = 0; y < p.h; y++) {
			const dst = (y + pad + bar) * stride + 1 + x0 * 3;
			p.rgb.copy(image, dst, y * p.w * 3, (y + 1) * p.w * 3);
		}
		x0 += p.w + pad;
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // truecolour
	fs.writeFileSync(
		file,
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", ihdr),
			chunk("IDAT", zlib.deflateSync(image, { level: 9 })),
			chunk("IEND", Buffer.alloc(0)),
		]),
	);
}

module.exports = { writePng };
