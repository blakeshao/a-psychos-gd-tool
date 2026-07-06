// Custom xyflow node: title bar + one row per socket, handles colored by
// SocketType so the type ladder is visible on the canvas itself. Parameters
// are edited inline, right on the node.

import { useEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { socketTypes, type ParamSpec, type SocketSpec } from '../engine/registry';
import type { ParamValue } from '../engine/graph';
import type { SocketType } from '../engine/values';
import { registry } from '../nodes';
import { BIND_TARGETS, parseBinds, type BindSpec } from '../nodes/elements';
import { localFontsSupported, useApp } from '../store';

// Type ladder colors — a bright 2000s computer palette, one unique hue per type,
// matching the wire colors. Sockets (the circles) and the wires that leave them
// read as the same color.
export const SOCKET_COLORS: Record<SocketType, string> = {
  text: '#00e5ff', // cyan
  vector: '#00a99d', // teal
  raster: '#1493ff', // azure
  alpha: '#8a2be2', // blue violet
  elements: '#9aa0a6', // grey
  layout: '#ff1493', // hot pink
};

/** single type → its color; union input → neutral (accepts several) */
function socketColor(spec: SocketSpec): string {
  const types = socketTypes(spec);
  return types.length === 1 ? SOCKET_COLORS[types[0]] : '#a8a8a8';
}

function socketTitle(spec: SocketSpec): string {
  return `${spec.name}: ${socketTypes(spec).join(' | ')}${spec.optional ? ' (optional)' : ''}`;
}

export function GfxNode({ id }: NodeProps) {
  const node = useApp((s) => s.graph.nodes[id]);
  const setParam = useApp((s) => s.setParam);
  if (!node) return null;
  const def = registry.get(node.type);
  if (!def) return <div className="gfx-node">unknown: {node.type}</div>;

  // a param's effective value (instance value, else its def default)
  const paramVal = (name: string) =>
    node.params[name] ?? def.params.find((p) => p.name === name)?.default;
  // hide params gated behind a showIf whose controlling param isn't a match
  const visibleParams = def.params.filter(
    (p) => !p.showIf || p.showIf.in.includes(String(paramVal(p.showIf.param))),
  );

  return (
    <div className="gfx-node">
      <div className="gfx-title">{def.label ?? node.type}</div>
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
      {visibleParams.length > 0 && (
        <div className="gfx-params nodrag">
          {visibleParams.map((spec) => (
            <NodeParam
              key={spec.name}
              spec={spec}
              value={node.params[spec.name] ?? spec.default}
              onChange={(v) => setParam(node.id, spec.name, v)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NodeParam({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec;
  value: ParamValue;
  onChange: (v: ParamValue) => void;
}) {
  if (spec.name === 'font') {
    return (
      <label className="param">
        <span>{spec.name}</span>
        <FontSelect value={String(value)} onChange={onChange} />
      </label>
    );
  }
  if (spec.name === 'content') {
    return (
      <label className="param">
        <span>{spec.name}</span>
        <textarea
          className="nodrag"
          rows={3}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  }
  if (spec.kind === 'binds') {
    return <BindList value={String(value)} onChange={onChange} />;
  }
  if (spec.kind === 'image') {
    return (
      <label className="param">
        <span>{spec.name}</span>
        <ImageUpload value={String(value)} onChange={onChange} />
      </label>
    );
  }
  if (spec.kind === 'number') {
    return (
      <label className="param">
        <span>{spec.name}</span>
        <NumberDrag spec={spec} value={Number(value)} onChange={onChange} />
      </label>
    );
  }
  if (spec.kind === 'color') {
    return (
      <label className="param">
        <span>{spec.name}</span>
        <input type="color" value={String(value)} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }
  if (spec.kind === 'toggle') {
    return (
      <label className="param">
        <span>{spec.name}</span>
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      </label>
    );
  }
  if (spec.kind === 'select') {
    return (
      <label className="param">
        <span>{spec.name}</span>
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {spec.options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="param">
      <span>{spec.name}</span>
      <input type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

// Place's channel bindings: one row per bind (channel → target, amount, plus
// offset/invert to shape the signal), and an "add channel" button that appends
// a row. Rows live in one JSON param; parseBinds is shared with the cook so
// both sides read it alike.
function BindList({ value, onChange }: { value: string; onChange: (v: ParamValue) => void }) {
  const nodes = useApp((s) => s.graph.nodes);
  const binds = parseBinds(value);
  const set = (next: BindSpec[]) => onChange(JSON.stringify(next));
  const patch = (i: number, part: Partial<BindSpec>) =>
    set(binds.map((b, k) => (k === i ? { ...b, ...part } : b)));

  // what a row can read: the built-ins + whatever this document's Weights
  // write — channels are named after their Weight node's source
  const channels = ['weight', 'progress'];
  for (const n of Object.values(nodes)) {
    if (n.type !== 'Weight') continue;
    const t = String(n.params.source ?? 'noise').trim();
    if (t && !channels.includes(t)) channels.push(t);
  }

  // amounts mean different things per target: strength (0..1) vs blur px
  const amountSpec = (target: BindSpec['target']): NumberSpec =>
    target === 'blur'
      ? { name: 'amount', kind: 'number', default: 8, min: 0, max: 64, step: 1 }
      : { name: 'amount', kind: 'number', default: 1, min: 0, max: 1, step: 0.01 };

  return (
    <div className="bind-list">
      {binds.map((b, i) => (
        <div key={i} className="bind-item">
          <div className="bind-item-head">
            <span>bind {i + 1}</span>
            <button type="button" className="num-arrow" title="remove binding" onClick={() => set(binds.filter((_, k) => k !== i))}>
              ×
            </button>
          </div>
          <label className="param">
            <span>channel</span>
            <select value={b.channel} onChange={(e) => patch(i, { channel: e.target.value })}>
              {(channels.includes(b.channel) ? channels : [...channels, b.channel]).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="param">
            <span>target</span>
            <select
              value={b.target}
              onChange={(e) => {
                const target = e.target.value as BindSpec['target'];
                patch(i, { target, amount: target === 'blur' ? 8 : 1 });
              }}
            >
              {BIND_TARGETS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="param">
            <span>amount</span>
            <NumberDrag spec={amountSpec(b.target)} value={b.amount} onChange={(v) => patch(i, { amount: v })} />
          </label>
          <label className="param">
            <span>offset</span>
            <NumberDrag
              spec={{ name: 'offset', kind: 'number', default: 0, min: -1, max: 1, step: 0.01 }}
              value={b.offset ?? 0}
              onChange={(v) => patch(i, { offset: v })}
            />
          </label>
          <label className="param">
            <span>invert</span>
            <select value={b.invert ? 'yes' : 'no'} onChange={(e) => patch(i, { invert: e.target.value === 'yes' })}>
              <option value="no">no</option>
              <option value="yes">yes</option>
            </select>
          </label>
        </div>
      ))}
      <button
        type="button"
        className="bind-add"
        onClick={() => set([...binds, { channel: 'weight', target: 'scale', amount: 1 }])}
      >
        + add channel
      </button>
    </div>
  );
}

// Image upload: a hidden file input behind an upload/replace button, with a
// thumbnail of the current picture. The file is read as a data: URI so it lands
// straight in the node param and travels with the document.
function ImageUpload({ value, onChange }: { value: string; onChange: (v: ParamValue) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result));
    reader.readAsDataURL(file);
    e.target.value = ''; // let the same file be re-picked later
  };
  return (
    <div className="image-upload">
      <button type="button" className="image-upload-btn" onClick={() => inputRef.current?.click()}>
        {value ? 'replace' : 'upload'}
      </button>
      {value && <img className="image-upload-thumb" src={value} alt="" />}
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={onFile} />
    </div>
  );
}

// Font picker: a searchable combobox over the loaded fonts plus the user's
// local font families. Each option is previewed in its own typeface (local
// families resolve as installed system fonts), and a button requests local-font
// access (Chromium's Local Font Access API).
function FontSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const fonts = useApp((s) => s.fonts);
  const localFonts = useApp((s) => s.localFonts);
  const loadLocalFont = useApp((s) => s.loadLocalFont);
  const loadLocalFonts = useApp((s) => s.loadLocalFonts);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const options = Array.from(new Set(['default', value, ...Object.keys(fonts), ...localFonts]));
  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((f) => f.toLowerCase().includes(q)) : options;

  // close the menu when clicking outside the control
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  const choose = (f: string) => {
    onChange(f);
    // start parsing right away instead of waiting for the graph→effect
    // round-trip; no-ops for 'default' and already-loaded fonts
    loadLocalFont(f);
    setOpen(false);
    setQuery('');
  };

  const previewFont = (f: string) => (f === 'default' ? 'inherit' : `"${f}"`);

  return (
    <div className="font-select" ref={ref}>
      <div className="font-select-control">
        <input
          className="font-select-input"
          value={open ? query : value}
          placeholder={value}
          style={{ fontFamily: open ? 'inherit' : previewFont(value) }}
          onFocus={(e) => { setOpen(true); setQuery(value); e.target.select(); }}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        />
        <button
          type="button"
          className="num-arrow font-select-caret"
          title="show all fonts"
          onPointerDown={(e) => {
            e.preventDefault();
            setOpen((o) => !o);
            setQuery('');
          }}
        >
          ▾
        </button>
        {localFontsSupported && (
          <button
            type="button"
            className="num-arrow"
            title="load local fonts"
            onClick={() => loadLocalFonts()}
          >
            ⤓
          </button>
        )}
      </div>
      {open && (
        <ul
          className="font-select-menu nodrag nowheel"
          onWheelCapture={(e) => e.stopPropagation()}
        >
          {filtered.length === 0 && <li className="font-select-empty">no match</li>}
          {filtered.map((f) => (
            <li
              key={f}
              className={f === value ? 'active' : ''}
              style={{ fontFamily: previewFont(f) }}
              onPointerDown={(e) => { e.preventDefault(); choose(f); }}
            >
              {f}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type NumberSpec = Extract<ParamSpec, { kind: 'number' }>;

// Blender-style number field: drag horizontally to scrub the value, click the
// ‹ › arrows to step, or click the field to type an exact value.
function NumberDrag({
  spec,
  value,
  onChange,
}: {
  spec: NumberSpec;
  value: number;
  onChange: (v: number) => void;
}) {
  const min = spec.min ?? -Infinity;
  const max = spec.max ?? Infinity;
  const step = spec.step ?? 1;
  const [editing, setEditing] = useState(false);
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);

  const snap = (v: number) => {
    const snapped = Math.round(v / step) * step;
    const clamped = Math.min(max, Math.max(min, snapped));
    return Number(clamped.toPrecision(12));
  };

  const dot = String(step).indexOf('.');
  const decimals = dot === -1 ? 0 : String(step).length - dot - 1;
  const display = value.toFixed(decimals);

  const onPointerDown = (e: React.PointerEvent) => {
    if (editing) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, v: value, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 3) d.moved = true;
    if (!d.moved) return;
    const range = Number.isFinite(max - min) ? max - min : 100;
    onChange(snap(d.v + dx * (range / 200)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (d && !d.moved) setEditing(true);
  };

  return (
    <div className="num-drag">
      <button type="button" className="num-arrow" onClick={() => onChange(snap(value - step))}>
        ‹
      </button>
      {editing ? (
        <input
          className="num-field"
          type="number"
          autoFocus
          defaultValue={display}
          min={spec.min}
          max={spec.max}
          step={step}
          onBlur={(e) => {
            onChange(snap(Number(e.target.value)));
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            else if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <span
          className="num-field"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {display}
        </span>
      )}
      <button type="button" className="num-arrow" onClick={() => onChange(snap(value + step))}>
        ›
      </button>
    </div>
  );
}
