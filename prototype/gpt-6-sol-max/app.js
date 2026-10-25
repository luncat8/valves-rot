(() => {
	"use strict";
	const $ = (id) => document.getElementById(id);
	const V = ValveSimulation;
	const canvas = $("c");
	const ctx = canvas.getContext("2d");
	const mask = document.createElement("canvas");
	mask.width = mask.height = V.SIZE;
	const maskCtx = mask.getContext("2d", { willReadFrequently: true });
	let sim = V.makeSimulation();
	let paused = false;
	let speed = 1;
	let hovered = -1;
	let previous = performance.now();
	let statClock = 0;
	function resize() {
		const dpr = Math.min(devicePixelRatio || 1, 2);
		canvas.width = canvas.height = Math.round(V.SIZE * dpr);
		ctx.setTransform(canvas.width / V.SIZE, 0, 0, canvas.height / V.SIZE, 0, 0);
	}
	function cellAt(event) {
		const b = canvas.getBoundingClientRect();
		return (
			Math.floor(((event.clientY - b.top) / b.height) * V.GRID) * V.GRID +
			Math.floor(((event.clientX - b.left) / b.width) * V.GRID)
		);
	}
	function rotate() {
		if (hovered < 0 || hovered >= 100) return;
		const valve = sim.valves[hovered];
		valve.targetAngle += V.QUARTER_TURN;
		if (paused) valve.angle = valve.targetAngle;
		valve.nextTurn = sim.time + V.random(2.5, 4.5);
	}
	canvas.onpointermove = (event) => {
		hovered = cellAt(event);
	};
	canvas.onpointerleave = canvas.onblur = () => {
		hovered = -1;
	};
	canvas.onclick = (event) => {
		hovered = cellAt(event);
		rotate();
	};
	canvas.onkeydown = (event) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			if (hovered < 0) hovered = 44;
			rotate();
			return;
		}
		if (!event.key.startsWith("Arrow")) return;
		event.preventDefault();
		if (hovered < 0) hovered = 44;
		let row = Math.floor(hovered / 10),
			col = hovered % 10;
		if (event.key === "ArrowUp") row--;
		if (event.key === "ArrowDown") row++;
		if (event.key === "ArrowLeft") col--;
		if (event.key === "ArrowRight") col++;
		hovered =
			Math.max(0, Math.min(9, row)) * 10 + Math.max(0, Math.min(9, col));
	};
	canvas.setAttribute(
		"aria-label",
		"10 by 10 valve grid. Click, or use arrow keys and Enter to rotate a valve.",
	);
	$("pause").onclick = () => {
		paused = !paused;
		$("pause").textContent = paused ? "Resume" : "Pause";
	};
	$("speed").oninput = () => {
		speed = +$("speed").value;
		$("speed-value").value = speed;
	};
	$("reset").onclick = () => {
		sim = V.makeSimulation();
	};
	$("pour").onclick = () => {
		for (let i = 0; i < 24; i++) V.addTopParticle(sim);
	};
	window.addEventListener("resize", resize);
	resize();
	function frame(now) {
		const dt = Math.min(0.035, (now - previous) / 1000);
		previous = now;
		if (!paused) {
			sim.time += dt * speed;
			V.updateValves(sim, dt, speed);
			V.drawCollisionMask(maskCtx, sim.valves);
			V.updateParticles(
				sim,
				maskCtx.getImageData(0, 0, V.SIZE, V.SIZE).data,
				dt,
			);
			sim.spawnClock += dt;
			if (sim.spawnClock > 0.85 && sim.particles.length < 120) {
				V.addTopParticle(sim);
				sim.spawnClock = 0;
			}
		}
		V.drawVisible(ctx, sim, $("air").checked ? "#000000" : "#ffffff", hovered);
		statClock += dt;
		if (statClock > 0.5) {
			$("stats").textContent = sim.particles.length;
			statClock = 0;
		}
		requestAnimationFrame(frame);
	}
	requestAnimationFrame(frame);
})();
