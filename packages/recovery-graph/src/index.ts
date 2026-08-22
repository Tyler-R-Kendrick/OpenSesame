import {
  type JsonValue,
  isBoolean,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

export type RecoveryNodeKind =
  | "account"
  | "device"
  | "mailbox"
  | "phone"
  | "password_manager"
  | "passkey"
  | "hardware_key"
  | "recovery_code"
  | "trusted_contact";

export type RecoveryEdgeKind =
  | "authenticates"
  | "recovers"
  | "stores"
  | "delivers_second_factor"
  | "requires";

export interface RecoveryNode {
  id: string;
  kind: RecoveryNodeKind;
  displayName: string;
  independentRoot: boolean;
}

/** Edges point from a dependent node to the node it needs. */
export interface RecoveryEdge {
  from: string;
  to: string;
  kind: RecoveryEdgeKind;
}

export interface RecoveryGraph {
  nodes: readonly RecoveryNode[];
  edges: readonly RecoveryEdge[];
}

export type RecoveryGraphIssueCode =
  | "invalid_graph"
  | "invalid_node"
  | "invalid_edge"
  | "duplicate_node"
  | "duplicate_edge"
  | "unknown_node"
  | "empty_value"
  | "value_too_long"
  | "too_many_nodes"
  | "too_many_edges";

export interface RecoveryGraphIssue {
  code: RecoveryGraphIssueCode;
  path: string;
  message: string;
}

export interface RecoveryGraphValidation {
  valid: boolean;
  graph: RecoveryGraph | null;
  errors: readonly RecoveryGraphIssue[];
}

export interface StronglyConnectedComponent {
  id: number;
  nodeIds: readonly string[];
}

export type RecoveryCycleKind = "benign_redundancy" | "hard_recovery_cycle";

export interface RecoveryCycle {
  component: StronglyConnectedComponent;
  kind: RecoveryCycleKind;
  reason: "independent_root_present" | "recovery_dependency_without_root";
}

export interface CycleAnalysis {
  components: readonly StronglyConnectedComponent[];
  cycles: readonly RecoveryCycle[];
}

export interface ArticulationAnalysis {
  articulationPointIds: readonly string[];
  bridgeEdges: readonly { from: string; to: string }[];
}

export interface IndependentRootAnalysis {
  independentRootIds: readonly string[];
  terminalComponentIds: readonly number[];
  selectedRootIds: readonly string[];
  uncoveredTerminalComponentIds: readonly number[];
  /** One root is necessary for each terminal dependency component. */
  minimumIndependentRootCount: number;
}

const NODE_KINDS = new Set<string>([
  "account",
  "device",
  "mailbox",
  "phone",
  "password_manager",
  "passkey",
  "hardware_key",
  "recovery_code",
  "trusted_contact",
]);
const EDGE_KINDS = new Set<string>([
  "authenticates",
  "recovers",
  "stores",
  "delivers_second_factor",
  "requires",
]);
const MAX_NODES = 10_000;
const MAX_EDGES = 50_000;
const MAX_VALUE_LENGTH = 200;

type RecoveryGraphInput =
  | JsonValue
  | {
      readonly nodes: readonly RecoveryNode[];
      readonly edges: readonly (RecoveryEdge | undefined)[];
    };

function isNodeKind(value: JsonValue | undefined): value is RecoveryNodeKind {
  return isString(value) && NODE_KINDS.has(value);
}

function isEdgeKind(value: JsonValue | undefined): value is RecoveryEdgeKind {
  return isString(value) && EDGE_KINDS.has(value);
}

function issue(
  errors: RecoveryGraphIssue[],
  code: RecoveryGraphIssueCode,
  path: string,
  message: string,
): void {
  errors.push({ code, path, message });
}

/** Parse and normalize user-declared graph data without mutating the input. */
export function validateRecoveryGraph(
  input: RecoveryGraphInput,
): RecoveryGraphValidation {
  // SAFETY: RecoveryGraph is already the same JSON-shaped boundary represented by JsonValue; callers supply either form.
  const raw = input as JsonValue;
  const errors: RecoveryGraphIssue[] = [];
  if (
    !isJsonObject(raw) ||
    !Array.isArray(raw.nodes) ||
    !Array.isArray(raw.edges)
  ) {
    return {
      valid: false,
      graph: null,
      errors: [
        {
          code: "invalid_graph",
          path: "",
          message: "expected nodes and edges arrays",
        },
      ],
    };
  }
  if (raw.nodes.length > MAX_NODES)
    issue(errors, "too_many_nodes", "nodes", "too many nodes");
  if (raw.edges.length > MAX_EDGES)
    issue(errors, "too_many_edges", "edges", "too many edges");

  const nodes: RecoveryNode[] = [];
  const nodeIds = new Set<string>();
  for (const [index, value] of raw.nodes.entries()) {
    const path = `nodes[${index}]`;
    if (!isJsonObject(value)) {
      issue(errors, "invalid_node", path, "expected an object");
      continue;
    }
    const { id, kind, displayName, independentRoot } = value;
    if (!isString(id) || id.length === 0)
      issue(errors, "empty_value", `${path}.id`, "id is required");
    else if (id.length > MAX_VALUE_LENGTH)
      issue(errors, "value_too_long", `${path}.id`, "id is too long");
    else if (nodeIds.has(id))
      issue(errors, "duplicate_node", `${path}.id`, "node id is duplicated");
    if (!isNodeKind(kind))
      issue(errors, "invalid_node", `${path}.kind`, "unknown node kind");
    if (!isString(displayName) || displayName.trim().length === 0)
      issue(
        errors,
        "empty_value",
        `${path}.displayName`,
        "displayName is required",
      );
    else if (displayName.length > MAX_VALUE_LENGTH)
      issue(
        errors,
        "value_too_long",
        `${path}.displayName`,
        "displayName is too long",
      );
    if (!isBoolean(independentRoot))
      issue(
        errors,
        "invalid_node",
        `${path}.independentRoot`,
        "independentRoot must be boolean",
      );
    if (
      isString(id) &&
      id.length > 0 &&
      id.length <= MAX_VALUE_LENGTH &&
      !nodeIds.has(id)
    ) {
      nodeIds.add(id);
      if (
        isNodeKind(kind) &&
        isString(displayName) &&
        displayName.trim() &&
        isBoolean(independentRoot)
      ) {
        nodes.push({
          id,
          kind,
          displayName,
          independentRoot,
        });
      }
    }
  }

  const edges: RecoveryEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const [index, value] of raw.edges.entries()) {
    const path = `edges[${index}]`;
    if (!isJsonObject(value)) {
      issue(errors, "invalid_edge", path, "expected an object");
      continue;
    }
    const { from, to, kind } = value;
    if (!isString(from) || !nodeIds.has(from))
      issue(
        errors,
        "unknown_node",
        `${path}.from`,
        "from must reference a known node",
      );
    if (!isString(to) || !nodeIds.has(to))
      issue(
        errors,
        "unknown_node",
        `${path}.to`,
        "to must reference a known node",
      );
    if (!isEdgeKind(kind))
      issue(errors, "invalid_edge", `${path}.kind`, "unknown edge kind");
    if (
      isString(from) &&
      isString(to) &&
      nodeIds.has(from) &&
      nodeIds.has(to) &&
      isEdgeKind(kind)
    ) {
      const key = `${from}\0${to}\0${kind}`;
      if (edgeKeys.has(key))
        issue(errors, "duplicate_edge", path, "edge is duplicated");
      else {
        edgeKeys.add(key);
        edges.push({ from, to, kind });
      }
    }
  }
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) =>
    `${a.from}\0${a.to}\0${a.kind}`.localeCompare(
      `${b.from}\0${b.to}\0${b.kind}`,
    ),
  );
  return {
    valid: errors.length === 0,
    graph: errors.length === 0 ? { nodes, edges } : null,
    errors,
  };
}

