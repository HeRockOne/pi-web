import type { SessionInfo } from "./types";

export interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

/** Build the sidebar hierarchy: forks and subagents nest under their origin/parent. */
export function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const session of sessions) {
    byId.set(session.id, { session, children: [] });
  }

  const parentOf = new Map<string, string>();
  for (const session of sessions) {
    if (session.relation?.kind === "subagent") {
      parentOf.set(session.id, session.relation.parentSessionId);
    } else if (session.relation?.kind === "fork" && session.relation.originSessionId) {
      parentOf.set(session.id, session.relation.originSessionId);
    }
  }

  function resolveAncestor(id: string): string | null {
    let current = parentOf.get(id);
    let nearest: string | null = null;
    const visited = new Set([id]);
    while (current) {
      if (visited.has(current)) return null;
      visited.add(current);
      if (!nearest && byId.has(current)) nearest = current;
      current = parentOf.get(current);
    }
    return nearest;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) byId.get(ancestor)!.children.push(node);
    else roots.push(node);
  }

  const pending = [roots];
  while (pending.length > 0) {
    const nodes = pending.pop()!;
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    for (const node of nodes) pending.push(node.children);
  }
  return roots;
}

export interface SessionTreeRow {
  kind: "session";
  session: SessionInfo;
  /** Depth inside the tree (0 = top-level session of the project). */
  depth: number;
  hasChildren: boolean;
  /** True when this node is itself collapsed (present in collapsedIds). */
  collapsed: boolean;
  /**
   * Parent-chain tree depths whose vertical guide line runs through this row.
   * Used to draw the tree connection lines in the virtual-scrolled flat list.
   */
  guideLayers: number[];
  /**
   * Parent-chain tree depths whose guide line *ends* at this row (this is the
   * final visible descendant of that branch). The renderer draws a half line
   * plus an L-shaped connector instead of a full-length line.
   */
  tailLayers: number[];
}

/**
 * Flatten a session tree into a virtual-scroll friendly row list.
 * Iterative DFS preorder: a parent row always precedes its subtree rows.
 * Rows under a collapsed node are skipped entirely.
 */
export function flattenSessionTree(
  roots: SessionTreeNode[],
  collapsedIds: ReadonlySet<string>,
): SessionTreeRow[] {
  const rows: SessionTreeRow[] = [];
  type Frame = {
    node: SessionTreeNode;
    depth: number;
    lines: number[];
    tails: number[];
  };
  const stack: Frame[] = [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    stack.push({ node: roots[i], depth: 0, lines: [], tails: [] });
  }
  while (stack.length > 0) {
    const { node, depth, lines, tails } = stack.pop()!;
    const collapsed = collapsedIds.has(node.session.id);
    const hasChildren = node.children.length > 0;
    // A leaf has no subtree to carry its lines further: every line that runs
    // through it ends here (renderer draws the L-shaped connector).
    const guideLayers = hasChildren ? lines : [];
    const tailLayers = hasChildren ? tails : [...lines, ...tails];
    rows.push({
      kind: "session",
      session: node.session,
      depth,
      hasChildren,
      collapsed,
      guideLayers,
      tailLayers,
    });
    if (collapsed) continue;
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const isLast = i === children.length - 1;
      stack.push({
        node: children[i],
        depth: depth + 1,
        // A non-last sibling keeps every ancestor line running (own parent
        // line included); a last sibling hands its own line to its subtree.
        lines: isLast ? lines : [...lines, ...tails, depth],
        tails: isLast ? [...tails, depth] : tails,
      });
    }
  }
  return rows;
}
