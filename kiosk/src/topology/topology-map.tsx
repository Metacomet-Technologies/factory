import { memo, useMemo, useState } from "react";
import {
  Controls,
  Handle,
  Position,
  ReactFlow,
  Panel as FlowPanel,
  type Edge as FlowEdge,
  type EdgeProps,
  type Node as FlowNode,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Workflow } from "lucide-react";
import { Button } from "../components/ui/button";
import { usePhone } from "../lib/motion";
import { PageHeader } from "../components/ui/page-header";
import { Panel } from "../components/ui/panel";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { routesFor } from "./routes";
import {
  EDGES,
  FLOWS,
  NODE_H,
  NODE_W,
  NODES,
  ZONES,
  type NodeKind,
  type ZoneTone,
} from "./topology";
import "./topology.css";

type BoxNode = FlowNode<{ title: string; sub: string; kind: NodeKind; active: boolean }, "box">;
type ZoneNode = FlowNode<{ label: string; tone: ZoneTone; active: boolean }, "zone">;
type RouteEdge = FlowEdge<{ d: string; arrow: string; dashed: boolean }, "flow">;

/** Hidden handles so React Flow accepts an edge; the router draws the real geometry. */
function Anchors() {
  return (
    <>
      <Handle type="source" position={Position.Top} className="topo-handle" isConnectable={false} />
      <Handle type="target" position={Position.Top} className="topo-handle" isConnectable={false} />
    </>
  );
}

const BoxNodeView = memo(function BoxNodeView({ data }: NodeProps<BoxNode>) {
  return (
    <div className={`topo-node topo-node--${data.kind}${data.active ? " is-active" : ""}`}>
      <Anchors />
      <div className="topo-node__title">{data.title}</div>
      <div className="topo-node__sub">{data.sub}</div>
    </div>
  );
});

const ZoneNodeView = memo(function ZoneNodeView({ data }: NodeProps<ZoneNode>) {
  return (
    <div className={`topo-zone topo-zone--${data.tone}${data.active ? " is-active" : ""}`}>
      <Anchors />
      <div className="topo-zone__label">{data.label}</div>
    </div>
  );
});

const FlowEdgeView = memo(function FlowEdgeView({ data }: EdgeProps<RouteEdge>) {
  if (!data) return null;
  return (
    <g className={`topo-edge${data.dashed ? " is-dashed" : ""}`}>
      <path className="topo-edge__line" d={data.d} />
      <path className="topo-edge__dots" d={data.d} />
      <path className="topo-edge__arrow" d={data.arrow} />
    </g>
  );
});

const nodeTypes = { box: BoxNodeView, zone: ZoneNodeView };
const edgeTypes = { flow: FlowEdgeView };
const zoneZ: Record<ZoneTone, number> = { tailnet: -3, host: -2, group: -1 };

/** Every zone and box, with the selected flow's members marked active, plus its routed edges only. */
function buildGraph(flow: (typeof FLOWS)[number]) {
  const active = new Set(flow.nodes);
  const routes = routesFor(flow);
  const zones: ZoneNode[] = ZONES.map((zone) => ({
    id: zone.id,
    type: "zone",
    position: { x: zone.x, y: zone.y },
    width: zone.w,
    height: zone.h,
    zIndex: zoneZ[zone.tone],
    draggable: false,
    selectable: false,
    focusable: false,
    data: { label: zone.label, tone: zone.tone, active: active.has(zone.id) },
  }));
  const boxes: BoxNode[] = NODES.map((node) => ({
    id: node.id,
    type: "box",
    position: { x: node.x, y: node.y },
    width: NODE_W,
    height: NODE_H,
    draggable: false,
    selectable: false,
    data: { title: node.title, sub: node.sub, kind: node.kind, active: active.has(node.id) },
  }));
  const edges: RouteEdge[] = [];
  for (const edge of EDGES) {
    const found = routes.get(edge.id);
    if (!found) continue;
    edges.push({
      id: edge.id,
      type: "flow",
      source: edge.from,
      target: edge.to,
      selectable: false,
      focusable: false,
      zIndex: 1,
      data: { d: found.d, arrow: found.arrow, dashed: edge.dashed },
    });
  }
  return { nodes: [...zones, ...boxes], edges };
}

/**
 * The static topology page: the factory map with one flow lit at a time. No live data; the
 * routes are computed once per flow at runtime (`routes.ts`).
 */
export default function TopologyPage({ dark }: { dark: boolean }) {
  const [flowId, setFlowId] = useState(FLOWS[0]!.id);
  const flow = FLOWS.find((candidate) => candidate.id === flowId) ?? FLOWS[0]!;
  const { nodes, edges } = useMemo(() => buildGraph(flow), [flow]);
  // Phones read the steps inline, so the document scrolls them; elsewhere they float in a popover.
  const phone = usePhone();
  const [explained, setExplained] = useState(false);
  const steps = (
    <>
      <h3>{flow.name}</h3>
      <p className="muted">{flow.intro}</p>
      <ol>
        {flow.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="topology-legend">
        <span>Solid: request or data</span>
        <span className="is-dashed">Dashed: a person acting, or a scheduled job</span>
      </div>
    </>
  );
  return (
    <main id="main" className="dashboard topology-page">
      <PageHeader
        eyebrow="Software factory"
        title="Topology"
        aside={
          <ToggleGroup
            value={[flow.id]}
            onValueChange={(values) => {
              const next = values[0];
              if (typeof next === "string") setFlowId(next);
            }}
            aria-label="Flow"
            size="sm"
            className="topology-flows"
          >
            {FLOWS.map((candidate) => (
              <ToggleGroupItem key={candidate.id} value={candidate.id}>
                {candidate.name}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      />
      <Panel
        title={flow.name}
        subtitle={flow.intro}
        icon={<Workflow />}
        index={0}
        className="topology-panel"
        bodyClassName="topology-body"
        action={
          phone ? (
            <Button
              variant="outline"
              size="sm"
              aria-expanded={explained}
              aria-controls="topology-steps"
              onClick={() => setExplained((open) => !open)}
            >
              How {flow.name.toLowerCase()} works
            </Button>
          ) : (
            <Button variant="outline" size="sm" popoverTarget="topology-steps">
              How {flow.name.toLowerCase()} works
            </Button>
          )
        }
      >
        {phone ? (
          explained && (
            <section
              id="topology-steps"
              className="topology-steps topology-steps-inline"
              aria-label={`How ${flow.name.toLowerCase()} works`}
            >
              {steps}
            </section>
          )
        ) : (
          <div id="topology-steps" popover="auto" className="panel topology-steps">
            {steps}
          </div>
        )}
        <div className="topology-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode={dark ? "dark" : "light"}
            fitView
            fitViewOptions={{ padding: 0.03 }}
            minZoom={0.3}
            maxZoom={2}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnScroll
            zoomOnDoubleClick={false}
          >
            <FlowPanel position="bottom-left" className="topology-hint muted">
              Drag to pan, pinch or ⌘-scroll to zoom
            </FlowPanel>
            <Controls showInteractive={false} position="bottom-right" />
          </ReactFlow>
        </div>
      </Panel>
    </main>
  );
}
