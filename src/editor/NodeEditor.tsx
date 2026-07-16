// The node canvas. xyflow renders the document graph; every edit (drag,
// wire, delete) flows back through store actions. wireIsValid gives live
// red/green feedback while dragging a connection.

import { useCallback, useEffect, useMemo } from 'react';
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
import { endGesture, useApp, wireIsValid } from '../store';
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
    let dragEnded = false;
    for (const c of changes) {
      if (c.type === 'position') {
        if (c.position) moveNode(c.id, c.position);
        if (c.dragging === false) dragEnded = true;
      } else if (c.type === 'remove') removed.push(c.id);
      else if (c.type === 'select') {
        if (c.selected) select(c.id);
        else if (selected === c.id) select(null);
      }
    }
    if (removed.length) removeNodes(removed);
    // the drop lands inside the drag's undo step; the next drag is its own
    if (dragEnded) endGesture();
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

  // Cmd/Ctrl+Z undoes, +Shift redoes — skipped while a text field has focus so
  // the browser's own undo keeps working inside param inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) useApp.getState().redo();
      else useApp.getState().undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
        <h1 className="editor-title">
          a-psychos-gd-tool
          <a
            className="github-link"
            href="https://github.com/blakeshao/a-psychos-gd-tool"
            target="_blank"
            rel="noreferrer"
            title="view source on GitHub"
            aria-label="view source on GitHub"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
        </h1>
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
