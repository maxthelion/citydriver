/**
 * Derived-relation rules for querying the wiki intent graph.
 *
 * These are expressed as DataScript-style rule definitions that can be
 * evaluated by the query harness in query.js.
 *
 * Each rule is a plain object:
 *   { name, doc, head, clauses }
 *
 * The harness interprets them over the parsed fact database.
 */

/** Transitive dependency closure: A depends-on B (directly or transitively). */
export const transitiveDependency = {
  name: 'depends-on*',
  doc: 'True when concept A transitively depends on concept B.',
  head: ['?a', '?b'],
  // Base case: direct depends-on edge
  // Recursive case: A depends-on some C, and C depends-on* B
  evaluate(db) {
    const direct = new Map(); // conceptName -> Set<conceptName>
    for (const fact of db.facts) {
      if (fact.attr === ':rel/type' && fact.value === ':rel/depends-on') {
        const relId = fact.entity;
        const srcRef = db.resolve(relId, ':rel/source');
        const tgt = db.resolve(relId, ':rel/target');
        // Resolve source tempid to concept name
        const src = srcRef ? (db.resolve(srcRef, ':concept/name') ?? srcRef) : null;
        if (src && tgt) {
          if (!direct.has(src)) direct.set(src, new Set());
          direct.get(src).add(tgt);
        }
      }
    }

    // BFS transitive closure
    const closure = new Map();
    for (const [start] of direct) {
      const visited = new Set();
      const queue = [start];
      while (queue.length > 0) {
        const cur = queue.shift();
        for (const dep of direct.get(cur) ?? []) {
          if (!visited.has(dep)) {
            visited.add(dep);
            queue.push(dep);
          }
        }
      }
      if (visited.size > 0) closure.set(start, visited);
    }
    return closure;
  },
};

/**
 * Concepts affected by an invariant, via the dependency graph.
 * An invariant's source-page defines a concept; that concept plus all
 * concepts that transitively depend on it are "affected".
 */
export const conceptsAffectedByInvariant = {
  name: 'invariant-affects*',
  doc: 'Returns all concepts affected by a given invariant (via dependency graph).',
  head: ['?invariant-statement', '?affected-concept'],
  evaluate(db) {
    const depClosure = transitiveDependency.evaluate(db);
    const results = [];

    for (const fact of db.facts) {
      if (fact.attr !== ':invariant/statement') continue;
      const invId = fact.entity;
      const statement = fact.value;
      const sourcePage = db.resolve(invId, ':invariant/source-page');
      if (!sourcePage) continue;

      // Find the concept defined by this source page
      const concept = db.conceptByPage(sourcePage);
      if (!concept) continue;

      // The concept itself is affected
      results.push({ invariant: statement, concept: concept.name });

      // All concepts that depend on this concept are also affected
      for (const [depName, deps] of depClosure) {
        if (deps.has(concept.name)) {
          results.push({ invariant: statement, concept: depName });
        }
      }
    }
    return results;
  },
};

/**
 * Decisions that affect a concept (directly or via transitive dependency).
 */
export const decisionsAffectingConcept = {
  name: 'decision-affects*',
  doc: 'Returns all decisions that affect a concept, directly or transitively.',
  head: ['?concept', '?decision-summary'],
  evaluate(db) {
    const depClosure = transitiveDependency.evaluate(db);
    const results = [];

    for (const fact of db.facts) {
      if (fact.attr !== ':decision/summary') continue;
      const decId = fact.entity;
      const summary = fact.value;
      const affectsId = db.resolve(decId, ':decision/affects');
      if (affectsId == null) continue;

      const affectedName = db.resolve(affectsId, ':concept/name');
      if (!affectedName) continue;

      // Direct: this decision directly affects this concept
      results.push({ concept: affectedName, decision: summary });

      // Transitive: any concept that depends on the affected concept
      for (const [depName, deps] of depClosure) {
        if (deps.has(affectedName)) {
          results.push({ concept: depName, decision: summary });
        }
      }
    }
    return results;
  },
};

export const allRules = [
  transitiveDependency,
  conceptsAffectedByInvariant,
  decisionsAffectingConcept,
];
