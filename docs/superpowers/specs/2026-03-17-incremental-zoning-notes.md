# Incremental Zoning — Design Notes

Collected observations and ideas from initial prototyping (2026-03-17).

## 1. Ribbon integration

The existing ribbon street layout mechanism (layoutRibbons) works well for generating internal street networks within residential zones. Rather than running ribbons as a separate post-processing pass, the ribbon algorithm should be rolled into the residential growth tick itself — as residential zones expand, they should lay down streets incrementally rather than waiting until all growth is complete.

## 2. Avoid parallel paths with existing layers

The city already computes spatial layers (centrality, waterfrontness, roadFrontage, edgeness, downwindness, buildability, land value, slope, terrain suitability). The growth agent system should lean heavily on these rather than reimplementing spatial logic. Any agent behaviour that can be expressed as an affinity weight against an existing layer should be — not coded as a special case.

## 3. Industrial terrain requirements

Industrial zones need flatter terrain than residential because industrial plots are larger. The elevation difference across a typical industrial plot (say 50-100m wide) shouldn't be extreme. This could be expressed as a stronger `terrainSuitability` affinity weight for industrial agents, or a dedicated `flatness` layer computed at a scale appropriate to industrial plot sizes (larger blur radius than the existing slope-based suitability).

## 4. Industrial sub-types

Industrial shouldn't be a single zone type. Different industrial uses have very different spatial footprints:
- **Warehouses**: large plots with loading yards, space around them, near transport links
- **Small factories/workshops**: tighter plots, can be mixed into residential fringes
- **Heavy industry**: very large footprint, needs water/rail access, strong separation from residential
- **Docks/wharves**: waterfront-dependent, linear along quays

Each sub-type would have its own affinity weights and footprint parameters, similar to how residential was split into fine/estate/quality.

## 5. Bitmap pipeline debugging logger

Rather than stepping through pipeline ticks in the browser, it would be useful to have a central bitmap logger that pipeline steps can append to. Each entry would be a labelled bitmap (layer name + description) written during execution. The log could then be browsed as a sequence of images showing how the pipeline transforms data at each step. This would make it much easier to diagnose issues without the overhead of the interactive debug screen.

## 6. GPU-accelerated bitmap operations

Bitmap operations (box blur, composeMask, distance transforms, BFS floods) are the main performance bottleneck. Operations like the box blur in `computeLandValue` and `growthTick` run on the main thread and block the UI. Investigate using WebGL/WebGPU compute shaders for these operations — box blur and distance transforms are embarrassingly parallel and map well to GPU execution.

## 7. Automated pipeline experiments

Rather than manually inspecting renders, set up an automated experiment loop where:
1. Run the pipeline with given parameters
2. An agent examines the final reservation bitmap and reports problems (e.g. "commercial zone has no road access", "industrial zone overlaps waterfront residential", "90% of zone cells are unreserved")
3. Suggest parameter adjustments
4. Re-run and compare

Similar to a RALPH (Reinforcement Agent Learning from Pipeline Heuristics) loop or [autoresearch](https://github.com/karpathy/autoresearch) — using an LLM to evaluate output quality and iterate on parameters automatically.
