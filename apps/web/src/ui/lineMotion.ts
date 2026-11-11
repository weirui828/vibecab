// The physics behind the line: a string that carries waves, a ride that eases out of one station and brakes into
// the next, and a cab that swings under its grips. Pure numbers; the components draw them.

/** A stretched string as a row of points: `u` is how far each is from rest, `v` how fast it moves. Ends are fixed. */
export interface StringLine {
  n: number;
  u: Float32Array;
  v: Float32Array;
}

export function makeString(n: number): StringLine {
  const size = Math.max(4, Math.round(n));
  return { n: size, u: new Float32Array(size), v: new Float32Array(size) };
}

/** One frame of the wave: three small steps, losing a little energy in each, so a pluck rings for a few seconds. */
export function stepString(s: StringLine, steps = 3, keep = 0.9955): void {
  const { u, v, n } = s;
  for (let step = 0; step < steps; step++) {
    for (let j = 1; j < n - 1; j++)
      v[j] = ((v[j] ?? 0) + 0.25 * ((u[j - 1] ?? 0) + (u[j + 1] ?? 0) - 2 * (u[j] ?? 0))) * keep;
    for (let j = 1; j < n - 1; j++) u[j] = (u[j] ?? 0) + (v[j] ?? 0);
  }
}

/** Pulls the string aside around `t` (0 at one end, 1 at the other) and lets go. */
export function pluck(s: StringLine, t: number, amount: number, width = 2.6): void {
  const centre = t * (s.n - 1);
  for (let j = 1; j < s.n - 1; j++) s.u[j] = (s.u[j] ?? 0) + amount * Math.exp(-(((j - centre) / width) ** 2));
}

/** How far the string is from rest at `t`, between its points. */
export function waveAt(s: StringLine, t: number): number {
  const f = Math.min(Math.max(t, 0), 1) * (s.n - 1),
    j = Math.min(Math.floor(f), s.n - 2),
    a = s.u[j] ?? 0,
    b = s.u[j + 1] ?? 0;
  return a + (b - a) * (f - j);
}

/** Is the string at rest (nothing worth drawing again)? */
export function isStill(s: StringLine, within = 0.02): boolean {
  for (let j = 1; j < s.n - 1; j++) if (Math.abs(s.u[j] ?? 0) > within || Math.abs(s.v[j] ?? 0) > within) return false;
  return true;
}

const smooth = (x: number) => x * x * (3 - 2 * x);

/**
 * How far along a ride is at each moment: speed eases up over `up` seconds, holds, and eases down over `down`.
 * Returns the distance covered (0 to 1) at evenly spaced times across `total` seconds.
 */
export function rideTable(total: number, up: number, down: number, samples = 540): number[] {
  const table: number[] = [];
  let sum = 0;
  for (let i = 0; i <= samples; i++) {
    const time = (i / samples) * total,
      speed = time < up ? smooth(time / up) : time > total - down ? smooth((total - time) / down) : 1;
    table.push(sum);
    sum += speed;
  }
  const end = table[samples] || 1;
  return table.map((value) => value / end);
}

/** Distance covered (0 to 1) when `part` (0 to 1) of the ride's time has passed. */
export function along(table: number[], part: number): number {
  const f = Math.min(Math.max(part, 0), 1) * (table.length - 1),
    i = Math.min(Math.floor(f), table.length - 2),
    a = table[i] ?? 0,
    b = table[i + 1] ?? 1;
  return a + (b - a) * (f - i);
}

/** The cab hanging under its grips. `theta` is its lean in radians; positive leans back against the direction of travel. */
export interface Pendulum {
  theta: number;
  omega: number;
}

/** One frame of the swing. `push` is what drives it: the line's acceleration, a gust, a touch. */
export function swing(p: Pendulum, dt: number, push: number, rate = 3.3, drag = 1.5): void {
  p.omega += (-rate * rate * p.theta - drag * p.omega + push) * dt;
  p.theta += p.omega * dt;
}

/** A point on a hanging span from (ax, ay) to (bx, by) that sags by `sag` in the middle, at `t` along it. */
export function onSpan(ax: number, ay: number, bx: number, by: number, sag: number, t: number): [number, number] {
  return [ax + (bx - ax) * t, ay + (by - ay) * t + sag * 4 * t * (1 - t)];
}
