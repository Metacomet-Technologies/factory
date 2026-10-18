/**
 * Orthogonal edge router: an A* search over an 8 px grid in which every box (inflated by
 * 6 px) is blocked, zone label strips cost extra, bends cost 10 and cells already used by
 * an earlier edge of the same flow cost 8. The result is a rounded SVG path, an arrowhead
 * and the bend points. Constants are the prototype's; the routes depend on every one.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Route {
  d: string;
  arrow: string;
  points: [number, number][];
}

/** A port: the grid cell just outside a box side, and the anchor point on the box edge. */
interface Port {
  cx: number;
  cy: number;
  dir: number;
  ax: number;
  ay: number;
}

const CELL = 8;
const MARGIN = 80;
const INFLATE = 6;
const LABEL_COST = 4;
const PORT = 14;
const BEND = 10;
const REUSE = 8;
const RADIUS = 8;
const ARROW = 6;

/** Up, right, down, left; `dir + 2 (mod 4)` is the opposite direction. */
const DIRS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export class Grid {
  cols: number;
  rows: number;
  ox: number;
  oy: number;
  blocked: Uint8Array;
  base: Uint16Array;

  constructor(boxes: Rect[], softRects: Rect[] = []) {
    const xs = boxes.flatMap((box) => [box.x, box.x + box.w]);
    const ys = boxes.flatMap((box) => [box.y, box.y + box.h]);
    this.ox = Math.min(...xs) - MARGIN;
    this.oy = Math.min(...ys) - MARGIN;
    this.cols = Math.ceil((Math.max(...xs) + MARGIN - this.ox) / CELL);
    this.rows = Math.ceil((Math.max(...ys) + MARGIN - this.oy) / CELL);
    this.blocked = new Uint8Array(this.cols * this.rows);
    this.base = new Uint16Array(this.cols * this.rows);
    for (const box of boxes) this.fill(box, INFLATE, (i) => (this.blocked[i] = 1));
    for (const rect of softRects)
      this.fill(rect, 0, (i) => (this.base[i] = (this.base[i] ?? 0) + LABEL_COST));
  }

  fill(rect: Rect, inflate: number, visit: (index: number) => void) {
    const left = Math.max(0, Math.floor((rect.x - inflate - this.ox) / CELL));
    const right = Math.min(this.cols - 1, Math.floor((rect.x + rect.w + inflate - this.ox) / CELL));
    const top = Math.max(0, Math.floor((rect.y - inflate - this.oy) / CELL));
    const bottom = Math.min(
      this.rows - 1,
      Math.floor((rect.y + rect.h + inflate - this.oy) / CELL),
    );
    for (let row = top; row <= bottom; row++)
      for (let col = left; col <= right; col++) visit(row * this.cols + col);
  }

  col(x: number) {
    return Math.round((x - this.ox - CELL / 2) / CELL);
  }
  row(y: number) {
    return Math.round((y - this.oy - CELL / 2) / CELL);
  }
  px(col: number) {
    return this.ox + col * CELL + CELL / 2;
  }
  py(row: number) {
    return this.oy + row * CELL + CELL / 2;
  }
  free(col: number, row: number) {
    return (
      col >= 0 &&
      row >= 0 &&
      col < this.cols &&
      row < this.rows &&
      !this.blocked[row * this.cols + col]
    );
  }
  cost(index: number) {
    return this.base[index] ?? 0;
  }

  /** One port per side (top, right, bottom, left), 14 px out, keeping only the free ones. */
  ports(rect: Rect): Port[] {
    const midX = rect.x + rect.w / 2;
    const midY = rect.y + rect.h / 2;
    const sides: [number, number, number][] = [
      [midX, rect.y - PORT, 0],
      [rect.x + rect.w + PORT, midY, 1],
      [midX, rect.y + rect.h + PORT, 2],
      [rect.x - PORT, midY, 3],
    ];
    return sides
      .map(([x, y, dir]) => {
        const cx = this.col(x);
        const cy = this.row(y);
        const ax = dir % 2 === 0 ? this.px(cx) : dir === 1 ? rect.x + rect.w : rect.x;
        const ay = dir % 2 === 1 ? this.py(cy) : dir === 0 ? rect.y : rect.y + rect.h;
        return { cx, cy, dir, ax, ay };
      })
      .filter((port) => this.free(port.cx, port.cy));
  }
}

/** Binary min-heap of [priority, state]; ties keep insertion order the way the prototype did. */
class MinHeap {
  private items: [number, number][] = [];

  get size() {
    return this.items.length;
  }

  push(priority: number, state: number) {
    const items = this.items;
    items.push([priority, state]);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent]![0] <= priority) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }

  pop(): [number, number] {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && items[left]![0] < items[smallest]![0]) smallest = left;
        if (right < items.length && items[right]![0] < items[smallest]![0]) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest]!, items[i]!];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * Routes one edge from `from` to `to`. A search state is `cell * 4 + dir` so that bends
 * cost extra; `used` marks the cells taken by earlier edges of the same flow and is updated
 * with this route. Returns null when either box has no free port or no path exists.
 */
