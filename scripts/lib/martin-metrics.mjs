/**
 * Robert C. Martin's component-coupling metrics.
 *
 * From *Agile Software Development, Principles, Patterns, and Practices* (2002)
 * and *Clean Architecture* (2017):
 *
 *   ADP  Acyclic Dependencies Principle -- the component graph is a DAG.
 *   SDP  Stable Dependencies Principle  -- depend in the direction of
 *        stability: I(dependency) <= I(dependent).
 *   SAP  Stable Abstractions Principle  -- a stable component is abstract:
 *        A + I ~= 1.
 *
 * where, for a component,
 *   Ca (afferent couplings)  = components that depend on it
 *   Ce (efferent couplings)  = components it depends on
 *   I  (instability)         = Ce / (Ca + Ce),  0 = maximally stable
 *   A  (abstractness)        = abstract surface / total surface
 *   D  (distance from the
 *       main sequence)       = |A + I - 1|,  0 = ideally balanced
 *
 * A component with I=0 and A=0 sits in the "zone of pain": rigid, concrete,
 * and depended upon. One with I=1 and A=1 sits in the "zone of uselessness".
 */

/**
 * @param {{name: string, deps: string[]}[]} components
 * @returns {Map<string, {ca: number, ce: number, instability: number}>}
 */
export function couplings(components) {
  const names = new Set(components.map((component) => component.name));
  const afferent = new Map(components.map((component) => [component.name, 0]));

  for (const component of components) {
    for (const dep of component.deps) {
      if (!names.has(dep)) continue; // external / third-party
      afferent.set(dep, afferent.get(dep) + 1);
    }
  }

  const metrics = new Map();
  for (const component of components) {
    const ce = component.deps.filter((dep) => names.has(dep)).length;
    const ca = afferent.get(component.name);
    metrics.set(component.name, {
      ca,
      ce,
      // A component with no couplings at all is stable by convention: nothing
      // can break it from outside, so I = 0 rather than 0/0.
      instability: ca + ce === 0 ? 0 : ce / (ca + ce),
    });
  }
  return metrics;
}

/**
 * ADP check: every dependency cycle in the component graph.
 *
 * Cycles are found as strongly connected components (Tarjan, O(V+E)) rather
 * than by enumerating paths -- on a wide DAG like `apps/gateway`, which
 * depends on some forty crates that also depend on each other, path
 * enumeration is exponential while the answer is almost always "no cycles".
 * Each SCC of more than one node, and each self-edge, is one ADP violation;
 * a concrete example path through it is recovered for the report.
 *
 * @returns {{members: string[], example: string[]}[]}
 */
export function cycles(components) {
  const edges = new Map(
    components.map((component) => [
      component.name,
      component.deps.filter((dep) => dep !== component.name),
    ]),
  );
  const selfEdges = components
    .filter((component) => component.deps.includes(component.name))
    .map((component) => ({
      members: [component.name],
      example: [component.name, component.name],
    }));

  const index = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const found = [];
  let counter = 0;

  // Iterative Tarjan: the graph is shallow but recursion depth is not a thing
  // worth betting a merge gate on.
  const strongConnect = (origin) => {
    const work = [{ node: origin, edge: 0 }];
    while (work.length > 0) {
      const frame = work.at(-1);
      const { node } = frame;
      if (frame.edge === 0) {
        index.set(node, counter);
        lowlink.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);
      }
      const neighbours = edges.get(node) ?? [];
      if (frame.edge < neighbours.length) {
        const next = neighbours[frame.edge];
        frame.edge += 1;
        if (!edges.has(next)) continue; // external / third-party
        if (!index.has(next)) {
          work.push({ node: next, edge: 0 });
        } else if (onStack.has(next)) {
          lowlink.set(node, Math.min(lowlink.get(node), index.get(next)));
        }
        continue;
      }
      work.pop();
      const parent = work.at(-1)?.node;
      if (parent !== undefined) {
        lowlink.set(parent, Math.min(lowlink.get(parent), lowlink.get(node)));
      }
      if (lowlink.get(node) === index.get(node)) {
        const members = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          members.push(member);
        } while (member !== node);
        if (members.length > 1) {
          members.sort();
          found.push({ members, example: examplePath(members, edges) });
        }
      }
    }
  };

  for (const name of [...edges.keys()].sort()) {
    if (!index.has(name)) strongConnect(name);
  }
  return [...selfEdges, ...found].sort((a, b) =>
    a.members[0].localeCompare(b.members[0]),
  );
}

/** One concrete cycle through an SCC, for a report a human can act on. */
function examplePath(members, edges) {
  const inScc = new Set(members);
  const start = members[0];
  const previous = new Map();
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length > 0) {
    const node = queue.shift();
    for (const next of edges.get(node) ?? []) {
      if (!inScc.has(next)) continue;
      if (next === start) {
        const back = [];
        for (let at = node; at !== start; at = previous.get(at)) back.push(at);
        back.push(start);
        back.reverse();
        return [...back, start];
      }
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, node);
      queue.push(next);
    }
  }
  return [...members, members[0]];
}

/**
 * SDP violations: an edge that points from a more stable component to a less
 * stable one. Depending on something more likely to change than you are is how
 * a change ripples backwards through a system.
 */
export function sdpViolations(components, metrics) {
  const violations = [];
  for (const component of components) {
    const from = metrics.get(component.name);
    for (const dep of component.deps) {
      const to = metrics.get(dep);
      if (to === undefined) continue;
      if (to.instability > from.instability) {
        violations.push({
          from: component.name,
          to: dep,
          fromInstability: from.instability,
          toInstability: to.instability,
        });
      }
    }
  }
  return violations.sort(
    (a, b) =>
      b.toInstability -
      b.fromInstability -
      (a.toInstability - a.fromInstability),
  );
}

/**
 * D = |A + I - 1|, the SAP distance from the main sequence.
 *
 * Undefined for a component with no couplings at all: I is 0/0 there, so the
 * formula would score every isolated leaf package a maximally-distant 1.00 and
 * bury the components that are genuinely out of balance. Those return null and
 * are reported as "n/a" rather than ranked.
 *
 * @returns {number|null}
 */
export function mainSequenceDistance(abstractnessValue, { ca, ce }) {
  if (ca + ce === 0) return null;
  return Math.abs(abstractnessValue + ce / (ca + ce) - 1);
}
