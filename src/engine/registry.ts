// Node type definitions. Defined once in code, never serialized into documents.

import type { Font } from 'opentype.js';
import type { GpuContext } from '../gpu/device';
import type { ParamValue } from './graph';
import type { OutputValues, SocketType, Value } from './values';

export interface SocketSpec {
  name: string;
  /** a single type, or a union for inputs that accept several (e.g. raster | elements) */
  type: SocketType | SocketType[];
  /** optional inputs may be left unwired; cook() receives no value for them */
  optional?: boolean;
}

export function socketTypes(spec: SocketSpec): SocketType[] {
  return Array.isArray(spec.type) ? spec.type : [spec.type];
}

/**
 * When set, the param is only shown in the editor while another param's current
 * value is one of `in`. Purely a UI affordance — the evaluator always cooks with
 * every param (filled from defaults), so hidden params keep their default value.
 */
export interface ParamVisibility {
  showIf?: { param: string; in: string[] };
}

export type ParamSpec = ParamVisibility &
  (
    | { name: string; kind: 'string'; default: string }
    | { name: string; kind: 'number'; default: number; min?: number; max?: number; step?: number }
    | { name: string; kind: 'color'; default: string } // '#rrggbb'
    | { name: string; kind: 'toggle'; default: boolean }
    | { name: string; kind: 'select'; options: string[]; default: string }
    // a slot channel name — the editor offers the built-ins plus whatever the
    // document's Weight nodes write, same list the binds rows use
    | { name: string; kind: 'channel'; default: string }
    | { name: string; kind: 'image'; default: string } // a data: URI — travels with the doc
    // a JSON-encoded list of channel bindings ({channel, target, amount}[]) —
    // the editor renders rows plus an "add channel" button; cooks parse it
    | { name: string; kind: 'binds'; default: string }
  );

export interface CookContext {
  /** null in headless tests — CPU nodes must not touch it */
  gpu: GpuContext | null;
  fonts: Map<string, Font>;
  /** the document's artboard size — resolution for every frame-aware node */
  frame: { width: number; height: number };
}

export interface NodeDef {
  /** stable serialized identity — never change once documents reference it */
  type: string;
  /** palette/title display name; falls back to `type` when omitted */
  label?: string;
  inputs: SocketSpec[];
  outputs: SocketSpec[];
  params: ParamSpec[];
  /** set when cook() reads ctx.frame — the evaluator folds the frame into this node's hash */
  usesFrame?: boolean;
  /**
   * Extra entries folded into this node's hash, for ambient context the cook
   * reads beyond params/inputs — e.g. Text hashes the font it actually
   * resolved, so a font that finishes loading invalidates the cached fallback.
   */
  hashExtras?(params: Record<string, ParamValue>, ctx: CookContext): Record<string, string>;
  cook(
    inputs: Record<string, Value>,
    params: Record<string, ParamValue>,
    ctx: CookContext,
  ): OutputValues | Promise<OutputValues>;
}

export type Registry = Map<string, NodeDef>;

/**
 * "never coerced" applies to representation changes (vector→raster needs an
 * explicit Rasterize). A union input socket accepting one of several types is
 * not coercion — the value arrives unchanged; the node handles each kind.
 */
export function canConnect(from: SocketSpec, to: SocketSpec): boolean {
  const fromTypes = socketTypes(from);
  const toTypes = socketTypes(to);
  return fromTypes.some((t) => toTypes.includes(t));
}
