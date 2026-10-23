import { Grid, route, type Rect, type Route } from "./router";
import { EDGES, NODE_H, NODE_W, NODES, ZONES, type Flow } from "./topology";

/** Every box and zone as a rectangle; both can be edge endpoints. */
const rects = new Map<string, Rect>([
  ...NODES.map((node): [string, Rect] => [node.id, { x: node.x, y: node.y, w: NODE_W, h: NODE_H }]),
  ...ZONES.map((zone): [string, Rect] => [zone.id, { x: zone.x, y: zone.y, w: zone.w, h: zone.h }]),
]);

/** Zone titles: soft cost only, so edges prefer not to cross the text. */
const labelStrips: Rect[] = ZONES.map((zone) => ({
  x: zone.x,
  y: zone.y,
  w: Math.min(zone.w, 360),
  h: 30,
}));

const grid = new Grid(
  NODES.map((node) => rects.get(node.id)!),
  labelStrips,
);

const cache = new Map<string, Map<string, Route>>();

/**
 * Routes every edge of a flow, in the flow's edge order, so later edges avoid cells the
 * earlier ones took. Computed once per flow and cached.
 */
export function routesFor(flow: Flow): Map<string, Route> {
  const cached = cache.get(flow.id);
  if (cached) return cached;
  const used = new Uint8Array(grid.cols * grid.rows);
  const routes = new Map<string, Route>();
  for (const id of flow.edges) {
    const edge = EDGES.find((candidate) => candidate.id === id);
    const from = edge && rects.get(edge.from);
    const to = edge && rects.get(edge.to);
    if (!from || !to) continue;
    const found = route(grid, from, to, used);
    if (found) routes.set(id, found);
  }
  cache.set(flow.id, routes);
  return routes;
}
