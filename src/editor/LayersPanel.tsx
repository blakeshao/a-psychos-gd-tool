// The layer stack, floating over the node editor. Rows run top layer first
// (paint order reversed, like every layer panel); clicking a row points the
// node editor at that layer's graph, dragging a row reorders the stack. The
// header edits the active layer's blend mode and opacity, and collapses the
// panel down to its title bar.

import { useEffect, useRef, useState } from 'react';
import { BLEND_MODE_GROUPS, type BlendMode, type Layer } from '../engine/graph';
import { endGesture, useApp } from '../store';
import { NumberDrag } from './GfxNode';

const OPACITY_SPEC = { name: 'opacity', kind: 'number', default: 100, min: 0, max: 100, step: 1 } as const;

export function LayersPanel() {
  const layers = useApp((s) => s.doc.layers);
  const activeLayerId = useApp((s) => s.activeLayerId);
  const active = layers.find((l) => l.id === activeLayerId) ?? layers[layers.length - 1];
  // the row being dragged, and the row the pointer is over (above = upper half,
  // i.e. the dragged layer would land higher in the stack)
  const [drag, setDrag] = useState<{ id: string; overId: string | null; above: boolean } | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const dropAt = (targetId: string, above: boolean) => {
    if (!drag) return;
    const ids = layers.map((l) => l.id);
    const from = ids.indexOf(drag.id);
    // rows display top-first, layers store bottom-first: dropping above a row
    // means landing just after it in the array
    let to = ids.indexOf(targetId) + (above ? 1 : 0);
    if (from < to) to -= 1; // the dragged layer's removal shifts the slot down
    if (from !== -1) useApp.getState().moveLayerTo(drag.id, to);
    setDrag(null);
  };

  return (
    <div className={`layers-panel${collapsed ? ' collapsed' : ''}`}>
      <div className="layers-head">
        <button
          type="button"
          className="layers-toggle"
          title={collapsed ? 'expand the layers panel' : 'collapse the layers panel'}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span className="layers-chevron">{collapsed ? '▸' : '▾'}</span>
          <span className="layers-title">layers</span>
        </button>
        <button
          type="button"
          className="num-arrow"
          title="add a layer above the active one"
          onClick={() => useApp.getState().addLayer()}
        >
          +
        </button>
      </div>
      {!collapsed && (<>
      <div className="layers-blend">
        <select
          title="blend mode"
          value={active.blendMode}
          onChange={(e) => useApp.getState().updateLayer(active.id, { blendMode: e.target.value as BlendMode })}
        >
          {BLEND_MODE_GROUPS.map(({ group, modes }) =>
            group === 'normal' ? (
              modes.map((m) => (
                <option key={m} value={m}>{m.replace(/-/g, ' ')}</option>
              ))
            ) : (
              <optgroup key={group} label={group}>
                {modes.map((m) => (
                  <option key={m} value={m}>{m.replace(/-/g, ' ')}</option>
                ))}
              </optgroup>
            ),
          )}
        </select>
        <div className="layers-opacity" title="layer opacity (%)">
          <NumberDrag
            spec={OPACITY_SPEC}
            value={Math.round(active.opacity * 100)}
            onChange={(v) => useApp.getState().updateLayer(active.id, { opacity: v / 100 })}
          />
        </div>
      </div>
      <div className="layers-list">
        {[...layers].reverse().map((layer) => (
          <LayerRow
            key={layer.id}
            layer={layer}
            active={layer.id === activeLayerId}
            topmost={layer === layers[layers.length - 1]}
            bottommost={layer === layers[0]}
            last={layers.length === 1}
            dragState={
              drag?.id === layer.id
                ? 'dragging'
                : drag?.overId === layer.id
                  ? drag.above
                    ? 'drop-above'
                    : 'drop-below'
                  : null
            }
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', layer.id);
              e.dataTransfer.effectAllowed = 'move';
              setDrag({ id: layer.id, overId: null, above: false });
            }}
            onDragOver={(e) => {
              if (!drag) return; // not our drag — a file, a stray selection
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const r = e.currentTarget.getBoundingClientRect();
              const above = e.clientY < r.top + r.height / 2;
              const overId = layer.id === drag.id ? null : layer.id;
              if (drag.overId !== overId || drag.above !== above) setDrag({ ...drag, overId, above });
            }}
            onDrop={(e) => {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              dropAt(layer.id, e.clientY < r.top + r.height / 2);
            }}
            onDragEnd={() => setDrag(null)}
          />
        ))}
      </div>
      </>)}
    </div>
  );
}

function LayerRow({
  layer,
  active,
  topmost,
  bottommost,
  last,
  dragState,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  layer: Layer;
  active: boolean;
  topmost: boolean;
  bottommost: boolean;
  last: boolean;
  dragState: 'dragging' | 'drop-above' | 'drop-below' | null;
  onDragStart: React.DragEventHandler<HTMLDivElement>;
  onDragOver: React.DragEventHandler<HTMLDivElement>;
  onDrop: React.DragEventHandler<HTMLDivElement>;
  onDragEnd: React.DragEventHandler<HTMLDivElement>;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = (name: string) => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== layer.name) useApp.getState().updateLayer(layer.id, { name: trimmed });
    endGesture();
    setEditing(false);
  };

  return (
    <div
      className={`layer-row${active ? ' active' : ''}${layer.visible ? '' : ' hidden-layer'}${dragState ? ` ${dragState}` : ''}`}
      onClick={() => useApp.getState().selectLayer(layer.id)}
      draggable={!editing}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        className="layer-eye"
        title={layer.visible ? 'hide layer' : 'show layer'}
        onClick={(e) => {
          e.stopPropagation();
          useApp.getState().updateLayer(layer.id, { visible: !layer.visible });
        }}
      >
        {layer.visible ? '●' : '○'}
      </button>
      {editing ? (
        <input
          ref={inputRef}
          className="layer-name-input"
          defaultValue={layer.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            else if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <span className="layer-name" title="double-click to rename" onDoubleClick={() => setEditing(true)}>
          {layer.name}
        </span>
      )}
      <span className="layer-tools">
        <button
          type="button"
          className="num-arrow"
          title="raise layer"
          disabled={topmost}
          onClick={(e) => {
            e.stopPropagation();
            useApp.getState().moveLayer(layer.id, 1);
          }}
        >
          ↑
        </button>
        <button
          type="button"
          className="num-arrow"
          title="lower layer"
          disabled={bottommost}
          onClick={(e) => {
            e.stopPropagation();
            useApp.getState().moveLayer(layer.id, -1);
          }}
        >
          ↓
        </button>
        <button
          type="button"
          className="num-arrow"
          title="delete layer"
          disabled={last}
          onClick={(e) => {
            e.stopPropagation();
            useApp.getState().removeLayer(layer.id);
          }}
        >
          ×
        </button>
      </span>
    </div>
  );
}
