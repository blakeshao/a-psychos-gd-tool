// Pull-based DAG evaluator with hash-keyed memoization.
//
// evaluate(graph, rootId) cooks the root by recursively cooking its inputs.
// Each node's output is cached under hash(type, params, upstream hashes), so
// changing one param re-cooks only that node and its descendants — everything
// else is a HIT. Async nodes need no special casing: cook() is awaited.

import type { Edge, Graph, NodeId, ParamValue } from './graph';
import { hashNode } from './hash';
import type { CookContext, NodeDef, Registry } from './registry';
import type { OutputValues, Value } from './values';

/**
 * Node instances may predate params added to their def later (old documents,
 * hand-built graphs). Cook — and hash — with the def's defaults filled in,
 * so a missing param behaves exactly like one set to its default.
 */
function paramsWithDefaults(def: NodeDef, params: Record<string, ParamValue>): Record<string, ParamValue> {
  const merged: Record<string, ParamValue> = {};
  for (const spec of def.params) merged[spec.name] = spec.default;
  return { ...merged, ...params };
}

export interface CookEvent {
  nodeId: NodeId;
  type: string;
  status: 'hit' | 'miss';
  ms: number;
}

interface CacheEntry {
  nodeId: NodeId;
  outputs: OutputValues;
}

interface CookResult {
  outputs: OutputValues;
  hash: string;
}

export class Evaluator {
  /** cook log for the most recent evaluate() — HIT/MISS per node, loud on purpose */
  events: CookEvent[] = [];

  private entries = new Map<string, CacheEntry>(); // hash -> cached outputs
  private latestHash = new Map<NodeId, string>(); // nodeId -> hash from last evaluate

  constructor(private registry: Registry) {}

  async evaluate(graph: Graph, rootId: NodeId, ctx: CookContext): Promise<CookResult> {
    this.events = [];
    // per-evaluation memo so a diamond dependency cooks each node once
    const memo = new Map<NodeId, Promise<CookResult>>();
    const result = await this.cookNode(graph, rootId, ctx, memo);
    this.evictStale(ctx);
    return result;
  }

  /** Drop cache entries superseded by a newer hash for the same node, freeing their textures. */
  private evictStale(ctx: CookContext) {
    for (const [hash, entry] of this.entries) {
      if (this.latestHash.get(entry.nodeId) !== hash) {
        disposeOutputs(entry.outputs, ctx);
        this.entries.delete(hash);
      }
    }
  }

  private cookNode(
    graph: Graph,
    nodeId: NodeId,
    ctx: CookContext,
    memo: Map<NodeId, Promise<CookResult>>,
  ): Promise<CookResult> {
    const existing = memo.get(nodeId);
    if (existing) return existing;

    const promise = (async (): Promise<CookResult> => {
      const node = graph.nodes[nodeId];
      if (!node) throw new Error(`unknown node: ${nodeId}`);
      const def = this.registry.get(node.type);
      if (!def) throw new Error(`unknown node type: ${node.type}`);

      // 1. cook all upstream dependencies (in parallel where independent)
      const inputEdges = graph.edges.filter((e) => e.to.node === nodeId);
      const upstream = await Promise.all(
        inputEdges.map(async (e) => ({ edge: e, result: await this.cookNode(graph, e.from.node, ctx, memo) })),
      );

      // 2. assemble inputs; hash in deterministic socket order
      const inputs: Record<string, Value> = {};
      const inputHashes: string[] = [];
      upstream.sort((a, b) => a.edge.to.socket.localeCompare(b.edge.to.socket));
      for (const { edge, result } of upstream) {
        const value = result.outputs[edge.from.socket];
        if (value === undefined) {
          throw new Error(`${edge.from.node} has no output socket "${edge.from.socket}"`);
        }
        inputs[edge.to.socket] = value;
        inputHashes.push(`${edge.to.socket}:${result.hash}`);
      }

      // 2b. a half-wired graph should fail with a message, not a crash deep in a cook
      for (const spec of def.inputs) {
        if (!spec.optional && !(spec.name in inputs)) {
          throw new Error(`${node.type} (${nodeId}): input "${spec.name}" is not connected`);
        }
      }

      // 3. content hash → cache lookup. Frame-aware nodes hash the frame too,
      // so a frame change re-cooks exactly the nodes that read it; hashExtras
      // folds in any other ambient context the cook resolves (e.g. fonts).
      const params = paramsWithDefaults(def, node.params);
      const hashParams = {
        ...params,
        ...(def.usesFrame ? { '@frame': `${ctx.frame.width}x${ctx.frame.height}` } : undefined),
        ...def.hashExtras?.(params, ctx),
      };
      const hash = hashNode(node.type, hashParams, inputHashes);
      this.latestHash.set(nodeId, hash);
      const cached = this.entries.get(hash);
      if (cached) {
        this.events.push({ nodeId, type: node.type, status: 'hit', ms: 0 });
        return { outputs: cached.outputs, hash };
      }

      // 4. miss: run the actual work (await covers async/model nodes too)
      const t0 = performance.now();
      const outputs = await def.cook(inputs, params, ctx);
      this.entries.set(hash, { nodeId, outputs });
      this.events.push({ nodeId, type: node.type, status: 'miss', ms: performance.now() - t0 });
      return { outputs, hash };
    })();

    memo.set(nodeId, promise);
    return promise;
  }
}

// Ownership rule: a cache entry owns exactly the textures in its own
// raster/alpha outputs. Raster content embedded in elements is NOT owned —
// it belongs to the producing node's entry, and hash propagation guarantees
// producer and consumer entries are always evicted in the same pass.
function disposeOutputs(outputs: OutputValues, ctx: CookContext) {
  if (!ctx.gpu) return;
  for (const value of Object.values(outputs)) {
    if (value.kind === 'raster' || value.kind === 'alpha') {
      ctx.gpu.pool.release(value.texture);
    }
  }
}

/** Find the input edges wired into a node, keyed by input socket name. */
export function incomingEdges(graph: Graph, nodeId: NodeId): Edge[] {
  return graph.edges.filter((e) => e.to.node === nodeId);
}
