// Custom xyflow node: title bar + one row per socket, handles colored by
// SocketType so the type ladder is visible on the canvas itself.

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { socketTypes, type SocketSpec } from '../engine/registry';
import type { SocketType } from '../engine/values';
import { registry } from '../nodes';
import { useApp } from '../store';

export const SOCKET_COLORS: Record<SocketType, string> = {
  text: '#e8a04c',
  vector: '#5fce7a',
  raster: '#6aa9e9',
  alpha: '#b9b9b9',
  elements: '#c77fd6',
  layout: '#e96a9a',
};

/** single type → its color; union input → neutral (accepts several) */
function socketColor(spec: SocketSpec): string {
  const types = socketTypes(spec);
  return types.length === 1 ? SOCKET_COLORS[types[0]] : '#e8e8e8';
}

function socketTitle(spec: SocketSpec): string {
  return `${spec.name}: ${socketTypes(spec).join(' | ')}${spec.optional ? ' (optional)' : ''}`;
}

export function GfxNode({ id }: NodeProps) {
  const node = useApp((s) => s.graph.nodes[id]);
  if (!node) return null;
  const def = registry.get(node.type);
  if (!def) return <div className="gfx-node">unknown: {node.type}</div>;

  return (
    <div className="gfx-node">
      <div className="gfx-title">{node.type}</div>
      <div className="gfx-body">
        {def.inputs.map((s) => (
          <div key={s.name} className="gfx-row in">
            <Handle
              type="target"
              position={Position.Left}
              id={s.name}
              title={socketTitle(s)}
              style={{ background: socketColor(s) }}
            />
            <span>{s.optional ? `${s.name}?` : s.name}</span>
          </div>
        ))}
        {def.outputs.map((s) => (
          <div key={s.name} className="gfx-row out">
            <span>{s.name}</span>
            <Handle
              type="source"
              position={Position.Right}
              id={s.name}
              title={socketTitle(s)}
              style={{ background: socketColor(s) }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