export function route(grid: Grid, from: Rect, to: Rect, used: Uint8Array): Route | null {
  const starts = grid.ports(from);
  const goals = grid.ports(to);
  if (!starts.length || !goals.length) return null;
  const cells = grid.cols * grid.rows;
  const dist = new Float64Array(cells * 4).fill(Infinity);
  const prev = new Int32Array(cells * 4).fill(-1);
  const goalByCell = new Map<number, Port>();
  for (const goal of goals) goalByCell.set(goal.cy * grid.cols + goal.cx, goal);
  const heuristic = (col: number, row: number) =>
    Math.min(...goals.map((goal) => Math.abs(goal.cx - col) + Math.abs(goal.cy - row)));
  const open = new MinHeap();
  for (const start of starts) {
    const state = (start.cy * grid.cols + start.cx) * 4 + start.dir;
    dist[state] = 0;
    open.push(heuristic(start.cx, start.cy), state);
  }
  let endState = -1;
  let endPort: Port | undefined;
  while (open.size) {
    const [priority, state] = open.pop();
    const cell = state >> 2;
    const dir = state & 3;
    const cost = dist[state]!;
    // A stale heap entry: a cheaper path to this state was found after it was queued.
    if (priority - heuristic(cell % grid.cols, Math.floor(cell / grid.cols)) > cost + 1e-9)
      continue;
    const goal = goalByCell.get(cell);
    if (goal && dir === (goal.dir + 2) % 4) {
      endState = state;
      endPort = goal;
      break;
    }
    const col = cell % grid.cols;
    const row = Math.floor(cell / grid.cols);
    for (let next = 0; next < 4; next++) {
      if (next === (dir + 2) % 4) continue;
      const [dx, dy] = DIRS[next]!;
      const nextCol = col + dx;
      const nextRow = row + dy;
      if (!grid.free(nextCol, nextRow)) continue;
      const nextCell = nextRow * grid.cols + nextCol;
      const nextState = nextCell * 4 + next;
      const nextCost =
        cost + 1 + (next !== dir ? BEND : 0) + grid.cost(nextCell) + (used[nextCell] ? REUSE : 0);
      if (nextCost < dist[nextState]!) {
        dist[nextState] = nextCost;
        prev[nextState] = state;
        open.push(nextCost + heuristic(nextCol, nextRow), nextState);
      }
    }
  }
  if (endState < 0 || !endPort) return null;
  const path: number[] = [];
  for (let state = endState; state >= 0; state = prev[state]!) path.push(state >> 2);
  path.reverse();
  for (const cell of path) used[cell] = 1;
  const firstCell = path[0]!;
  const startPort = starts.find((port) => port.cy * grid.cols + port.cx === firstCell)!;
  const raw: [number, number][] = [
    [startPort.ax, startPort.ay],
    ...path.map((cell): [number, number] => [
      grid.px(cell % grid.cols),
      grid.py(Math.floor(cell / grid.cols)),
    ]),
    [endPort.ax, endPort.ay],
  ];
  // Keep only the corners: drop every point that is collinear with its neighbours.
  const points = raw.filter((point, i) => {
    const before = raw[i - 1];
    const after = raw[i + 1];
    if (!before || !after) return true;
    return !(
      (before[0] === point[0] && point[0] === after[0]) ||
      (before[1] === point[1] && point[1] === after[1])
    );
  });
  return { d: roundedPath(points, RADIUS), arrow: arrowhead(endPort), points };
}

/** Polyline through `points` with each corner rounded by a quadratic curve of `radius`. */
function roundedPath(points: [number, number][], radius: number) {
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[i + 1]!;
    const r = Math.min(radius, Math.hypot(x1 - x0, y1 - y0) / 2, Math.hypot(x2 - x1, y2 - y1) / 2);
    const inX = x1 - Math.sign(x1 - x0) * r;
    const inY = y1 - Math.sign(y1 - y0) * r;
    const outX = x1 + Math.sign(x2 - x1) * r;
    const outY = y1 + Math.sign(y2 - y1) * r;
    d += ` L${inX},${inY} Q${x1},${y1} ${outX},${outY}`;
  }
  const last = points[points.length - 1]!;
  return d + ` L${last[0]},${last[1]}`;
}

/** Triangle pointing into the box at the goal port. */
function arrowhead(port: Port) {
  const [dx, dy] = DIRS[(port.dir + 2) % 4]!;
  const tipX = port.ax;
  const tipY = port.ay;
  const baseX = tipX - dx * ARROW * 1.6;
  const baseY = tipY - dy * ARROW * 1.6;
  return `M${tipX},${tipY} L${baseX - dy * ARROW},${baseY + dx * ARROW} L${baseX + dy * ARROW},${baseY - dx * ARROW} Z`;
}
