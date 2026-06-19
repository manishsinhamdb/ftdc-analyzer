import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Play, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";

// Original, self-contained endless-runner shown during the (~1–2 min) analyze wait.
// All art is simple shapes drawn on a canvas — no external/copyrighted assets, no storage.
// "Leafy", a rounded green sprite, hops over data-shard pillars. Space / ↑ / click to jump.

const W = 720;
const H = 240;
const GROUND = H - 40;
const GRAVITY = 0.62;
const JUMP_V = -11.5;

interface Pillar {
  x: number;
  w: number;
  h: number;
}

export function MiniGame({ ready, onGoToResults }: { ready: boolean; onGoToResults: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [score, setScore] = useState(0);
  const [over, setOver] = useState(false);
  const [keepPlaying, setKeepPlaying] = useState(false);

  // Mutable game state kept in a ref so the rAF loop never re-creates per render.
  const g = useRef({
    y: GROUND - 24,
    vy: 0,
    onGround: true,
    pillars: [] as Pillar[],
    spawn: 0,
    speed: 4.2,
    score: 0,
    over: false,
    raf: 0,
    last: 0,
    t: 0,
  });

  const reset = useCallback(() => {
    const s = g.current;
    s.y = GROUND - 24;
    s.vy = 0;
    s.onGround = true;
    s.pillars = [];
    s.spawn = 0;
    s.speed = 4.2;
    s.score = 0;
    s.over = false;
    s.t = 0;
    setScore(0);
    setOver(false);
  }, []);

  const jump = useCallback(() => {
    const s = g.current;
    if (s.over) {
      reset();
      return;
    }
    if (s.onGround) {
      s.vy = JUMP_V;
      s.onGround = false;
    }
  }, [reset]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp" || e.key === " " || e.key === "ArrowUp") {
        e.preventDefault();
        jump();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jump]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const RUNNER_X = 70;
    const SIZE = 26;

    const draw = (now: number) => {
      const s = g.current;
      const dt = s.last ? Math.min(2.5, (now - s.last) / 16.67) : 1;
      s.last = now;
      s.t += dt;

      if (!s.over) {
        // physics
        s.vy += GRAVITY * dt;
        s.y += s.vy * dt;
        if (s.y >= GROUND - SIZE) {
          s.y = GROUND - SIZE;
          s.vy = 0;
          s.onGround = true;
        }
        // spawn pillars
        s.spawn -= dt;
        if (s.spawn <= 0) {
          const h = 22 + Math.floor(Math.random() * 34);
          s.pillars.push({ x: W + 20, w: 14 + Math.floor(Math.random() * 12), h });
          s.spawn = 70 + Math.random() * 60 - Math.min(40, s.score / 6);
        }
        // move + cull + score
        s.speed = 4.2 + s.score / 220;
        for (const p of s.pillars) p.x -= s.speed * dt;
        s.pillars = s.pillars.filter((p) => p.x + p.w > -10);
        s.score += 0.25 * dt;
        setScore(Math.floor(s.score));

        // collision (rect vs rect, slightly forgiving)
        for (const p of s.pillars) {
          if (
            RUNNER_X + SIZE - 4 > p.x &&
            RUNNER_X + 4 < p.x + p.w &&
            s.y + SIZE - 3 > GROUND - p.h
          ) {
            s.over = true;
            setOver(true);
          }
        }
      }

      // ---- render ----
      ctx.clearRect(0, 0, W, H);
      // sky gradient
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, "#0B1726");
      sky.addColorStop(1, "#12243A");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);
      // parallax stars
      ctx.fillStyle = "#1E3450";
      for (let i = 0; i < 28; i++) {
        const sx = (i * 137 - s.t * 0.6) % W;
        ctx.fillRect((sx + W) % W, 20 + ((i * 53) % (GROUND - 50)), 2, 2);
      }
      // ground
      ctx.strokeStyle = "#3A5170";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, GROUND);
      ctx.lineTo(W, GROUND);
      ctx.stroke();
      ctx.fillStyle = "#16293F";
      for (let i = 0; i < W / 24 + 1; i++) {
        const gx = (i * 24 - (s.t * s.speed) % 24);
        ctx.fillRect(gx, GROUND + 4, 10, 2);
      }
      // pillars (data shards) — teal-blue blocks with a notch
      for (const p of s.pillars) {
        ctx.fillStyle = "#4DA6FF";
        ctx.fillRect(p.x, GROUND - p.h, p.w, p.h);
        ctx.fillStyle = "#0D1B2A";
        ctx.fillRect(p.x + 2, GROUND - p.h + 3, p.w - 4, 3);
      }
      // runner "Leafy" — green rounded body + eye + a little leaf
      const ry = s.y;
      ctx.fillStyle = "#00ED64";
      ctx.beginPath();
      ctx.roundRect(RUNNER_X, ry, SIZE, SIZE, 8);
      ctx.fill();
      ctx.fillStyle = "#0D1B2A"; // eye
      ctx.beginPath();
      ctx.arc(RUNNER_X + SIZE - 8, ry + 9, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#06231A"; // leaf
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(RUNNER_X + SIZE / 2, ry);
      ctx.lineTo(RUNNER_X + SIZE / 2 + 5, ry - 7);
      ctx.stroke();

      if (s.over) {
        ctx.fillStyle = "rgba(13,27,42,0.7)";
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#E6EDF3";
        ctx.font = "bold 18px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("crashed into a data shard", W / 2, H / 2 - 8);
        ctx.fillStyle = "#AEBFD2";
        ctx.font = "13px system-ui, sans-serif";
        ctx.fillText("press Space / click to retry", W / 2, H / 2 + 16);
        ctx.textAlign = "left";
      }

      s.raf = requestAnimationFrame(draw);
    };

    g.current.raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(g.current.raf);
  }, []);

  const showBanner = ready && !keepPlaying;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-6 backdrop-blur">
      <div className="w-full max-w-3xl space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {ready ? (
            <>
              <Trophy className="size-4 text-primary" /> Results ready
            </>
          ) : (
            <>
              <Loader2 className="size-4 animate-spin text-primary" /> Decoding FTDC — this takes ~1–2 min. Have a play.
            </>
          )}
          <span className="ml-auto font-mono text-xs text-foreground">score {score}</span>
        </div>

        <div className="overflow-hidden rounded-lg border border-border shadow-lg">
          <canvas
            ref={canvasRef}
            width={W}
            height={H}
            onClick={jump}
            className="block w-full cursor-pointer"
            style={{ aspectRatio: `${W} / ${H}` }}
          />
        </div>

        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Space / ↑ / click to jump{over ? " · press to retry" : ""}</span>
        </div>

        {showBanner && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary/10 px-4 py-3">
            <Trophy className="size-4 text-primary" />
            <span className="text-sm font-medium">Your analysis is ready.</span>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setKeepPlaying(true)}>
                Keep playing
              </Button>
              <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={onGoToResults}>
                <Play className="size-4" /> Go to results
              </Button>
            </div>
          </div>
        )}
        {ready && keepPlaying && (
          <div className="text-center">
            <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={onGoToResults}>
              <Play className="size-4" /> Go to results
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