function adjacency(graph: RecoveryGraph): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const node of graph.nodes) result.set(node.id, []);
  for (const edge of graph.edges) result.get(edge.from)?.push(edge.to);
  for (const neighbors of result.values()) neighbors.sort();
  return result;
}

export function stronglyConnectedComponents(
  graph: RecoveryGraph,
): readonly StronglyConnectedComponent[] {
  const next = adjacency(graph);
  const indexByNode = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let index = 0;
  const visit = (node: string): void => {
    indexByNode.set(node, index);
    lowLink.set(node, index++);
    stack.push(node);
    onStack.add(node);
    for (const neighbor of next.get(node) ?? []) {
      if (!indexByNode.has(neighbor)) {
        visit(neighbor);
        lowLink.set(
          node,
          Math.min(lowLink.get(node) ?? 0, lowLink.get(neighbor) ?? 0),
        );
      } else if (onStack.has(neighbor)) {
        lowLink.set(
          node,
          Math.min(lowLink.get(node) ?? 0, indexByNode.get(neighbor) ?? 0),
        );
      }
    }
    if (lowLink.get(node) === indexByNode.get(node)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member) {
          onStack.delete(member);
          component.push(member);
        }
      } while (member !== node);
      components.push(component.sort());
    }
  };
  for (const node of [...next.keys()].sort())
    if (!indexByNode.has(node)) visit(node);
  components.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
  return components.map((nodeIds, id) => ({ id, nodeIds }));
}

