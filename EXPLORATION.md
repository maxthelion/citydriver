# Exploration Philosophy

This project is built through a cycle of specification, construction, observation, and consolidation.

## The Cycle

### 1. Specify
Take what we know about the system — what it should do, how the underlying processes work, how we debug it — and write it down in a spec. The spec captures the current best understanding: proven algorithms, tuned constants, architectural decisions, and open questions.

### 2. Build
Build according to the spec. The spec is the blueprint. Code should implement what the spec describes, not invent new approaches ad hoc.

### 3. Explore
Run the built system. Use the debug viewer to watch it work. Try different seeds, parameters, edge cases. The goal is to learn things that weren't obvious from the spec — how the generative processes actually behave, where the algorithms break down, what produces good results and what doesn't.

This phase creates a mess. Code gets patched, parameters get tweaked, experiments get half-finished. That's expected. The mess is the cost of learning.

### 4. Observe
While exploring, write down what you learn. Observations go in `specs/vN/observations.md`. These are concrete findings: "A* with reuse discount produces spaghetti because it follows existing roads instead of creating grid structure." Not aspirational goals — things you've actually seen.

### 5. Consolidate
At some point the observations accumulate enough that the current code is more patch than design. The spec no longer describes what the code does. The code works but the architecture has drifted.

This is when you consolidate:
- Take all the observations and codify them into a new spec
- Capture the proven constants, algorithms, and data structures (the stuff that took iteration to get right)
- Identify what worked, what didn't, and what the open questions are
- Bump the version number
- Delete the messy code
- Rebuild from the new spec

The new version starts cleaner but carries forward everything learned. The cycle repeats.

## Why delete and rebuild

It's tempting to refactor the existing code instead of rewriting. But generative systems accumulate a specific kind of debt: coordination complexity between subsystems. After enough exploration, every module has been patched to work around surprises in every other module. The patches are correct but the architecture is accidental.

Rebuilding from a spec that captures the *learnings* (not the patches) produces cleaner code in less time than untangling the mess. The spec is the distilled knowledge. The old code is the scaffolding that produced it.

## Version history

- **V1-V2**: Initial terrain, geology, basic city generation. Learned: causation must flow downward through layers.
- **V3**: Regional pipeline solidified. Road connectivity. Settlement placement. Learned: cities need neighborhoods as growth units, not top-down density fields.
- **V4**: Neighborhoods, nuclei, Union-Find MST, shared-grid anchor routes, river model, buildability grid, debug viewer. Learned: A* growth produces spaghetti; bitmap coordination needs to be automatic (FeatureMap); debug visibility is essential for algorithm development.
- **V5**: (current) Clean slate on city pipeline. FeatureMap architecture. Growth algorithm exploration. Carries forward: regional pipeline, river model, PlanarGraph, proven constants from technical-reference.md.
