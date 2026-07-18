// The node canvas. xyflow renders the document graph; every edit (drag,
// wire, delete) flows back through store actions. wireIsValid gives live
// red/green feedback while dragging a connection.
//
// Figma-style pointer scheme: left-drag draws a marquee that selects every
// node it touches (⌘/shift-click adds to the selection); pan with a
// two-finger trackpad scroll, space+drag, or the middle/right button; pinch
// zooms. Selected nodes move and delete as a group.

import { useCallback, useEffect, useMemo } from 'react';
import {
  Background,
  Panel,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  useStoreApi,
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
import { endGesture, selectActiveGraph, useApp, wireIsValid } from '../store';
import { GfxNode } from './GfxNode';
import type { SocketType } from '../engine/values';

const nodeTypes = { gfx: GfxNode };

// Node cards are 210px wide (app.css .gfx-node); used to center new nodes.
const NODE_WIDTH = 210;
const NODE_HEIGHT_GUESS = 120;

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
  const graph = useApp(selectActiveGraph);
  const selectedNodeIds = useApp((s) => s.selectedNodeIds);

  const nodes: FlowNode[] = useMemo(
    () =>
      Object.values(graph.nodes).map((n) => ({
        id: n.id,
        type: 'gfx',
        position: n.position ?? { x: 0, y: 0 },
        data: {},
        selected: selectedNodeIds.includes(n.id),
      })),
    [graph.nodes, selectedNodeIds],
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
    const { moveNodes, removeNodes, select, selectedNodeIds: selected } = useApp.getState();
    const moved: Record<string, { x: number; y: number }> = {};
    const selectChanges = new Map<string, boolean>();
    const removed: string[] = [];
    let dragEnded = false;
    for (const c of changes) {
      if (c.type === 'position') {
        // a group drag emits one change per node in the same batch — collect
        // them so the whole set moves in a single store update / undo step
        if (c.position) moved[c.id] = c.position;
        if (c.dragging === false) dragEnded = true;
      } else if (c.type === 'remove') removed.push(c.id);
      else if (c.type === 'select') selectChanges.set(c.id, c.selected);
    }
    if (Object.keys(moved).length) moveNodes(moved);
    if (removed.length) removeNodes(removed);
    if (selectChanges.size) {
      const next = selected.filter((id) => selectChanges.get(id) !== false);
      for (const [id, on] of selectChanges) if (on && !next.includes(id)) next.push(id);
      select(next);
    }
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
    return wireIsValid(selectActiveGraph(useApp.getState()), {
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
      // left-drag draws the selection marquee; panning lives on two-finger
      // scroll, held space + drag, and the middle/right button; pinch zooms
      selectionOnDrag
      selectionMode={SelectionMode.Partial}
      multiSelectionKeyCode={['Meta', 'Shift']}
      panOnDrag={[1, 2]}
      panOnScroll
      panActivationKeyCode="Space"
      minZoom={0.1}
      fitView
      proOptions={{ hideAttribution: true }}
      colorMode="light"
    >
      <Background gap={16} size={1} />
      <Palette />
    </ReactFlow>
  );
}

// The add-node palette. Lives inside <ReactFlow> so it can read the current
// viewport and drop new nodes at the center of the visible pane.
function Palette() {
  const { getViewport } = useReactFlow();
  const flowStore = useStoreApi();

  const addNode = (type: string) => {
    const { width, height } = flowStore.getState();
    const { x, y, zoom } = getViewport();
    // center of the visible pane in flow coordinates
    const cx = (width / 2 - x) / zoom - NODE_WIDTH / 2;
    const cy = (height / 2 - y) / zoom - NODE_HEIGHT_GUESS / 2;
    // nudge each new node so repeated adds don't stack exactly
    const count = Object.keys(selectActiveGraph(useApp.getState()).nodes).length;
    const offset = (count % 5) * 24;
    useApp.getState().addNode(type, { x: cx + offset, y: cy + offset });
  };

  return (
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
  );
}
