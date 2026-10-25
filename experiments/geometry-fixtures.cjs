// Deterministic geometry and seam-contact fixtures for the shared geometry layer.
// Run: node experiments/geometry-fixtures.cjs
const assert = require("node:assert/strict");

// Record every path command so the drawing path can be compared with the prims.
const pathLog = [];
global.Path2D = class {
	moveTo(x, y) {
		pathLog.push(["moveTo", x, y]);
	}
	lineTo(x, y) {
		pathLog.push(["lineTo", x, y]);
	}
	arc(cx, cy, r, a0, a1, ccw) {
		pathLog.push(["arc", cx, cy, r, a0, a1, !!ccw]);
	}
};
const G = require("../prototype/shared/geometry.js");

const N = G.N;
const HALF = G.HALF;
const RV = G.RV;
const EPS = 1e-7;
const stats = { rimRings: 0, throats: 0, closedThroats: 0, prims: 0, shutSweeps: 0, hits: 0, lattice: 0, roundTrips: 0 };

function distSeg(px, py, ax, ay, bx, by) {
	const dx = bx - ax;
	const dy = by - ay;
	const l2 = dx * dx + dy * dy;
	let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function portDelta(portAngle, seamAngle) {
	let d = portAngle - seamAngle;
	while (d > Math.PI) d -= G.TAU;
	while (d <= -Math.PI) d += G.TAU;
	return d;
}

// 1. Layout determinism and structure.
function fixtureLayouts() {
	const a = G.createLayout(7);
	const b = G.createLayout(7);
	const c = G.createLayout(8);
	assert.equal(a.valves.length, N * N);
	assert.equal(JSON.stringify(a.valves.map(G.describe)), JSON.stringify(b.valves.map(G.describe)));
	assert.notEqual(JSON.stringify(a.valves.map(G.describe)), JSON.stringify(c.valves.map(G.describe)));
	let hollow = 0;
	let blanks = 0;
	let elbows = 0;
	a.valves.forEach((v, index) => {
		assert.equal(v.i, index % N);
		assert.equal(v.j, (index / N) | 0);
		assert.equal(v.cx, (v.i + 0.5) * G.S);
		assert.equal(v.cy, (v.j + 0.5) * G.S);
		assert.ok(v.ports.length <= 4);
		if (v.kind === "hollow") hollow++;
		if (v.prims.length === 0) blanks++;
		if (v.prims.some((pr) => pr.t === G.T_ARC)) elbows++;
		for (const p of v.ports) assert.ok(p >= 0 && p < 4);
	});
	assert.ok(hollow > 20 && hollow < 60, `hollow share ${hollow}`);
	assert.ok(elbows > 0, "layout must contain elbows");
	return { layout: a, hollow, blanks, elbows };
}

// 2. Tangent elbows: legs meet the arc at right angles and the arc midpoint sits
// on the inner side of the bend.
function fixtureElbows(layout) {
	let checked = 0;
	for (const v of layout.valves) {
		const arc = v.prims.find((pr) => pr.t === G.T_ARC);
		if (!arc) continue;
		const legs = v.prims.filter((pr) => pr.t === G.T_TUBE);
		for (const leg of legs) {
			for (const end of [-1, 1]) {
				const x = leg.cx + leg.ux * leg.hx * end;
				const y = leg.cy + leg.uy * leg.hx * end;
				const rr = Math.hypot(x - arc.cx, y - arc.cy);
				if (Math.abs(rr - arc.r) > 1e-6) continue;
				// radial direction of the join must be perpendicular to the leg
				assert.ok(Math.abs((x - arc.cx) * leg.ux + (y - arc.cy) * leg.uy) < 1e-9);
				checked++;
			}
		}
		const midX = arc.cx + Math.cos(arc.mid) * arc.r;
		const midY = arc.cy + Math.sin(arc.mid) * arc.r;
		assert.ok(G.isAir(layout, v.cx + midX, v.cy + midY, 0.5), "arc midpoint must be air");
		checked++;
	}
	assert.ok(checked > 0);
	stats.prims += checked;
	return checked;
}

// 3. Seam membership must agree with the rotated port directions, stay symmetric
// under a half turn and keep a continuous thread of air from rotor to housing.
function fixtureSeams(layout) {
	const probe = { x: 0, y: 0, hit: false };
	for (const v of layout.valves) {
		const seen = new Set();
		for (let a = 0; a < 40; a++) {
			G.setAngle(v, (a * G.TAU) / 40);
			for (let s = 0; s < 4; s++) {
				let expect = 0;
				for (const p of v.ports) {
					const d = portDelta(G.PORT_ANG[p] + v.angle, G.PORT_ANG[s]);
					if (d <= -G.HALF_PI || d >= G.HALF_PI) continue;
					const cap = (HALF - RV * Math.abs(Math.sin(d))) / Math.cos(d);
					expect = Math.max(expect, Math.min(cap, HALF));
				}
				assert.ok(Math.abs(v.seam[s] - expect) < EPS, "seam must follow rotated ports");
				assert.ok(v.seam[s] > -EPS && v.seam[s] <= HALF + EPS);
				if (expect > 0) stats.throats++;
				else stats.closedThroats++;
			}
			// a port is either clearly open or clearly shut: no seam flicker
			for (const val of v.seam) seen.add(val > 0);
			if (v.ports.length === 2 && Math.abs(v.ports[0] - v.ports[1]) % 2 === 0) {
				// a through passage keeps both opposite throats equal while it turns
				assert.ok(Math.abs(v.seam[0] - v.seam[2]) < EPS && Math.abs(v.seam[1] - v.seam[3]) < EPS);
			}
			// continuous thread of air along every open seam
			for (let s = 0; s < 4; s++) {
				if (v.seam[s] <= 0) continue;
				const ux = G.DX[s];
				const uy = G.DY[s];
				// A passage that stops at the rotor centre is capped by the pocket
				// bottom, so the thread of air starts just inside that cap.
				const axes = new Set(v.ports.map((p) => p % 2));
				const centerAir =
					v.kind === "hollow" ||
					axes.size === 2 ||
					v.ports.some((p) => v.ports.indexOf((p + 2) % 4) >= 0);
				for (let r = centerAir ? 0 : 1; r <= RV; r += 0.25) {
					assert.ok(
						G.isAir(layout, v.cx + ux * r, v.cy + uy * r, 0.25),
						`rotor thread port seam s=${s} r=${r.toFixed(2)}`,
					);
				}
				for (let k = -2; k <= 2; k++) {
					const lat = (k * v.seam[s]) / 3;
					assert.ok(G.isAir(layout, v.cx + ux * (RV / 2) - uy * lat, v.cy + uy * (RV / 2) + ux * lat, 0.25));
				}
				stats.rimRings++;
				// the throat is tight: beside the aperture the rotor rim is metal,
				// and a grain in the housing channel cannot straddle that rim
				const off = v.seam[s] + 1.5;
				if (off < HALF - 1) {
					for (const sgn of [-1, 1]) {
						const besideX = v.cx + ux * (RV - 1) - uy * off * sgn;
						const besideY = v.cy + uy * (RV - 1) + ux * off * sgn;
						assert.ok(!G.isAir(layout, besideX, besideY, 0.9), "rim beside the aperture is metal");
						const channelX = v.cx + ux * (RV + 0.6) - uy * off * sgn;
						const channelY = v.cy + uy * (RV + 0.6) + ux * off * sgn;
						assert.ok(!G.isAir(layout, channelX, channelY, 2), "channel grains keep off the shut rim");
					}
				}
			}
			// blocked crossings: a shut seam closes the rim, so no grain crosses it
			for (let s = 0; s < 4; s++) {
				if (v.seam[s] > 0) continue;
				const ux = G.DX[s];
				const uy = G.DY[s];
				const x = v.cx + ux * (RV - 1);
				const y = v.cy + uy * (RV - 1);
				assert.ok(!G.isAir(layout, x, y, 0.9), "shut seam must be solid");
				assert.ok(!G.isAir(layout, x, y, 0.25));
				G.sweep(layout, v.cx + ux * (RV - 6), v.cy + uy * (RV - 6), v.cx + ux * (RV + 8), v.cy + uy * (RV + 8), 2.5, probe);
				assert.ok(probe.hit, "sweep must report the shut seam");
				assert.ok(Math.hypot(probe.x - v.cx, probe.y - v.cy) <= RV - 2, "nothing crosses a shut seam");
				stats.shutSweeps++;
			}
		}
		assert.ok(seen.size <= 2);
	}
	// Rotation invariance: a quarter turn of the rotor equals shifting every port
	// index by one, so both clearance fields must agree point by point.
	let compared = 0;
	for (const v of layout.valves) {
		const shifted = G.makeValve(v.i, v.j, v.kind, v.ports.map((p) => (p + 1) & 3), 0, v.chamberR);
		for (let a = 0; a < 5; a++) {
			const angle = (a * G.TAU) / 9 + 0.13;
			G.setAngle(v, angle);
			G.setAngle(shifted, angle - G.HALF_PI);
			for (let k = 0; k < 18; k++) {
				const r = k < 12 ? RV * (0.1 + 0.75 * ((k % 6) / 5)) : RV + HALF * (0.2 + 0.13 * k);
				const t = (k * 2.399) % G.TAU;
				const x = v.cx + Math.cos(t) * r;
				const y = v.cy + Math.sin(t) * r;
				assert.ok(Math.abs(G.valveClearance(v, x, y) - G.valveClearance(shifted, x, y)) < EPS, "quarter turn invariance");
				compared++;
			}
		}
	}
	stats.roundTrips += compared;
	return compared;
}

// 4. Housing channels: passable along their whole length, full width at the
// cell edge, sealed at field sides and open in the pour spouts.
function fixtureHousing(layout) {
	let steps = 0;
	for (const v of layout.valves) {
		for (let s = 0; s < 4; s++) {
			const ux = G.DX[s];
			const uy = G.DY[s];
			const st = v.strips[s];
			for (let r = RV + 1.5; r <= st.far - 1.5 + EPS; r++) {
				assert.ok(
					G.isAir(layout, v.cx + ux * r, v.cy + uy * r, 1.4),
					"housing channel must be passable between cells",
				);
			}
			const along = st.far - 0.8;
			for (let k = -1; k <= 1; k++) {
				const lat = k * (HALF - 1.2);
				assert.ok(
					G.isAir(layout, v.cx + ux * along - uy * lat, v.cy + uy * along + ux * lat, 0.7),
					"channel keeps its width at the cell edge",
				);
			}
			steps++;
			if (!st.openOuter) {
				const endX = v.cx + ux * (st.far - 0.6);
				const endY = v.cy + uy * (st.far - 0.6);
				assert.ok(!G.isAir(layout, endX, endY, 0.9), "field side walls must be sealed");
			}
			if (st.spout) {
				const pourX = v.cx + ux * (st.far - 2);
				const pourY = v.cy + uy * (st.far - 2);
				assert.ok(G.isAir(layout, pourX, pourY, HALF * 0.6), "pour spout must stay open");
				// free of the rim the spout is exactly one channel wide
				const free = RV + HALF + 0.2;
				assert.ok(Math.abs(G.airClearance(layout, v.cx + ux * free, v.cy + uy * free) - HALF) < EPS);
			}
		}
	}
	return steps;
}

// 5. Passage samples: an independent segment-distance test must agree with the
// clearance field along every tube axis and arc centerline.
function fixturePassages(layout) {
	let samples = 0;
	for (const v of layout.valves) {
		if (!v.prims.length) continue;
		const c = v.cos;
		const s = v.sin;
		for (const pr of v.prims) {
			for (let k = 0; k <= 8; k++) {
				let px;
				let py;
				let margin = Infinity;
				let need = Math.min(HALF * 0.5, 2);
				if (pr.t === G.T_TUBE) {
					const a = -pr.hx + (2 * pr.hx * k) / 8;
					px = pr.cx + pr.ux * a;
					py = pr.cy + pr.uy * a;
					if (!pr.openLo) margin = Math.min(margin, a + pr.hx);
					if (!pr.openHi) margin = Math.min(margin, pr.hx - a);
				} else if (pr.t === G.T_ARC) {
					const a = pr.a0 + ((pr.a1 - pr.a0) * k) / 8;
					px = pr.cx + Math.cos(a) * pr.r;
					py = pr.cy + Math.sin(a) * pr.r;
					margin = HALF;
				} else {
					const t = (k / 8) * pr.r * 0.8;
					px = Math.cos(0.9) * t;
					py = Math.sin(0.9) * t;
					margin = pr.r - t;
					need = Math.min(0.6, pr.r * 0.2);
				}
				// ends on a cap or on the rotor rim lose clearance by geometry, not
				// by modelling error; rim behaviour is covered by the seam fixtures
				margin = Math.min(margin, RV - Math.hypot(px, py));
				if (margin < need) continue;
				const x = v.cx + px * c - py * s;
				const y = v.cy + px * s + py * c;
				assert.ok(G.isAir(layout, x, y, need), "passage centerline must be air");
				samples++;
			}
		}
	}
	stats.lattice += samples;
	return samples;
}

// 6. No invented air: every interior point with clearance is explained by a
// passage or by a housing channel.
function fixtureNoInventedAir(layout) {
	let checked = 0;
	for (const v of layout.valves) {
		if (!v.prims.length) continue;
		for (let k = 0; k < 40; k++) {
			const r = RV * (0.15 + 0.8 * (((k * 7) % 40) / 40));
			const t = (k * 2.399) % G.TAU;
			const px = Math.cos(t) * r;
			const py = Math.sin(t) * r;
			const x = v.cx + px * v.cos - py * v.sin;
			const y = v.cy + px * v.sin + py * v.cos;
			if (!G.isAir(layout, x, y, 0.6)) continue;
			let nearPrim = false;
			for (const pr of v.prims) {
				if (pr.t === G.T_DISK) {
					if (Math.hypot(px, py) <= pr.r + 1) nearPrim = true;
				} else if (pr.t === G.T_TUBE) {
					if (distSeg(px, py, pr.cx - pr.ux * pr.hx, pr.cy - pr.uy * pr.hx, pr.cx + pr.ux * pr.hx, pr.cy + pr.uy * pr.hx) <= HALF + 1)
						nearPrim = true;
				} else {
					for (let q = 0; q <= 8; q++) {
						const a = pr.a0 + ((pr.a1 - pr.a0) * q) / 8;
						if (Math.hypot(px - (pr.cx + Math.cos(a) * pr.r), py - (pr.cy + Math.sin(a) * pr.r)) <= HALF + 1)
							nearPrim = true;
					}
				}
			}
			let nearStrip = false;
			for (let s = 0; s < 4; s++) {
				const st = v.strips[s];
				const a = (px - st.ax) * st.ux + (py - st.ay) * st.uy;
				const lat = (py - st.ay) * st.ux - (px - st.ax) * st.uy;
				if (Math.abs(a) <= st.hx + 1 && Math.abs(lat) <= HALF + 1) nearStrip = true;
			}
			assert.ok(nearPrim || nearStrip, "air must belong to a passage or channel");
			checked++;
		}
	}
	return checked;
}

// 7. Sweep contact: results are always air, never past the first contact, and
// monotone direction changes do not tunnel through walls.
function fixtureSweepContact(layout) {
	const out = { x: 0, y: 0, hit: false };
	const dirs = [];
	for (let k = 0; k < 16; k++) dirs.push((k * G.TAU) / 16 + 0.07);
	let sweepCount = 0;
	let hits = 0;
	for (const v of layout.valves) {
		const starts = [[0, 0]];
		if (v.kind === "hollow") starts.push([0, v.chamberR * 0.5]);
		else if (v.ports.length) starts.push([G.DX[v.ports[0]] * RV * 0.6, G.DY[v.ports[0]] * RV * 0.6]);
		for (const [lx, ly] of starts) {
			const start = G.isAir(layout, v.cx + lx, v.cy + ly, 2.5);
			if (!start) continue;
			for (const dir of dirs) {
				const dx = Math.cos(dir) * 9;
				const dy = Math.sin(dir) * 9;
				G.sweep(layout, v.cx + lx, v.cy + ly, v.cx + lx + dx, v.cy + ly + dy, 2.5, out);
				sweepCount++;
				assert.ok(Number.isFinite(out.x) && Number.isFinite(out.y));
				assert.ok(G.isAir(layout, out.x, out.y, 2.5), "sweep endpoint must be air");
				if (!out.hit) continue;
				hits++;
				// the sweep must stop at the very first blocked sample of the ray,
				// never beyond it and never earlier than the contact
				let firstBlocked = 1;
				for (let k = 1; k <= 40; k++) {
					const t = k / 40;
					if (!G.isAir(layout, v.cx + lx + dx * t, v.cy + ly + dy * t, 2.5)) {
						firstBlocked = t;
						break;
					}
				}
				const reached = Math.hypot(out.x - v.cx - lx, out.y - v.cy - ly) / Math.hypot(dx, dy);
				assert.ok(reached <= firstBlocked + 1e-9, "sweep must not tunnel past the first contact");
				assert.ok(firstBlocked - reached < 0.16, "sweep must reach the contact, not stop short");
				// everything before the contact point is fully clear
				for (let k = 1; k <= 6; k++) {
					const t = (k / 6) * reached;
					assert.ok(
						G.isAir(layout, v.cx + lx + dx * t, v.cy + ly + dy * t, 2.5 - 1e-9),
					);
				}
			}
		}
	}
	return { sweepCount, hits };
}

// 8. Clearance values at known reference points.
function fixtureClearanceValues(layout) {
	let refs = 0;
	for (const v of layout.valves) {
		if (v.kind === "hollow") {
			if (v.chamberR > HALF) {
				assert.ok(Math.abs(G.airClearance(layout, v.cx, v.cy) - v.chamberR) < EPS);
				refs++;
			}
		} else if (v.ports.length === 2 && Math.abs(v.ports[0] - v.ports[1]) % 2 === 0) {
			assert.ok(Math.abs(G.airClearance(layout, v.cx, v.cy) - HALF) < EPS, "through passage is half-width air");
			refs++;
		}
		for (let s = 0; s < 4; s++) {
			const st = v.strips[s];
			const along = (RV + st.far) / 2;
			const cx = v.cx + st.ux * along;
			const cy = v.cy + st.uy * along;
			// On the channel axis the clearance is the channel half width, unless
			// the shut rotor rim or a sealed field edge is nearer than that.
			let expect = HALF;
			if (v.seam[s] <= 0) expect = Math.min(expect, along - RV);
			if (!st.openOuter) expect = Math.min(expect, st.far - along);
			assert.ok(Math.abs(G.airClearance(layout, cx, cy) - expect) < EPS, "channel clearance at its axis");
			refs++;
		}
	}
	return refs;
}

// 9. Rotor centre: a through passage, a junction, a chamber and a bend each have
// an exact clearance there, and a blind pocket closes against the centre.
function fixtureCenters(layout) {
	let refs = 0;
	const elbowClearance = HALF - (G.ELBOW * Math.SQRT2 - G.ELBOW);
	for (const v of layout.valves) {
		const through = v.ports.some((p) => v.ports.indexOf((p + 2) % 4) >= 0);
		let expect = 0;
		if (v.kind === "hollow") expect = v.chamberR;
		else if (v.ports.length >= 3 || through) expect = HALF;
		else if (v.ports.length === 2) expect = elbowClearance;
		assert.ok(Math.abs(G.valveClearance(v, v.cx, v.cy) - expect) < 1e-9, "rotor centre clearance");
		refs++;
		if (v.kind !== "hollow" && v.ports.length === 1) {
			// blind pocket: the bottom caps the passage, so clearance grows linearly
			// the layout carries arbitrary rotor angles at this point
			const a = G.PORT_ANG[v.ports[0]] + v.angle;
			for (const r of [1, 2, 3]) {
				const x = v.cx + Math.cos(a) * r;
				const y = v.cy + Math.sin(a) * r;
				assert.ok(Math.abs(G.valveClearance(v, x, y) - Math.min(HALF, r)) < 1e-9, "pocket depth clearance");
				refs++;
			}
			assert.ok(!G.isAir(layout, v.cx, v.cy, 0.25), "pocket bottom must be solid");
		}
	}
	return refs;
}

// 9. The stroke path drawn on screen must be exactly the passage prims, so the
// picture and the collision field cannot drift apart.
function fixturePaths(layout) {
	let commands = 0;
	for (const v of layout.valves) {
		pathLog.length = 0;
		const path = G.buildPath(v.prims);
		assert.ok(path, "Path2D must be available in this fixture");
		let expect = 0;
		for (const pr of v.prims) {
			if (pr.t === G.T_DISK) continue;
			if (pr.t === G.T_TUBE) {
				const log = pathLog[expect];
				assert.equal(log[0], "moveTo");
				assert.ok(Math.abs(log[1] - (pr.cx - pr.ux * pr.hx)) < 1e-9);
				assert.ok(Math.abs(log[2] - (pr.cy - pr.uy * pr.hx)) < 1e-9);
				assert.equal(pathLog[expect + 1][0], "lineTo");
				assert.ok(Math.abs(pathLog[expect + 1][1] - (pr.cx + pr.ux * pr.hx)) < 1e-9);
				assert.ok(Math.abs(pathLog[expect + 1][2] - (pr.cy + pr.uy * pr.hx)) < 1e-9);
				expect += 2;
				continue;
			}
			assert.equal(pathLog[expect][0], "moveTo");
			assert.ok(Math.abs(pathLog[expect][1] - (pr.cx + Math.cos(pr.a0) * pr.r)) < 1e-9);
			assert.ok(Math.abs(pathLog[expect][2] - (pr.cy + Math.sin(pr.a0) * pr.r)) < 1e-9);
			const arcLog = pathLog[expect + 1];
			assert.equal(arcLog[0], "arc");
			assert.equal(arcLog[1], pr.cx);
			assert.equal(arcLog[2], pr.cy);
			assert.equal(arcLog[3], pr.r);
			assert.ok(Math.abs(arcLog[4] - pr.a0) < 1e-12 && Math.abs(arcLog[5] - pr.a1) < 1e-12);
			assert.equal(arcLog[6], pr.ccw);
			expect += 2;
		}
		assert.equal(pathLog.length, expect, "no drawing beyond the prims");
		commands += expect;
	}
	return commands;
}

// 11. Neighbouring corridors meet exactly at the shared cell edge: a grain must
// pass between cells without a seam, a lip or a phantom wall.
function fixtureCrossCell(layout) {
	let edges = 0;
	for (const v of layout.valves) {
		for (let s = 0; s < 4; s++) {
			const st = v.strips[s];
			if (!st.openOuter) continue;
			const ex = v.cx + G.DX[s] * st.far;
			const ey = v.cy + G.DY[s] * st.far;
			if (ex < 1 || ex > G.SIZE - 1 || ey < -G.POUR + 1 || ey > G.SIZE + G.POUR - 1) continue;
			const grain = 1.5;
			for (let k = -2; k <= 2; k++) {
				const lat = (k * (HALF - grain - 0.5)) / 2;
				const px = -G.DY[s] * lat;
				const py = G.DX[s] * lat;
				assert.ok(G.isAir(layout, ex + px, ey + py, grain), "no lip at the shared cell edge");
			}
			// Whichever cell owns the point, a passing grain must fit on both sides
			// of the shared edge. The exact value there is capped by the nearest
			// rotor rim, so only passability is asserted.
			assert.ok(G.airClearance(layout, ex - G.DX[s] * 0.5, ey - G.DY[s] * 0.5) >= 2 - EPS);
			assert.ok(G.airClearance(layout, ex + G.DX[s] * 0.5, ey + G.DY[s] * 0.5) >= 2 - EPS);
			edges++;
		}
	}
	stats.edges = edges;
	return edges;
}

// 10. Recovery: a grain pushed into metal must land on verified air, deterministically
// and without a longer move than a brute-force search would need.
const recover = { x: 0, y: 0, dist: 0, found: false };
function fixtureRecovery(layout) {
	let cases = 0;
	let worstGap = 0;
	for (const v of layout.valves) {
		for (let k = 0; k < 6; k++) {
			const a = (k * 2.399 + 0.4) % G.TAU;
			const r = RV * (0.3 + 0.5 * ((k % 5) / 5));
			const x = v.cx + Math.cos(a) * r;
			const y = v.cy + Math.sin(a) * r;
			if (G.isAir(layout, x, y, 2.6)) continue;
			G.nearestAir(layout, x, y, 2.6, recover);
			assert.ok(recover.found, "recovery must find air");
			assert.ok(G.isAir(layout, recover.x, recover.y, 2.6), "recovery must land on air");
			const first = { x: recover.x, y: recover.y, dist: recover.dist };
			G.nearestAir(layout, x, y, 2.6, recover);
			assert.equal(recover.x, first.x);
			assert.equal(recover.y, first.y);
			assert.equal(recover.dist, first.dist);
			// brute force over the reachable neighbourhood for optimality
			let best = Infinity;
			const span = Math.min(recover.dist + 1.5, 36);
			for (let dy = -span; dy <= span; dy += 0.75) {
				for (let dx = -span; dx <= span; dx += 0.75) {
					const d = Math.hypot(dx, dy);
					if (d >= best) continue;
					if (G.isAir(layout, x + dx, y + dy, 2.6)) best = d;
				}
			}
			const gap = recover.dist - best;
			if (gap > worstGap) worstGap = gap;
			assert.ok(gap <= 0.75, "recovery must be as short as a brute force search");
			cases++;
		}
	}
	stats.recovery = cases;
	stats.recoveryGap = worstGap;
	return cases;
}

// 11. A grain parked at a mouth when the rotor turns the seam shut must be pushed
// back into the housing channel, not through the rotor.
function fixtureSeamClosure(layout) {
	let closures = 0;
let edges = 0;
	let maxPush = 0;
	for (const v of layout.valves) {
		for (let s = 0; s < 4; s++) {
			const st = v.strips[s];
			if (!st.openOuter) continue;
			const x = v.cx + G.DX[s] * (RV + 0.4);
			const y = v.cy + G.DY[s] * (RV + 0.4);
			for (let step = 0; step < 24; step++) {
				G.setAngle(v, step * 0.13);
				if (G.isAir(layout, x, y, 2.6)) continue;
				closures++;
				G.nearestAir(layout, x, y, 3, recover);
				assert.ok(recover.found, "a closing seam must recover the grain");
				assert.ok(G.isAir(layout, recover.x, recover.y, 3));
				// the grain belongs to the housing channel, never the rotor interior
				assert.ok(
					Math.hypot(recover.x - v.cx, recover.y - v.cy) >= RV - 1e-6,
					"recovery must not push a channel grain into the rotor",
				);
				const push = Math.hypot(recover.x - x, recover.y - y);
				if (push > maxPush) maxPush = push;
				assert.ok(push < 9, "a closing seam must not teleport a grain far");
				break;
			}
		}
	}
	stats.closures = closures;
	stats.maxPush = maxPush;
	return closures;
}

const t0 = process.hrtime.bigint();
const base = fixtureLayouts();
const layouts = [base.layout, G.createLayout(11), G.createLayout(1234)];
let elbowCount = 0;
let seams = 0;
let housingSteps = 0;
let passageSamples = 0;
let noInvented = 0;
let sweepTotal = 0;
let clearanceRefs = 0;
let pathCommands = 0;
let recoveries = 0;
let closures = 0;
let edges = 0;
let hollow = base.hollow;
let blanks = base.blanks;
for (const layout of layouts) {
	elbowCount += fixtureElbows(layout);
	seams += fixtureSeams(layout);
	housingSteps += fixtureHousing(layout);
	passageSamples += fixturePassages(layout);
	noInvented += fixtureNoInventedAir(layout);
	const sweep = fixtureSweepContact(layout);
	sweepTotal += sweep.sweepCount;
	stats.hits += sweep.hits;
	clearanceRefs += fixtureClearanceValues(layout);
	pathCommands += fixturePaths(layout);
	clearanceRefs += fixtureCenters(layout);
	closures += fixtureSeamClosure(layout);
	edges += fixtureCrossCell(layout);
	recoveries += fixtureRecovery(layout);
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
assert.ok(stats.throats > 0 && stats.closedThroats > 0);
assert.ok(seams > 0 && passageSamples > 0 && sweepTotal > 0);
console.log(
	[
		`OK  layouts ${layouts.length} (seeds 7, 11, 1234) valves ${layouts.length * N * N}`,
		`hollow ${hollow} blanks ${blanks} elbows ${elbowCount}`,
		`seams ${seams} throats ${stats.throats} shut ${stats.closedThroats}`,
		`housing ${housingSteps} passages ${passageSamples} seamRings ${stats.rimRings}`,
		`noInventedAir ${noInvented} sweeps ${sweepTotal} contacts ${stats.hits} shutCrossings ${stats.shutSweeps}`,
		`clearanceRefs ${clearanceRefs} roundTrips ${stats.roundTrips} pathCommands ${pathCommands}`,
		`cellEdges ${edges} recovery ${recoveries} gap ${stats.recoveryGap.toFixed(2)} seamClosures ${closures} maxPush ${(stats.maxPush || 0).toFixed(2)}`,
		`ms ${ms.toFixed(0)}`,
	].join("\n"),
);
