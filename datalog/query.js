#!/usr/bin/env node
/**
 * Minimal harness to load the wiki intent graph EDN and run queries.
 *
 * Usage:
 *   node datalog/query.js                         # print summary
 *   node datalog/query.js --concepts              # list all concepts
 *   node datalog/query.js --deps <concept>        # transitive dependencies
 *   node datalog/query.js --invariants <concept>  # invariants affecting concept
 *   node datalog/query.js --decisions <concept>   # decisions affecting concept
 *   node datalog/query.js --graph                 # full dependency graph (DOT)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  transitiveDependency,
  conceptsAffectedByInvariant,
  decisionsAffectingConcept,
} from './rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Minimal EDN parser — enough for our subset (vectors of :db/add datoms)
// ---------------------------------------------------------------------------

function parseEdn(text) {
  const facts = [];
  // Match [:db/add <entity> <attr> <value>] patterns
  const datumRe =
    /\[:db\/add\s+(-?\w+)\s+(:\S+)\s+("(?:[^"\\]|\\.)*"|:\S+|-?\d+(?:\.\d+)?)\s*\]/g;
  let m;
  while ((m = datumRe.exec(text)) !== null) {
    const entity = m[1];
    const attr = m[2];
    let value = m[3];
    if (value.startsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    facts.push({ entity, attr, value });
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Database wrapper
// ---------------------------------------------------------------------------

class FactDB {
  constructor(facts) {
    this.facts = facts;
    this._byEntity = new Map();
    for (const f of facts) {
      if (!this._byEntity.has(f.entity)) this._byEntity.set(f.entity, []);
      this._byEntity.get(f.entity).push(f);
    }
    this._conceptsByPage = null;
  }

  /** Resolve a single attribute value for an entity. */
  resolve(entity, attr) {
    const eid = typeof entity === 'number' || typeof entity === 'string'
      ? String(entity)
      : entity;
    const facts = this._byEntity.get(eid);
    if (!facts) return undefined;
    const f = facts.find((x) => x.attr === attr);
    return f ? f.value : undefined;
  }

  /** Get the concept defined on a given source page. */
  conceptByPage(page) {
    if (!this._conceptsByPage) {
      this._conceptsByPage = new Map();
      for (const f of this.facts) {
        if (f.attr === ':concept/source-page') {
          const name = this.resolve(f.entity, ':concept/name');
          if (name) this._conceptsByPage.set(f.value, { name, entity: f.entity });
        }
      }
    }
    return this._conceptsByPage.get(page);
  }

  /** List all concepts. */
  concepts() {
    return this.facts
      .filter((f) => f.attr === ':concept/name')
      .map((f) => ({
        name: f.value,
        summary: this.resolve(f.entity, ':concept/summary'),
        page: this.resolve(f.entity, ':concept/source-page'),
      }));
  }

  /** List all invariants. */
  invariants() {
    return this.facts
      .filter((f) => f.attr === ':invariant/statement')
      .map((f) => ({
        statement: f.value,
        confidence: this.resolve(f.entity, ':invariant/confidence'),
        page: this.resolve(f.entity, ':invariant/source-page'),
      }));
  }

  /** List all decisions. */
  decisions() {
    return this.facts
      .filter((f) => f.attr === ':decision/summary')
      .map((f) => ({
        summary: f.value,
        rationale: this.resolve(f.entity, ':decision/rationale'),
      }));
  }

  /** List all relationships. */
  relationships() {
    return this.facts
      .filter((f) => f.attr === ':rel/type')
      .map((f) => ({
        source: this.resolve(f.entity, ':rel/source'),
        target: this.resolve(f.entity, ':rel/target'),
        type: f.value,
      }))
      .map((r) => ({
        ...r,
        // Resolve source from tempid to concept name if it's a tempid reference
        source:
          r.source && this.resolve(r.source, ':concept/name')
            ? this.resolve(r.source, ':concept/name')
            : r.source,
      }));
  }
}

// ---------------------------------------------------------------------------
// Load all page EDN files
// ---------------------------------------------------------------------------

