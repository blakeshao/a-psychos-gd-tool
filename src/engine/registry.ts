// Node type definitions. Defined once in code, never serialized into documents.

import type { Font } from 'opentype.js';
import type { GpuContext } from '../gpu/device';
import type { ParamValue } from './graph';
import type { OutputValues, SocketType, Value } from './values';

export interface SocketSpec {
  name: string;
  type: SocketType;
  /** optional inputs may be left unwired; cook() receives no value for them */
  optional?: boolean;
}

export type ParamSpec =
  | { name: string; kind: 'string'; default: string }
  | { name: string; kind: 'number'; default: number; min?: number; max?: number; step?: number }
  | { name: string; kind: 'color'; default: string } // '#rrggbb'
  | { name: string; kind: 'select'; options: string[]; default: string };

export interface CookContext {
  /** null in headless tests — CPU nodes must not touch it */
  gpu: GpuContext | null;
  fonts: Map<string, Font>;
}

export interface NodeDef {
  type: string;
  inputs: SocketSpec[];
  outputs: SocketSpec[];
  params: ParamSpec[];
  cook(
    inputs: Record<string, Value>,
    params: Record<string, ParamValue>,
    ctx: CookContext,
  ): OutputValues | Promise<OutputValues>;
}

export type Registry = Map<string, NodeDef>;

/** "never coerced": a wire is legal only when the socket types match exactly. */
export function canConnect(from: SocketSpec, to: SocketSpec): boolean {
  return from.type === to.type;
}
