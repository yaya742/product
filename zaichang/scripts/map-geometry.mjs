/** Geographic predicates for source validation. They never create routing edges. */
export function ringContains(p, ring) {
  let yes = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0])
      yes = !yes;
  }
  return yes;
}
export function contains(p, g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.some((rings) => ringContains(p, rings[0]) && !rings.slice(1).some((r) => ringContains(p, r)));
}
const cross = (x, y, u, v) => x * v - y * u;
function boundary(p, g) {
  const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polygons.some((rings) =>
    rings.some((ring) =>
      ring.slice(1).some((b, i) => {
        const a = ring[i],
          dx = b[0] - a[0],
          dy = b[1] - a[1],
          len = dx * dx + dy * dy;
        if (!len) return false;
        const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len;
        return t >= 0 && t <= 1 && Math.abs(cross(p[0] - a[0], p[1] - a[1], dx, dy)) / Math.sqrt(len) < 1e-11;
      }),
    ),
  );
}
/** Split a segment at every boundary intersection, then test each open interval.
 * A fixed sampling step could miss a thin river; this test cannot skip one.
 * Inner rings remain dry holes. A segment precisely on a bank is not in water.
 */
export function crossesInterior(a, b, g) {
  const rx = b[0] - a[0],
    ry = b[1] - a[1],
    times = [0, 1];
  const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for (const rings of polygons)
    for (const ring of rings)
      for (let i = 1; i < ring.length; i++) {
        const c = ring[i - 1],
          d = ring[i],
          sx = d[0] - c[0],
          sy = d[1] - c[1],
          denom = cross(rx, ry, sx, sy);
        if (Math.abs(denom) < 1e-22) continue;
        const qx = c[0] - a[0],
          qy = c[1] - a[1],
          t = cross(qx, qy, sx, sy) / denom,
          u = cross(qx, qy, rx, ry) / denom;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) times.push(t);
      }
  times.sort((x, y) => x - y);
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] < 1e-12) continue;
    const t = (times[i] + times[i - 1]) / 2,
      p = [a[0] + rx * t, a[1] + ry * t];
    if (contains(p, g) && !boundary(p, g)) return true;
  }
  return false;
}
