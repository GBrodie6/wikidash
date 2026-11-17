// A short burst of confetti for wins. Skipped for people who prefer reduced motion.

const COLORS = ["#1d3fd0", "#ffd23f", "#14130f", "#e4472b", "#f3efe5"];
let canvas = null;
let ctx2d = null;
let parts = [];
let raf = 0;

function spawn(x, y, angle, spread, n, speed) {
  for (let i = 0; i < n; i++) {
    const a = angle + (Math.random() - 0.5) * spread;
    const v = speed * (0.55 + Math.random() * 0.65);
    parts.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      w: 6 + Math.random() * 7, h: 4 + Math.random() * 6,
      rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
      color: COLORS[Math.floor(Math.random() * COLORS.length)], age: 0,
    });
  }
}

function frame() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  ctx2d.clearRect(0, 0, W, H);
  parts = parts.filter((p) => p.y < H + 30 && p.age < 260);
  for (const p of parts) {
    p.vy += 0.16;
    p.vx *= 0.992;
    p.vy *= 0.992;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    p.age += 1;
    ctx2d.save();
    ctx2d.translate(p.x, p.y);
    ctx2d.rotate(p.rot);
    ctx2d.globalAlpha = Math.min(1, (260 - p.age) / 50);
    ctx2d.fillStyle = p.color;
    ctx2d.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx2d.strokeStyle = "#14130f";
    ctx2d.lineWidth = 1;
    ctx2d.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx2d.restore();
  }
  if (parts.length) raf = requestAnimationFrame(frame);
  else {
    canvas.remove();
    canvas = null;
    raf = 0;
  }
}

export function confetti({ count = 110 } = {}) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "confetti";
    canvas.setAttribute("aria-hidden", "true");
    document.body.append(canvas);
    ctx2d = canvas.getContext("2d");
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  const side = Math.round(count * 0.35);
  spawn(W * 0.12, H * 0.95, -Math.PI * 0.38, 0.9, side, 17);
  spawn(W * 0.88, H * 0.95, -Math.PI * 0.62, 0.9, side, 17);
  spawn(W * 0.5, H * 0.3, -Math.PI / 2, Math.PI * 1.6, Math.round(count * 0.3), 7);
  if (!raf) raf = requestAnimationFrame(frame);
}
