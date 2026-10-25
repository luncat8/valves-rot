const ValveSimulation = (() => {
	"use strict";

	const GRID = 10;
	const CELL = 66;
	const SIZE = GRID * CELL;
	const VALVE_RADIUS = 25.8;
	const CHANNEL_WIDTH = 12;
	const CAVITY_RADIUS = 15;
	const WHITE_AIR = "#f4f4ef";
	const BLACK_AIR = "#172021";
	const QUARTER_TURN = Math.PI / 2;
	const HOUSING_COLORS = [
		"#777d7b",
		"#7c7e79",
		"#747d80",
		"#81817c",
		"#787a80",
		"#7b827c",
		"#80807e",
		"#747b77",
	];
	const METAL_COLORS = ["#a5aaa6", "#a9aaa3", "#9da8aa", "#aaa6a5", "#a3a9a2"];
	const PARTICLE_COLORS = [
		"#ff8668",
		"#f6ca64",
		"#79d5c9",
		"#a9b8f4",
		"#e7a1cd",
		"#abd979",
	];
	const PROBES = Array.from({ length: 12 }, (_, index) => {
		const angle = (index * Math.PI * 2) / 12;
		return { x: Math.cos(angle), y: Math.sin(angle) };
	});
	function random(min, max) {
		return min + Math.random() * (max - min);
	}
	function isChamber(kind) {
		return kind.startsWith("chamber");
	}
	function chooseKind(row, col) {
		const chance = Math.random();
		if (row < 3 && col % 3 === 1) {
			const kinds = ["chamber1", "chamber2", "chamber3", "chamber4"];
			return kinds[(row * 3 + Math.floor(col / 3)) % kinds.length];
		}
		if (chance < (row < 3 ? 0.48 : 0.31)) {
			const chambers = [
				"chamber1",
				"chamber2",
				"chamber2",
				"chamber3",
				"chamber3",
				"chamber4",
			];
			return chambers[Math.floor(Math.random() * chambers.length)];
		}
		if (chance < 0.72) return "elbow";
		if (chance < 0.9) return "straight";
		return "tee";
	}
	function createValves() {
		return Array.from({ length: GRID * GRID }, (_, index) => {
			const row = Math.floor(index / GRID);
			const col = index % GRID;
			const angle = Math.floor(Math.random() * 4) * QUARTER_TURN;
			return {
				kind: chooseKind(row, col),
				variant: Math.random() < 0.5 ? 0 : 1,
				angle,
				targetAngle:
					angle +
					(Math.random() < 0.12
						? (Math.random() < 0.5 ? -1 : 1) * QUARTER_TURN
						: 0),
				delta: 0,
				nextTurn: random(0.8, 3.8),
				turnRate: random(1.9, 2.65),
				housing:
					HOUSING_COLORS[Math.floor(Math.random() * HOUSING_COLORS.length)],
				metal: METAL_COLORS[Math.floor(Math.random() * METAL_COLORS.length)],
			};
		});
	}
	function portsFor(valve) {
		switch (valve.kind) {
			case "chamber1":
				return [0];
			case "chamber2":
				return valve.variant ? [0, 2] : [0, 1];
			case "chamber3":
				return [0, 1, 3];
			case "chamber4":
				return [0, 1, 2, 3];
			default:
				return [];
		}
	}
	function drawPassages(ctx, valve, air, mask = false) {
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		if (!isChamber(valve.kind)) {
			ctx.beginPath();
			if (valve.kind === "straight") {
				ctx.moveTo(0, -VALVE_RADIUS - 3);
				ctx.lineTo(0, VALVE_RADIUS + 3);
			} else if (valve.kind === "elbow") {
				ctx.moveTo(0, -VALVE_RADIUS - 3);
				ctx.lineTo(0, -13);
				ctx.quadraticCurveTo(0, 0, 13, 0);
				ctx.lineTo(VALVE_RADIUS + 3, 0);
			} else {
				ctx.moveTo(-VALVE_RADIUS - 3, 0);
				ctx.lineTo(VALVE_RADIUS + 3, 0);
				ctx.moveTo(0, -VALVE_RADIUS - 3);
				ctx.lineTo(0, 0);
			}
			if (!mask) {
				ctx.strokeStyle = "#45504f";
				ctx.lineWidth = CHANNEL_WIDTH + 4.3;
				ctx.stroke();
			}
			ctx.strokeStyle = air;
			ctx.lineWidth = CHANNEL_WIDTH;
			ctx.stroke();
			return;
		}
		const ports = portsFor(valve);
		if (!mask) {
			ctx.beginPath();
			ctx.arc(0, 0, CAVITY_RADIUS + 2.5, 0, Math.PI * 2);
			ctx.fillStyle = "#45504f";
			ctx.fill();
		}
		ctx.beginPath();
		for (const port of ports) {
			const angle = -Math.PI / 2 + port * QUARTER_TURN;
			ctx.moveTo(0, 0);
			ctx.lineTo(
				Math.cos(angle) * (VALVE_RADIUS + 3),
				Math.sin(angle) * (VALVE_RADIUS + 3),
			);
		}
		if (!mask) {
			ctx.strokeStyle = "#45504f";
			ctx.lineWidth = CHANNEL_WIDTH + 4.3;
			ctx.stroke();
		}
		ctx.strokeStyle = air;
		ctx.lineWidth = CHANNEL_WIDTH;
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(0, 0, CAVITY_RADIUS, 0, Math.PI * 2);
		ctx.fillStyle = air;
		ctx.fill();
	}
	function drawHousingChannels(ctx, x, y, width, color) {
		const center = CELL / 2;
		ctx.fillStyle = color;
		ctx.fillRect(x + center - width / 2, y, width, CELL);
		ctx.fillRect(x, y + center - width / 2, CELL, width);
	}
	function drawVisible(ctx, sim, air, hovered) {
		ctx.fillStyle = "#263030";
		ctx.fillRect(0, 0, SIZE, SIZE);
		sim.valves.forEach((valve, index) => {
			const x = (index % GRID) * CELL;
			const y = Math.floor(index / GRID) * CELL;
			ctx.fillStyle = valve.housing;
			ctx.fillRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
			ctx.strokeStyle = "rgba(25, 37, 38, 0.47)";
			ctx.lineWidth = 1;
			ctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
			ctx.fillStyle = "rgba(255, 255, 255, 0.115)";
			ctx.fillRect(x + 1.5, y + 1.5, CELL - 3, 1);
			ctx.fillStyle = "rgba(23, 32, 33, 0.11)";
			ctx.fillRect(x + CELL - 2.5, y + 1.5, 1, CELL - 3);
		});
		sim.valves.forEach((_, index) => {
			const x = (index % GRID) * CELL;
			const y = Math.floor(index / GRID) * CELL;
			drawHousingChannels(ctx, x, y, CHANNEL_WIDTH + 4.3, "#46504f");
			drawHousingChannels(ctx, x, y, CHANNEL_WIDTH, air);
		});
		sim.valves.forEach((valve, index) => {
			const cx = (index % GRID) * CELL + CELL / 2;
			const cy = Math.floor(index / GRID) * CELL + CELL / 2;
			ctx.save();
			ctx.translate(cx, cy);
			ctx.beginPath();
			ctx.arc(0, 0, VALVE_RADIUS + 1.05, 0, Math.PI * 2);
			ctx.fillStyle = "#354241";
			ctx.fill();
			ctx.beginPath();
			ctx.arc(0, 0, VALVE_RADIUS - 1.1, 0, Math.PI * 2);
			ctx.fillStyle = valve.metal;
			ctx.fill();
			ctx.beginPath();
			ctx.arc(0, 0, VALVE_RADIUS - 2.8, 0, Math.PI * 2);
			ctx.strokeStyle = "rgba(255, 255, 255, 0.24)";
			ctx.lineWidth = 0.8;
			ctx.stroke();
			ctx.rotate(valve.angle);
			ctx.beginPath();
			ctx.arc(0, 0, VALVE_RADIUS + 1.05, 0, Math.PI * 2);
			ctx.clip();
			drawPassages(ctx, valve, air);
			ctx.restore();
		});
		for (const particle of sim.particles) {
			ctx.beginPath();
			ctx.arc(
				particle.x + 0.8,
				particle.y + 1.1,
				particle.radius + 0.65,
				0,
				Math.PI * 2,
			);
			ctx.fillStyle = "rgba(14, 24, 25, 0.42)";
			ctx.fill();
			ctx.beginPath();
			ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
			ctx.fillStyle = particle.color;
			ctx.fill();
			ctx.strokeStyle = "rgba(20, 32, 33, 0.48)";
			ctx.lineWidth = 0.75;
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(
				particle.x - particle.radius * 0.29,
				particle.y - particle.radius * 0.3,
				0.7,
				0,
				Math.PI * 2,
			);
			ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
			ctx.fill();
		}
		if (hovered >= 0) {
			const x = (hovered % GRID) * CELL;
			const y = Math.floor(hovered / GRID) * CELL;
			ctx.strokeStyle = "#edba7d";
			ctx.lineWidth = 1.6;
			ctx.strokeRect(x + 1.5, y + 1.5, CELL - 3, CELL - 3);
		}
	}
	function drawCollisionMask(ctx, valves) {
		ctx.fillStyle = "#000";
		ctx.fillRect(0, 0, SIZE, SIZE);
		valves.forEach((_, index) => {
			drawHousingChannels(
				ctx,
				(index % GRID) * CELL,
				Math.floor(index / GRID) * CELL,
				CHANNEL_WIDTH,
				"#fff",
			);
		});
		valves.forEach((valve, index) => {
			const cx = (index % GRID) * CELL + CELL / 2;
			const cy = Math.floor(index / GRID) * CELL + CELL / 2;
			ctx.save();
			ctx.translate(cx, cy);
			ctx.beginPath();
			ctx.arc(0, 0, VALVE_RADIUS + 1.05, 0, Math.PI * 2);
			ctx.fillStyle = "#000";
			ctx.fill();
			ctx.rotate(valve.angle);
			ctx.beginPath();
			ctx.arc(0, 0, VALVE_RADIUS + 1.45, 0, Math.PI * 2);
			ctx.clip();
			drawPassages(ctx, valve, "#fff", true);
			ctx.restore();
		});
	}
	function isAirPixel(pixels, x, y) {
		const ix = Math.floor(x);
		const iy = Math.floor(y);
		if (ix < 0 || ix >= SIZE || iy < 0) return false;
		if (iy >= SIZE) return true;
		return pixels[(iy * SIZE + ix) * 4] > 155;
	}
	function canFit(pixels, x, y, radius) {
		if (!isAirPixel(pixels, x, y)) return false;
		const edge = radius + 0.28;
		for (const probe of PROBES) {
			if (!isAirPixel(pixels, x + probe.x * edge, y + probe.y * edge))
				return false;
		}
		return true;
	}
	function wallNormal(pixels, x, y, radius) {
		let nx = 0;
		let ny = 0;
		for (const probe of PROBES) {
			if (
				!isAirPixel(
					pixels,
					x + probe.x * (radius + 1),
					y + probe.y * (radius + 1),
				)
			) {
				nx -= probe.x;
				ny -= probe.y;
			}
		}
		const length = Math.hypot(nx, ny);
		return length > 0.01 ? { x: nx / length, y: ny / length } : { x: 0, y: -1 };
	}
	function moveBackIntoAir(particle, pixels) {
		if (canFit(pixels, particle.x, particle.y, particle.radius)) return true;
		for (let distance = 1.5; distance <= 22.5; distance += 1.5) {
			for (const probe of PROBES) {
				const x = particle.x + probe.x * distance;
				const y = particle.y + probe.y * distance;
				if (canFit(pixels, x, y, particle.radius)) {
					particle.x = x;
					particle.y = y;
					particle.vx *= 0.45;
					particle.vy *= 0.45;
					return true;
				}
			}
		}
		return false;
	}
	function spawnInCell(sim, index) {
		const cx = (index % GRID) * CELL + CELL / 2;
		const cy = Math.floor(index / GRID) * CELL + CELL / 2;
		for (let attempt = 0; attempt < 36; attempt++) {
			const radius = random(2.4, 3.1);
			const x = cx + random(-10.5, 10.5);
			const y = cy + random(-10.5, 10.5);
			if (Math.hypot(x - cx, y - cy) > CAVITY_RADIUS - radius - 0.7) continue;
			if (
				sim.particles.some(
					(other) =>
						Math.hypot(other.x - x, other.y - y) < other.radius + radius + 0.8,
				)
			)
				continue;
			sim.particles.push({
				x,
				y,
				vx: random(-9, 9),
				vy: random(-4, 5),
				radius,
				color:
					PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
			});
			return true;
		}
		return false;
	}
	function topChambers(valves) {
		return valves.flatMap((valve, index) =>
			index < GRID * 3 && isChamber(valve.kind) ? [index] : [],
		);
	}
	function addTopParticle(sim) {
		const candidates = topChambers(sim.valves);
		for (let attempt = 0; attempt < 18 && candidates.length; attempt++) {
			if (
				spawnInCell(
					sim,
					candidates[Math.floor(Math.random() * candidates.length)],
				)
			)
				return;
		}
	}
	function makeSimulation() {
		const sim = {
			valves: createValves(),
			particles: [],
			time: 0,
			spawnClock: 0,
		};
		const candidates = topChambers(sim.valves);
		for (let index = candidates.length - 1; index > 0; index--) {
			const swap = Math.floor(Math.random() * (index + 1));
			[candidates[index], candidates[swap]] = [
				candidates[swap],
				candidates[index],
			];
		}
		for (const index of candidates.slice(0, 12)) {
			const count = Math.floor(random(5, 9));
			for (let bead = 0; bead < count; bead++) spawnInCell(sim, index);
		}
		return sim;
	}
	function updateValves(sim, dt, speed) {
		for (const valve of sim.valves) {
			if (
				Math.abs(valve.targetAngle - valve.angle) < 1e-3 &&
				sim.time >= valve.nextTurn
			) {
				valve.targetAngle += (Math.random() < 0.5 ? -1 : 1) * QUARTER_TURN;
				valve.nextTurn = sim.time + random(1.4, 4.2);
			}
			const remaining = valve.targetAngle - valve.angle;
			valve.delta =
				Math.sign(remaining) *
				Math.min(Math.abs(remaining), valve.turnRate * dt * speed);
			valve.angle += valve.delta;
		}
	}
	function updateParticles(sim, pixels, dt) {
		for (let index = sim.particles.length - 1; index >= 0; index--) {
			const particle = sim.particles[index];
			const col = Math.floor(particle.x / CELL);
			const row = Math.floor(particle.y / CELL);
			if (col >= 0 && col < GRID && row >= 0 && row < GRID) {
				const valve = sim.valves[row * GRID + col];
				const cx = col * CELL + CELL / 2;
				const cy = row * CELL + CELL / 2;
				const lx = particle.x - cx;
				const ly = particle.y - cy;
				const distance = Math.hypot(lx, ly);
				const inRotor = distance < VALVE_RADIUS - 0.8;
				const inChamber = isChamber(valve.kind) && distance < CAVITY_RADIUS - 1;
				if (inRotor && !inChamber && valve.delta !== 0) {
					const cosine = Math.cos(valve.delta);
					const sine = Math.sin(valve.delta);
					particle.x = cx + lx * cosine - ly * sine;
					particle.y = cy + lx * sine + ly * cosine;
					const vx = particle.vx;
					particle.vx = vx * cosine - particle.vy * sine;
					particle.vy = vx * sine + particle.vy * cosine;
				}
			}
			if (!moveBackIntoAir(particle, pixels)) {
				sim.particles.splice(index, 1);
				continue;
			}
			const substep = dt / 2;
			for (let step = 0; step < 2; step++) {
				particle.vy = Math.min(165, particle.vy + 285 * substep);
				particle.vx *= 1 - 0.32 * substep;
				const nextX = particle.x + particle.vx * substep;
				const nextY = particle.y + particle.vy * substep;
				if (canFit(pixels, nextX, nextY, particle.radius)) {
					particle.x = nextX;
					particle.y = nextY;
					continue;
				}
				const normal = wallNormal(pixels, nextX, nextY, particle.radius);
				const towardWall = particle.vx * normal.x + particle.vy * normal.y;
				if (towardWall < 0) {
					particle.vx -= towardWall * normal.x * 1.19;
					particle.vy -= towardWall * normal.y * 1.19;
				}
				if (
					canFit(
						pixels,
						particle.x + particle.vx * substep,
						particle.y + particle.vy * substep,
						particle.radius,
					)
				) {
					particle.x += particle.vx * substep;
					particle.y += particle.vy * substep;
				} else if (
					canFit(
						pixels,
						particle.x + particle.vx * substep,
						particle.y,
						particle.radius,
					)
				) {
					particle.x += particle.vx * substep;
					particle.vy *= -0.16;
				} else if (
					canFit(
						pixels,
						particle.x,
						particle.y + particle.vy * substep,
						particle.radius,
					)
				) {
					particle.y += particle.vy * substep;
					particle.vx *= -0.16;
				} else {
					particle.vx *= -0.15;
					particle.vy *= -0.15;
				}
			}
			if (particle.y > SIZE + 9) sim.particles.splice(index, 1);
		}
		for (let index = 0; index < sim.particles.length; index++) {
			const first = sim.particles[index];
			for (
				let otherIndex = index + 1;
				otherIndex < sim.particles.length;
				otherIndex++
			) {
				const second = sim.particles[otherIndex];
				const dx = second.x - first.x;
				const dy = second.y - first.y;
				const minDistance = first.radius + second.radius + 0.25;
				if (Math.abs(dx) > minDistance || Math.abs(dy) > minDistance) continue;
				const distance = Math.hypot(dx, dy);
				if (distance >= minDistance || distance < 1e-3) continue;
				const nx = dx / distance;
				const ny = dy / distance;
				const shift = (minDistance - distance) * 0.5;
				if (
					canFit(
						pixels,
						first.x - nx * shift,
						first.y - ny * shift,
						first.radius,
					)
				) {
					first.x -= nx * shift;
					first.y -= ny * shift;
				}
				if (
					canFit(
						pixels,
						second.x + nx * shift,
						second.y + ny * shift,
						second.radius,
					)
				) {
					second.x += nx * shift;
					second.y += ny * shift;
				}
				const closingSpeed =
					(second.vx - first.vx) * nx + (second.vy - first.vy) * ny;
				if (closingSpeed < 0) {
					const impulse = -closingSpeed * 0.58;
					first.vx -= impulse * nx;
					first.vy -= impulse * ny;
					second.vx += impulse * nx;
					second.vy += impulse * ny;
				}
			}
		}
	}

	return {
		GRID,
		CELL,
		SIZE,
		VALVE_RADIUS,
		CHANNEL_WIDTH,
		CAVITY_RADIUS,
		WHITE_AIR,
		BLACK_AIR,
		QUARTER_TURN,
		random,
		drawVisible,
		drawCollisionMask,
		addTopParticle,
		makeSimulation,
		updateValves,
		updateParticles,
	};
})();
if (typeof module !== "undefined") module.exports = ValveSimulation;
