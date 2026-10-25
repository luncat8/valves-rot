const assert = require('node:assert/strict');
global.Path2D = class {
	moveTo() {}
	lineTo() {}
	arc() {}
};
const E = require('../prototype/glm-5.3-max/engine.js');
const G = require('../prototype/gpt-6-sol-max/simulation.js');
let elbows = 0;
for (let layout = 0; layout < 30; layout++) {
	const world = E.createWorld();
	assert.equal(world.valves.length, 100);
	for (const v of world.valves) {
		const arc = v.prims.find(p => p.t === 1);
		if (!arc) continue;
		elbows++;
		const first = v.prims[0], last = v.prims[2];
		for (const [x, y, dx, dy] of [
			[first.bx, first.by, first.bx - first.ax, first.by - first.ay],
			[last.ax, last.ay, last.bx - last.ax, last.by - last.ay],
		]) {
			assert.ok(Math.abs(Math.hypot(x - arc.cx, y - arc.cy) - arc.r) < 1e-8);
			assert.ok(Math.abs((x - arc.cx) * dx + (y - arc.cy) * dy) < 1e-8);
		}
		const x = arc.cx + Math.cos(arc.mid) * arc.r;
		const y = arc.cy + Math.sin(arc.mid) * arc.r;
		assert.ok(E.isAir(world, v.cx + x, v.cy + y, 0));
		assert.ok(!E.isAir(world, v.cx - x, v.cy - y, 0));
	}
	E.setParticleCount(world, 120);
	for (let i = 0; i < 10; i++) {
		E.stepValves(world, 1 / 120);
		E.stepParticles(world, 1 / 120);
	}
	assert.equal(world.particles.length, 120);
	for (const p of world.particles) assert.ok(Number.isFinite(p.x + p.y + p.vx + p.vy));
}
assert.ok(elbows > 0);
assert.equal(G.makeSimulation().valves.length, 100);
console.log(`OK: ${elbows} elbow fixtures; tangent joins, correct side, finite particle smoke checks, both Node exports.`);
