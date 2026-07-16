// The layer stack, floating over the viewport. Rows run top layer first
// (paint order reversed, like every layer panel); clicking a row points the
// node editor at that layer's graph. The header edits the active layer's
// blend mode and opacity.

import { useEffect, useRef, useState } from 'react';
import { BLEND_MODE_GROUPS, type BlendMode, type Layer } from '../engine/graph';
import { endGesture, useApp } from '../store';

export function LayersPanel() {
  const layers = useApp((s) => s.doc.layers);
  const activeLayerId = useApp((s) => s.activeLayerId);
  const active = layers.find((l) => l.id === activeLayerId) ?? layers[layers.length - 1];

  return (
    <div className="layers-panel">
      <div className="layers-head">
        <span className="layers-title">layers</span>
        <button
          type="button"
          className="num-arrow"
          title="add a layer above the active one"
          onClick={() => useApp.getState().addLayer()}
        >
          +
        </button>
      </div>
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
        <input
          type="range"
          title="layer opacity"
          min={0}
          max={100}
          value={Math.round(active.opacity * 100)}
          onChange={(e) => useApp.getState().updateLayer(active.id, { opacity: Number(e.target.value) / 100 })}
          onPointerUp={endGesture}
        />
        <span className="layers-opacity">{Math.round(active.opacity * 100)}%</span>
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
          />
        ))}
      </div>
    </div>
  );
}

function LayerRow({
  layer,
  active,
  topmost,
  bottommost,
  last,
}: {
  layer: Layer;
  active: boolean;
  topmost: boolean;
  bottommost: boolean;
  last: boolean;
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
      className={`layer-row${active ? ' active' : ''}${layer.visible ? '' : ' hidden-layer'}`}
      onClick={() => useApp.getState().selectLayer(layer.id)}
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
