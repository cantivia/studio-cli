import type { LayoutNode, Pane } from './types';
import { uid } from './api';

export function panes(node: LayoutNode): Pane[] {
  return node.type === 'pane' ? [node.pane] : [...panes(node.a), ...panes(node.b)];
}

export function findPane(node: LayoutNode, id: string): Pane | undefined {
  return panes(node).find((p) => p.id === id);
}

export function mapPane(node: LayoutNode, id: string, fn: (p: Pane) => Pane): LayoutNode {
  if (node.type === 'pane') return node.pane.id === id ? { type: 'pane', pane: fn(node.pane) } : node;
  return { ...node, a: mapPane(node.a, id, fn), b: mapPane(node.b, id, fn) };
}

export function splitPane(node: LayoutNode, id: string, dir: 'row' | 'col', pane: Pane): LayoutNode {
  if (node.type === 'pane') {
    if (node.pane.id !== id) return node;
    return { type: 'split', id: uid(), dir, ratio: 0.5, a: node, b: { type: 'pane', pane } };
  }
  return { ...node, a: splitPane(node.a, id, dir, pane), b: splitPane(node.b, id, dir, pane) };
}

/** Removes a pane; its sibling takes the parent split's place. Returns null if it was the last pane. */
export function removePane(node: LayoutNode, id: string): LayoutNode | null {
  if (node.type === 'pane') return node.pane.id === id ? null : node;
  const a = removePane(node.a, id);
  const b = removePane(node.b, id);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

export function setRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.type === 'pane') return node;
  if (node.id === splitId) return { ...node, ratio };
  return { ...node, a: setRatio(node.a, splitId, ratio), b: setRatio(node.b, splitId, ratio) };
}

export const terminalPane = (cwd: string, command: string | null = null): Pane => ({
  id: uid(),
  kind: 'terminal',
  termId: null,
  cwd,
  command,
});

/** Equal-width chain of nodes along one axis. */
function chain(nodes: LayoutNode[], dir: 'row' | 'col'): LayoutNode {
  if (nodes.length === 1) return nodes[0];
  return { type: 'split', id: uid(), dir, ratio: 1 / nodes.length, a: nodes[0], b: chain(nodes.slice(1), dir) };
}

/** Lays panes out as an even grid: 2 side by side, 4 as 2×2, 6 as 3×2, and so on. */
export function gridLayout(list: Pane[]): LayoutNode {
  const cols = Math.ceil(Math.sqrt(list.length));
  const rows: LayoutNode[] = [];
  for (let i = 0; i < list.length; i += cols) {
    rows.push(chain(list.slice(i, i + cols).map((pane) => ({ type: 'pane', pane }) as LayoutNode), 'row'));
  }
  return chain(rows, 'col');
}
