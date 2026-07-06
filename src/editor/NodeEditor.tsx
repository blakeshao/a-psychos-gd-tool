// The node canvas. xyflow renders the document graph; every edit (drag,
// wire, delete) flows back through store actions. wireIsValid gives live
// red/green feedback while dragging a connection.

import { useCallback, useMemo } from 'react';
import {
  Background,
  Panel,
  ReactFlow,
  type Connection,
  type Edge as FlowEdge,
  type EdgeChange,
  type Node as FlowNode,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { edgeKey } from '../engine/graph';
import { socketTypes } from '../engine/registry';
import { PALETTE, registry } from '../nodes';
import { useApp, wireIsValid } from '../store';
import { GfxNode } from './GfxNode';
import type { SocketType } from '../engine/values';

const nodeTypes = { gfx: GfxNode };

// Wire colors — a bright 2000s palette, one unique hue per type, matching the
// socket circle colors in GfxNode.
const WIRE_COLORS: Record<SocketType, string> = {
  text: '#00e5ff', // cyan
  vector: '#00a99d', // teal
  raster: '#1493ff', // azure
  alpha: '#8a2be2', // blue violet
  elements: '#9aa0a6', // grey
  layout: '#ff1493', // hot pink
};

export function NodeEditor() {
  const graph = useApp((s) => s.graph);
  const selectedNodeId = useApp((s) => s.selectedNodeId);

  const nodes: FlowNode[] = useMemo(
    () =>
      Object.values(graph.nodes).map((n) => ({
        id: n.id,
        type: 'gfx',
        position: n.position ?? { x: 0, y: 0 },
        data: {},
        selected: n.id === selectedNodeId,
      })),
    [graph.nodes, selectedNodeId],
  );

  const edges: FlowEdge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const fromDef = registry.get(graph.nodes[e.from.node]?.type ?? '');
        const fromSpec = fromDef?.outputs.find((s) => s.name === e.from.socket);
        const socketType = fromSpec ? socketTypes(fromSpec)[0] : undefined;
        return {
          id: edgeKey(e),
          source: e.from.node,
          sourceHandle: e.from.socket,
          target: e.to.node,
          targetHandle: e.to.socket,
          style: socketType ? { stroke: WIRE_COLORS[socketType], strokeWidth: 1.5 } : undefined,
        };
      }),
    [graph],
  );

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const { moveNode, removeNodes, select, selectedNodeId: selected } = useApp.getState();
    const removed: string[] = [];
    for (const c of changes) {
      if (c.type === 'position' && c.position) moveNode(c.id, c.position);
      else if (c.type === 'remove') removed.push(c.id);
      else if (c.type === 'select') {
        if (c.selected) select(c.id);
        else if (selected === c.id) select(null);
      }
    }
    if (removed.length) removeNodes(removed);
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (removed.length) useApp.getState().removeEdges(removed);
  }, []);

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.sourceHandle || !conn.targetHandle) return;
    useApp.getState().connect({
      source: conn.source,
      sourceHandle: conn.sourceHandle,
      target: conn.target,
      targetHandle: conn.targetHandle,
    });
  }, []);

  const isValidConnection = useCallback((conn: Connection | FlowEdge) => {
    if (!conn.sourceHandle || !conn.targetHandle) return false;
    return wireIsValid(useApp.getState().graph, {
      source: conn.source,
      sourceHandle: conn.sourceHandle,
      target: conn.target,
      targetHandle: conn.targetHandle,
    });
  }, []);

  const addNode = (type: string) => {
    // drop new nodes in a loose cascade so they don't stack exactly
    const count = Object.keys(useApp.getState().graph.nodes).length;
    useApp.getState().addNode(type, { x: 80 + (count % 6) * 96, y: 260 + (count % 4) * 48 });
  };

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      deleteKeyCode={['Backspace', 'Delete']}
      minZoom={0.1}
      fitView
      proOptions={{ hideAttribution: true }}
      colorMode="light"
    >
      <Background gap={16} size={1} />
      <Panel position="top-left" className="palette">
        <h1 className="editor-title">nodegfx</h1>
        {PALETTE.map(({ category, nodes }) => (
          <details key={category} className="palette-group">
            <summary className="palette-heading">{category}</summary>
            <div className="palette-buttons">
              {nodes.map((def) => (
                <button key={def.type} onClick={() => addNode(def.type)}>
                  + {def.label ?? def.type}
                </button>
              ))}
            </div>
          </details>
        ))}
      </Panel>
    </ReactFlow>
  );
}
