(() => {
	"use strict";
	const $ = (id) => document.getElementById(id);
	const {
		SIZE,
		createWorld,
		setParticleCount,
		dropAll,
		stepValves,
		stepParticles,
	} = ValveEngine;
	const canvas = $("c");
	const ctx = canvas.getContext("2d");
	let world = createWorld();
	let scene;
	let paused = false;
	let speed = 1;
	let previous = performance.now();
	let statClock = 0;
	function rebuild() {
		const dpr = Math.min(devicePixelRatio || 1, 2);
		canvas.width = SIZE * dpr;
		canvas.height = SIZE * dpr;
		ctx.setTransform(canvas.width / SIZE, 0, 0, canvas.height / SIZE, 0, 0);
		scene = ValveRenderer.buildScene(
			world,
			$("air").checked ? "#000000" : "#ffffff",
			dpr,
		);
	}
	$("air").onchange = rebuild;
	$("pause").onclick = () => {
		paused = !paused;
		$("pause").textContent = paused ? "Resume" : "Pause";
	};
	$("speed").oninput = () => {
		speed = +$("speed").value;
		$("speed-value").value = speed;
	};
	$("reset").onclick = () => {
		world = createWorld();
		setParticleCount(world, 120);
		rebuild();
	};
	$("pour").onclick = () => dropAll(world);
	window.addEventListener("resize", rebuild);
	setParticleCount(world, 120);
	rebuild();
	function frame(now) {
		const dt = Math.min(0.032, (now - previous) / 1000);
		previous = now;
		if (!paused) {
			stepValves(world, dt * speed);
			// Wall velocity is measured in real seconds, not rotation-scaled time.
			for (const valve of world.valves) valve.omega *= speed;
			stepParticles(world, dt);
		}
		ValveRenderer.renderScene(ctx, world, scene);
		statClock += dt;
		if (statClock > 0.5) {
			$("stats").textContent = world.particles.length;
			statClock = 0;
		}
		requestAnimationFrame(frame);
	}
	requestAnimationFrame(frame);
})();
