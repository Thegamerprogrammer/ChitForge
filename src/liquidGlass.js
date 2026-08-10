const cache = new Map();

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const smootherstep = (x) => x * x * x * (x * (x * 6 - 15) + 10);
const mix = (a, b, t) => a * (1 - t) + b * t;

export function surfaceHeight(x, surface = 'convex-squircle') {
  const n = clamp(x, 0, 1);
  const convexCircle = Math.sqrt(Math.max(0, 1 - (1 - n) ** 2));
  const convexSquircle = (Math.max(0, 1 - (1 - n) ** 4)) ** 0.25;
  if (surface === 'convex') return convexCircle;
  if (surface === 'concave') return 1 - convexSquircle;
  if (surface === 'lip') return mix(convexSquircle, 1 - convexSquircle, smootherstep(n));
  return convexSquircle;
}

function normalAt(distance, surface) {
  const delta = 0.001;
  const previous = surfaceHeight(distance - delta, surface);
  const next = surfaceHeight(distance + delta, surface);
  const derivative = (next - previous) / (2 * delta);
  const length = Math.hypot(-derivative, 1) || 1;
  return { x: -derivative / length, y: 1 / length };
}

function refract(incoming, normal, refractiveIndex = 1.5) {
  const n1 = 1;
  const eta = n1 / refractiveIndex;
  const dot = -(incoming.x * normal.x + incoming.y * normal.y);
  const k = 1 - eta * eta * (1 - dot * dot);
  if (k < 0) return { x: incoming.x, y: incoming.y };
  return {
    x: eta * incoming.x + (eta * dot - Math.sqrt(k)) * normal.x,
    y: eta * incoming.y + (eta * dot - Math.sqrt(k)) * normal.y,
  };
}

export function createLiquidGlassMap({
  width = 320,
  height = 160,
  bezelWidth = 32,
  glassThickness = 36,
  refractiveIndex = 1.5,
  surface = 'convex-squircle',
  lightAngle = -60,
  specularSaturation = 6,
} = {}) {
  const key = JSON.stringify({ width, height, bezelWidth, glassThickness, refractiveIndex, surface, lightAngle, specularSaturation });
  if (cache.has(key)) return cache.get(key);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const maxRadius = Math.min(width, height) / 2;
  const radius = Math.min(maxRadius, Math.max(12, bezelWidth * 1.65));
  const bezel = Math.max(1, Math.min(bezelWidth, radius));
  const light = { x: Math.cos((lightAngle * Math.PI) / 180), y: Math.sin((lightAngle * Math.PI) / 180) };
  let maxDisplacement = 1;
  const vectors = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cx = Math.abs(x - width / 2) - (width / 2 - radius);
      const cy = Math.abs(y - height / 2) - (height / 2 - radius);
      const ox = Math.max(cx, 0);
      const oy = Math.max(cy, 0);
      const outsideCorner = Math.hypot(ox, oy);
      const inside = Math.min(Math.max(cx, cy), 0) + outsideCorner;
      const distanceFromEdge = clamp(radius - inside, 0, bezel);
      const bezelProgress = clamp(distanceFromEdge / bezel, 0, 1);
      let axisX = 0;
      let axisY = 0;
      if (cx > cy && cx > 0) axisX = Math.sign(x - width / 2);
      else if (cy > 0) axisY = Math.sign(y - height / 2);
      else if (outsideCorner > 0) { axisX = ox / outsideCorner * Math.sign(x - width / 2); axisY = oy / outsideCorner * Math.sign(y - height / 2); }
      else if (Math.abs(cx) > Math.abs(cy)) axisX = Math.sign(x - width / 2);
      else axisY = Math.sign(y - height / 2);

      const normal = normalAt(bezelProgress, surface);
      const directionNormal = { x: axisX * Math.abs(normal.x), y: axisY * Math.abs(normal.x) };
      const refracted = refract({ x: 0, y: 1 }, { x: directionNormal.x, y: normal.y }, refractiveIndex);
      const displacement = (1 - bezelProgress) * glassThickness * 0.26 + Math.abs(refracted.x) * glassThickness;
      const eased = surface === 'lip' ? Math.sin(bezelProgress * Math.PI) : 1 - smootherstep(bezelProgress);
      const dx = -axisX * displacement * eased;
      const dy = -axisY * displacement * eased;
      const specular = clamp((directionNormal.x * light.x + directionNormal.y * light.y) * specularSaturation, 0, 1) * (1 - bezelProgress);
      maxDisplacement = Math.max(maxDisplacement, Math.abs(dx), Math.abs(dy));
      vectors.push({ dx, dy, specular });
    }
  }

  vectors.forEach(({ dx, dy, specular }, i) => {
    const p = i * 4;
    data[p] = clamp(Math.round(128 + (dx / maxDisplacement) * 127), 0, 255);
    data[p + 1] = clamp(Math.round(128 + (dy / maxDisplacement) * 127), 0, 255);
    data[p + 2] = clamp(Math.round(128 + specular * 127), 0, 255);
    data[p + 3] = 255;
  });
  ctx.putImageData(image, 0, 0);
  const result = { href: canvas.toDataURL('image/png'), scale: Math.round(maxDisplacement * 10) / 10, width, height };
  cache.set(key, result);
  return result;
}