export function analyzeCycles(graph: RecoveryGraph): CycleAnalysis {
  const components = stronglyConnectedComponents(graph);
  const cycles: RecoveryCycle[] = components.flatMap(
    (component): RecoveryCycle[] => {
      const memberIds = new Set(component.nodeIds);
      const hasSelfLoop = graph.edges.some(
        (edge) => edge.from === edge.to && memberIds.has(edge.from),
      );
      if (component.nodeIds.length < 2 && !hasSelfLoop) return [];
      const hasRoot = graph.nodes.some(
        (node) => memberIds.has(node.id) && node.independentRoot,
      );
      const hasRecoveryDependency = graph.edges.some(
        (edge) =>
          memberIds.has(edge.from) &&
          memberIds.has(edge.to) &&
          ["recovers", "requires", "delivers_second_factor"].includes(
            edge.kind,
          ),
      );
      const hard = !hasRoot && hasRecoveryDependency;
      const kind: RecoveryCycleKind = hard
        ? "hard_recovery_cycle"
        : "benign_redundancy";
      const reason: RecoveryCycle["reason"] = hard
        ? "recovery_dependency_without_root"
        : "independent_root_present";
      return [{ component, kind, reason }];
    },
  );
  return { components, cycles };
}

export function findArticulationPoints(
  graph: RecoveryGraph,
): ArticulationAnalysis {
  const neighbors = new Map(
    graph.nodes.map((node) => [node.id, new Set<string>()]),
  );
  for (const edge of graph.edges) {
    if (edge.from !== edge.to) {
      neighbors.get(edge.from)?.add(edge.to);
      neighbors.get(edge.to)?.add(edge.from);
    }
  }
  const discovery = new Map<string, number>();
  const low = new Map<string, number>();
  const points = new Set<string>();
  const bridges: { from: string; to: string }[] = [];
  let time = 0;
  const visit = (node: string, parent: string | undefined): void => {
    discovery.set(node, time);
    low.set(node, time++);
    let children = 0;
    for (const neighbor of [...(neighbors.get(node) ?? [])].sort()) {
      if (!discovery.has(neighbor)) {
        children++;
        visit(neighbor, node);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(neighbor) ?? 0));
        if (
          parent !== undefined &&
          (low.get(neighbor) ?? 0) >= (discovery.get(node) ?? 0)
        )
          points.add(node);
        if ((low.get(neighbor) ?? 0) > (discovery.get(node) ?? 0)) {
          bridges.push({
            from: node < neighbor ? node : neighbor,
            to: node < neighbor ? neighbor : node,
          });
        }
      } else if (neighbor !== parent)
        low.set(
          node,
          Math.min(low.get(node) ?? 0, discovery.get(neighbor) ?? 0),
        );
    }
    if (parent === undefined && children > 1) points.add(node);
  };
  for (const node of [...neighbors.keys()].sort())
    if (!discovery.has(node)) visit(node, undefined);
  bridges.sort((a, b) =>
    `${a.from}\0${a.to}`.localeCompare(`${b.from}\0${b.to}`),
  );
  return { articulationPointIds: [...points].sort(), bridgeEdges: bridges };
}

export function calculateIndependentRoots(
  graph: RecoveryGraph,
): IndependentRootAnalysis {
  const components = stronglyConnectedComponents(graph);
  const outgoing = new Map(
    components.map((component) => [component.id, false]),
  );
  const componentByNode = new Map(
    components.flatMap((component) =>
      component.nodeIds.map((node) => [node, component.id] as const),
    ),
  );
  for (const edge of graph.edges) {
    const from = componentByNode.get(edge.from);
    const to = componentByNode.get(edge.to);
    if (from !== undefined && to !== undefined && from !== to)
      outgoing.set(from, true);
  }
  const terminal = components.filter(
    (component) => !outgoing.get(component.id),
  );
  const roots = graph.nodes
    .filter((node) => node.independentRoot)
    .map((node) => node.id)
    .sort();
  const selectedRootIds = terminal.flatMap((component) =>
    graph.nodes
      .filter(
        (node) => node.independentRoot && component.nodeIds.includes(node.id),
      )
      .map((node) => node.id)
      .sort()
      .slice(0, 1),
  );
  const uncovered = terminal
    .filter(
      (component) =>
        !selectedRootIds.some((root) => component.nodeIds.includes(root)),
    )
    .map((component) => component.id);
  return {
    independentRootIds: roots,
    terminalComponentIds: terminal.map((component) => component.id),
    selectedRootIds,
    uncoveredTerminalComponentIds: uncovered,
    minimumIndependentRootCount: terminal.length,
  };
}
