import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  addTopParticle, BLACK_AIR, CELL, drawCollisionMask, drawVisible, GRID, makeSimulation,
  QUARTER_TURN, random, SIZE, updateParticles, updateValves, WHITE_AIR, type Simulation,
} from "./simulation";

type Settings = { blackAir: boolean; playing: boolean; speed: number };

function ValveSample({ hollow, air }: { hollow: boolean; air: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className="sample-svg">
      <rect width="64" height="64" fill="#777d7b" />
      <path d="M32 0v64M0 32h64" stroke="#45504f" strokeWidth="13" />
      <path d="M32 0v64M0 32h64" stroke={air} strokeWidth="9" />
      <circle cx="32" cy="32" r="26" fill="#a5aaa6" stroke="#354241" strokeWidth="2" />
      {hollow ? (
        <>
          <path d="M32 5v54M32 32h27" stroke="#45504f" strokeWidth="13" />
          <circle cx="32" cy="32" r="15" fill="#45504f" />
          <path d="M32 5v54M32 32h27" stroke={air} strokeWidth="9" />
          <circle cx="32" cy="32" r="12.5" fill={air} />
        </>
      ) : (
        <>
          <path d="M32 5v14Q32 32 45 32h14" fill="none" stroke="#45504f" strokeWidth="13" />
          <path d="M32 5v14Q32 32 45 32h14" fill="none" stroke={air} strokeWidth="9" />
        </>
      )}
    </svg>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Simulation | null>(null);
  const hoveredRef = useRef(-1);
  const settingsRef = useRef<Settings>({ blackAir: false, playing: true, speed: 1 });
  const [blackAir, setBlackAir] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [particleCount, setParticleCount] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(SIZE * dpr);
    canvas.height = Math.round(SIZE * dpr);
    ctx.setTransform(canvas.width / SIZE, 0, 0, canvas.height / SIZE, 0, 0);

    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = SIZE;
    maskCanvas.height = SIZE;
    const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
    if (!maskCtx) return;

    simRef.current = makeSimulation();
    setParticleCount(simRef.current.particles.length);
    let frame = 0;
    let previous = performance.now();
    let lastCountUpdate = previous;

    const animate = (now: number) => {
      const dt = Math.min((now - previous) / 1000, 0.035);
      previous = now;
      const sim = simRef.current;
      const settings = settingsRef.current;

      if (sim) {
        if (settings.playing) {
          sim.time += dt * settings.speed;
          updateValves(sim, dt, settings.speed);
        } else {
          sim.valves.forEach((valve) => { valve.delta = 0; });
        }

        drawCollisionMask(maskCtx, sim.valves);
        if (settings.playing) {
          const pixels = maskCtx.getImageData(0, 0, SIZE, SIZE).data;
          updateParticles(sim, pixels, dt);
          sim.spawnClock += dt;
          if (sim.spawnClock > 0.85 && sim.particles.length < 120) {
            addTopParticle(sim);
            sim.spawnClock = 0;
          }
        }
        drawVisible(ctx, sim, settings.blackAir ? BLACK_AIR : WHITE_AIR, hoveredRef.current);

        if (now - lastCountUpdate > 650) {
          setParticleCount(sim.particles.length);
          lastCountUpdate = now;
        }
      }
      frame = requestAnimationFrame(animate);
    };

    frame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frame);
      simRef.current = null;
    };
  }, []);

  const cellAtPoint = (clientX: number, clientY: number) => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return -1;
    const x = ((clientX - bounds.left) / bounds.width) * SIZE;
    const y = ((clientY - bounds.top) / bounds.height) * SIZE;
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return -1;
    return Math.floor(y / CELL) * GRID + Math.floor(x / CELL);
  };

  const rotateCell = (index: number) => {
    const sim = simRef.current;
    if (!sim || index < 0) return;
    const valve = sim.valves[index];
    if (settingsRef.current.playing) {
      valve.targetAngle += QUARTER_TURN;
    } else {
      valve.angle += QUARTER_TURN;
      valve.targetAngle = valve.angle;
    }
    valve.nextTurn = sim.time + random(2.5, 4.5);
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    hoveredRef.current = cellAtPoint(event.clientX, event.clientY);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const directions: Record<string, [number, number]> = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
    };
    if (event.key in directions) {
      event.preventDefault();
      const current = hoveredRef.current < 0 ? 44 : hoveredRef.current;
      const [rowChange, colChange] = directions[event.key];
      const row = Math.max(0, Math.min(9, Math.floor(current / GRID) + rowChange));
      const col = Math.max(0, Math.min(9, (current % GRID) + colChange));
      hoveredRef.current = row * GRID + col;
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      rotateCell(hoveredRef.current < 0 ? 44 : hoveredRef.current);
    }
  };

  const togglePlayback = () => {
    const next = !playing;
    settingsRef.current.playing = next;
    setPlaying(next);
  };

  const shuffleField = () => {
    simRef.current = makeSimulation();
    setParticleCount(simRef.current.particles.length);
  };

  const releaseParticles = () => {
    const sim = simRef.current;
    if (!sim) return;
    for (let index = 0; index < 24; index++) addTopParticle(sim);
    setParticleCount(sim.particles.length);
  };

  const airColor = blackAir ? BLACK_AIR : WHITE_AIR;

  return (
    <div className="page-shell">
      <header className="page-header">
        <div className="identity">
          <div className="eyebrow"><span className="identity-symbol" aria-hidden="true"><span /></span> AN INTERACTIVE KINETIC STUDY / 001</div>
          <h1>Valve<span className="title-slash">/</span>Field<span className="title-period">.</span></h1>
          <p>One hundred turning valves. A thousand possible ways down.</p>
        </div>

        <div className="header-controls" aria-label="Simulation controls">
          <label className="air-control">
            <span className="control-label">AIR COLOR</span>
            <span className="air-options">
              <span className={!blackAir ? "option-active" : ""}>White</span>
              <span className="air-switch">
                <input
                  type="checkbox"
                  checked={blackAir}
                  onChange={(event) => {
                    settingsRef.current.blackAir = event.target.checked;
                    setBlackAir(event.target.checked);
                  }}
                  aria-label="Use black air instead of white air"
                />
                <span className="switch-track"><span className="switch-knob" /></span>
              </span>
              <span className={blackAir ? "option-active" : ""}>Black</span>
            </span>
          </label>
          <span className="control-divider" aria-hidden="true" />
          <button className="control-button" type="button" onClick={togglePlayback}>
            {playing ? (
              <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="4" width="3" height="12" rx="0.6" /><rect x="12" y="4" width="3" height="12" rx="0.6" /></svg>
            ) : (
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.8v12.4L16 10 6 3.8Z" /></svg>
            )}
            {playing ? "Pause" : "Resume"}
          </button>
          <button className="control-button reset-button" type="button" onClick={shuffleField}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16.5 9A6.5 6.5 0 1 0 17 12" /><path d="M16.5 4.5V9H12" /></svg>
            New field
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="machine-frame" aria-label="Interactive valve field">
          <div className="machine-top"><span><i className="frame-square" /> VF / ROTARY MATRIX</span><span>10 x 10 ARRAY</span></div>
          <canvas
            ref={canvasRef}
            className="valve-canvas"
            width={SIZE}
            height={SIZE}
            onPointerMove={handlePointerMove}
            onPointerLeave={() => { hoveredRef.current = -1; }}
            onClick={(event) => rotateCell(cellAtPoint(event.clientX, event.clientY))}
            onKeyDown={handleKeyDown}
            onBlur={() => { hoveredRef.current = -1; }}
            tabIndex={0}
            role="button"
            aria-label="Interactive 10 by 10 valve grid. Click a valve, or use arrow keys and Enter to rotate one."
          />
          <div className="machine-bottom">
            <span className="machine-status"><i className={playing ? "status-dot" : "status-dot is-paused"} /> {playing ? "SYSTEM IN MOTION" : "SYSTEM PAUSED"}</span>
            <span>{particleCount} PARTICLES IN FIELD</span>
          </div>
        </section>

        <aside className="field-guide">
          <div className="guide-index"><span>FIELD NOTES</span><span>01 / 03</span></div>
          <h2>Follow the fall.</h2>
          <p className="guide-intro">Every gray square is a fixed, four-way housing. Its circular valve turns independently, changing where the colored particles can go.</p>

          <div className="valve-key">
            <div className="key-heading">INSIDE THE VALVES <span>SECTION VIEW</span></div>
            <div className="key-item">
              <ValveSample hollow={false} air={airColor} />
              <div><strong>Solid core</strong><span>Only a connecting tube is cut through the metal.</span></div>
            </div>
            <div className="key-item">
              <ValveSample hollow air={airColor} />
              <div><strong>Hollow chamber</strong><span>An open cavity with one to four outlets.</span></div>
            </div>
          </div>

          <div className="guide-actions">
            <div className="tempo-heading"><label htmlFor="tempo">ROTATION TEMPO</label><span>{speed.toFixed(1)}x</span></div>
            <input
              id="tempo"
              className="tempo-range"
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={speed}
              onChange={(event) => {
                const next = Number(event.target.value);
                settingsRef.current.speed = next;
                setSpeed(next);
              }}
              style={{ background: `linear-gradient(to right, #d87556 ${((speed - 0.5) / 1.5) * 100}%, #c9ceca ${((speed - 0.5) / 1.5) * 100}%)` }}
            />
            <button className="release-button" type="button" onClick={releaseParticles}>
              <span>Release more particles</span>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3v13M5.5 11.5 10 16l4.5-4.5" /></svg>
            </button>
            <p className="interaction-hint">Click any valve to give it a quarter turn.</p>
          </div>
        </aside>
      </main>

      <footer className="page-footer"><span>VALVE / FIELD</span><span>AN EXPERIMENT IN MOTION, MATTER &amp; OPEN PATHS</span></footer>
    </div>
  );
}