function loadDB() {
  const pagesDir = join(__dirname, 'pages');
  const files = readdirSync(pagesDir).filter((f) => f.endsWith('.edn'));
  const allFacts = [];
  for (const file of files) {
    const prefix = file.replace('.edn', '');
    const content = readFileSync(join(pagesDir, file), 'utf8');
    const facts = parseEdn(content);
    // Namespace entity tempids per file to avoid collisions
    for (const f of facts) {
      f.entity = `${prefix}/${f.entity}`;
      // If value looks like a tempid reference (e.g. -1), namespace it too
      if (/^-\d+$/.test(f.value)) {
        f.value = `${prefix}/${f.value}`;
      }
    }
    allFacts.push(...facts);
  }
  return new FactDB(allFacts);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const db = loadDB();

if (args[0] === '--concepts') {
  const concepts = db.concepts();
  console.log(`\n${concepts.length} concepts:\n`);
  for (const c of concepts) {
    console.log(`  ${c.name}`);
    console.log(`    ${c.summary}`);
    console.log(`    [${c.page}]\n`);
  }
} else if (args[0] === '--deps') {
  const name = args.slice(1).join(' ');
  const closure = transitiveDependency.evaluate(db);
  const deps = closure.get(name);
  if (deps) {
    console.log(`\nTransitive dependencies of "${name}":\n`);
    for (const d of deps) console.log(`  -> ${d}`);
  } else {
    console.log(`No dependencies found for "${name}".`);
  }
} else if (args[0] === '--invariants') {
  const name = args.slice(1).join(' ');
  const results = conceptsAffectedByInvariant.evaluate(db);
  const matching = results.filter((r) => r.concept === name);
  if (matching.length > 0) {
    console.log(`\nInvariants affecting "${name}":\n`);
    for (const r of matching) console.log(`  * ${r.invariant}`);
  } else {
    console.log(`No invariants found affecting "${name}".`);
  }
} else if (args[0] === '--decisions') {
  const name = args.slice(1).join(' ');
  const results = decisionsAffectingConcept.evaluate(db);
  const matching = results.filter((r) => r.concept === name);
  const seen = new Set();
  const unique = matching.filter((r) => {
    if (seen.has(r.decision)) return false;
    seen.add(r.decision);
    return true;
  });
  if (unique.length > 0) {
    console.log(`\nDecisions affecting "${name}":\n`);
    for (const r of unique) console.log(`  * ${r.decision}`);
  } else {
    console.log(`No decisions found affecting "${name}".`);
  }
} else if (args[0] === '--graph') {
  const rels = db.relationships();
  console.log('digraph wiki {');
  console.log('  rankdir=LR;');
  console.log('  node [shape=box, fontsize=10];');
  for (const r of rels) {
    const label = r.type.replace(':rel/', '');
    console.log(`  "${r.source}" -> "${r.target}" [label="${label}"];`);
  }
  console.log('}');
} else {
  // Summary
  const concepts = db.concepts();
  const invariants = db.invariants();
  const decisions = db.decisions();
  const rels = db.relationships();

  console.log('\n=== Wiki Intent Graph Summary ===\n');
  console.log(`  Concepts:      ${concepts.length}`);
  console.log(`  Relationships: ${rels.length}`);
  console.log(`  Decisions:     ${decisions.length}`);
  console.log(`  Invariants:    ${invariants.length}`);

  const highConf = invariants.filter((i) => i.confidence === ':high').length;
  const medConf = invariants.filter((i) => i.confidence === ':medium').length;
  const lowConf = invariants.filter((i) => i.confidence === ':low').length;
  console.log(`    (high: ${highConf}, medium: ${medConf}, low: ${lowConf})`);

  const relTypes = {};
  for (const r of rels) {
    relTypes[r.type] = (relTypes[r.type] || 0) + 1;
  }
  console.log('\n  Relationship types:');
  for (const [type, count] of Object.entries(relTypes).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`    ${type}: ${count}`);
  }
  console.log('');
}
