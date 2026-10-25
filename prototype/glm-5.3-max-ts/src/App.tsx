import { useCallback, useEffect, useRef, useState } from "react";
import {
  SIZE,
  createWorld,
  dropAll,
  setParticleCount,
  stepParticles,
  stepValves,
  type World,
} from "./engine";
import { buildScene, renderScene, type Scene } from "./render";

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <label className="flex min-w-[168px] flex-1 flex-col gap-1">
      <span className="flex items-baseline justify-between text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
        {label}
        <span className="font-mono text-[11px] tracking-normal text-zinc-200">
          {value}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-amber-400
                   [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5
                   [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
                   [&::-webkit-slider-thumb]:bg-amber-400
                   [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_rgba(0,0,0,0.6)]"
      />
    </label>
  );
}

function Btn({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] transition
        ${
          active
            ? "border-amber-400/60 bg-amber-400/15 text-amber-200"
            : "border-zinc-700 bg-zinc-800/70 text-zinc-300 hover:border-zinc-500 hover:text-white"
        }`}
    >
      {children}
    </button>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldRef = useRef<World | null>(null);
  if (!worldRef.current) worldRef.current = createWorld();
  const sceneRef = useRef<Scene | null>(null);

  const [airLight, setAirLight] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [count, setCount] = useState(120);
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState({ moving: 0, total: 0 });

  const airRef = useRef(airLight);
  const speedRef = useRef(speed);
  const pausedRef = useRef(paused);
  airRef.current = airLight;
  speedRef.current = speed;
  pausedRef.current = paused;

  const rebuild = useCallback(() => {
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = Math.round(SIZE * dpr);
      canvas.height = Math.round(SIZE * dpr);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
      }
    }
    sceneRef.current = buildScene(
      worldRef.current!,
      airRef.current ? "#ffffff" : "#000000",
      dpr,
    );
  }, []);

  /* canvas setup + main loop */
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    let raf = 0;
    let last = performance.now();
    let statTimer = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      const w = worldRef.current!;
      if (!sceneRef.current) rebuild();
      if (!pausedRef.current && dt > 0) {
        stepValves(w, dt * speedRef.current);
        stepParticles(w, dt);
      }
      if (sceneRef.current) renderScene(ctx, w, sceneRef.current);

      statTimer += dt;
      if (statTimer > 0.25) {
        statTimer = 0;
        let moving = 0;
        for (const p of w.particles)
          if (p.vx * p.vx + p.vy * p.vy > 900) moving++;
        setStats((s) =>
          s.moving === moving && s.total === w.particles.length
            ? s
            : { moving, total: w.particles.length },
        );
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebuild]);

  /* air colour (black / white) rebuilds the cached layers */
  useEffect(() => {
    rebuild();
  }, [airLight, rebuild]);

  /* particle population */
  useEffect(() => {
    setParticleCount(worldRef.current!, count);
  }, [count]);

  /* crisp on zoom / dpi change */
  useEffect(() => {
    const onResize = () => rebuild();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [rebuild]);

  const newLayout = () => {
    worldRef.current = createWorld();
    setParticleCount(worldRef.current!, count);
    rebuild();
  };

  return (
    <div className="min-h-screen bg-zinc-950 bg-[radial-gradient(ellipse_at_top,#1f2530_0%,#0a0b0e_70%)] text-zinc-200">
      {/* ---------------- top bar ---------------- */}
      <header className="sticky top-0 z-20 border-b border-zinc-800/80 bg-zinc-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <div className="mr-auto">
            <h1 className="text-[13px] font-bold uppercase tracking-[0.28em] text-zinc-100">
              Rotary Valve Matrix
            </h1>
            <p className="text-[10.5px] tracking-wide text-zinc-500">
              10 × 10 housings · rotating plugs · granular flow
            </p>
          </div>

          {/* the air colour switch — one colour for every cavity */}
          <label className="flex cursor-pointer select-none items-center gap-2.5 rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-2">
            <input
              type="checkbox"
              checked={airLight}
              onChange={(e) => setAirLight(e.target.checked)}
              className="peer sr-only"
            />
            <span
              className="flex h-4 w-4 items-center justify-center rounded-[3px] border-2
                         border-zinc-500 bg-zinc-800 text-amber-300
                         peer-checked:border-amber-400 peer-checked:bg-amber-400/25"
            >
              <svg
                viewBox="0 0 12 12"
                className={`h-3 w-3 transition ${
                  airLight ? "opacity-100" : "opacity-0"
                }`}
              >
                <path
                  d="M2 6.4 4.8 9 10 3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
              Air
            </span>
            <span className="flex overflow-hidden rounded border border-zinc-700 text-[10px] font-bold uppercase tracking-wider">
              <span
                className={`px-2 py-0.5 ${
                  airLight
                    ? "bg-white text-zinc-900"
                    : "bg-zinc-800 text-zinc-500"
                }`}
              >
                White
              </span>
              <span
                className={`px-2 py-0.5 ${
                  !airLight
                    ? "bg-black text-white"
                    : "bg-zinc-800 text-zinc-500"
                }`}
              >
                Black
              </span>
            </span>
          </label>

          <div className="flex items-center gap-2">
            <Btn onClick={() => setPaused((p) => !p)} active={paused}>
              {paused ? "Run" : "Pause"}
            </Btn>
            <Btn onClick={() => dropAll(worldRef.current!)}>Pour</Btn>
            <Btn onClick={newLayout}>Rebuild</Btn>
          </div>
        </div>

        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-8 gap-y-3 border-t border-zinc-800/60 px-4 py-2.5">
          <Slider
            label="Valve speed"
            value={speed}
            min={0}
            max={3}
            step={0.1}
            suffix="×"
            onChange={setSpeed}
          />
          <Slider
            label="Particles"
            value={count}
            min={0}
            max={200}
            step={5}
            onChange={setCount}
          />
          <div className="ml-auto flex items-center gap-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            <span>
              Falling{" "}
              <b className="font-mono text-sm tracking-normal text-amber-300">
                {stats.moving}
              </b>
            </span>
            <span>
              Total{" "}
              <b className="font-mono text-sm tracking-normal text-zinc-300">
                {stats.total}
              </b>
            </span>
          </div>
        </div>
      </header>

      {/* ---------------- grid ---------------- */}
      <main className="mx-auto flex max-w-[1180px] flex-col items-center gap-5 px-4 py-6">
        <div className="relative w-full max-w-[min(94vw,76vh)]">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 shadow-[0_30px_60px_-20px_rgba(0,0,0,0.9)]">
            <canvas
              ref={canvasRef}
              className="block h-auto w-full rounded-lg"
              style={{ aspectRatio: "1 / 1" }}
            />
          </div>
        </div>

        {/* ---------------- legend ---------------- */}
        <div className="grid w-full max-w-[min(94vw,76vh)] grid-cols-2 gap-2 sm:grid-cols-3">
          {[
            {
              t: "Solid plug",
              d: "Metal all the way through — only a tube is drilled in it.",
              c: "bg-zinc-600",
            },
            {
              t: "Hollow plug",
              d: "Empty cavity inside (ball / flask) with 1–4 outlets to the rim.",
              c: "bg-zinc-400",
            },
            {
              t: "Housing",
              d: "Medium-grey block, four milled channels, same width as the tubes.",
              c: "bg-zinc-500",
            },
          ].map((x) => (
            <div
              key={x.t}
              className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
            >
              <div className="mb-1 flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${x.c}`} />
                <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-200">
                  {x.t}
                </span>
              </div>
              <p className="text-[11px] leading-snug text-zinc-500">{x.d}</p>
            </div>
          ))}
        </div>

        <p className="max-w-[min(94vw,76vh)] text-center text-[11px] leading-relaxed text-zinc-600">
          Every part is drawn in cross-section: a dark cut outline, the material
          thickness of the wall, then the opening. The grains are dropped into
          the top of the matrix, tumble through the milled channels and are
          carried around by the plugs as they turn.
        </p>
      </main>
    </div>
  );
}
