# Autoresearch Ideas

## GPU / Performance

- **GPU influence layer computation (box blur)** — `computeInfluenceLayers` takes 135ms/tick on CPU, is the #2 growth tick bottleneck. A separable box blur on GPU using workgroup shared memory sliding-window should take <5ms. This would also eliminate the ~7ms dynamic layer upload per tick (influence layers could stay on GPU between compose calls). Requires implementing GPU blur + wiring it into `GPUValueLayersSession`. Medium complexity.

- **GPU allocation** — `allocateAgents` takes ~370ms/tick and is the #1 bottleneck. The BFS cell-claiming algorithm is hard to directly parallelize, but a parallel scan or prefix-sum based approach could work. High complexity.

- **Async pipeline overlap** — while the GPU runs `composeAllValueLayers` for tick N, the CPU could be doing allocation work from tick N-1's results. Requires double-buffering the value layer output and restructuring the growth tick loop. Medium complexity. Would hide GPU latency behind CPU work.

- **f16 dynamic layers** — f16 halves upload bandwidth (14.4MB vs 28.8MB), but JS Float16Array element-wise conversion currently costs 6.7ms, exceeding the 4.3ms upload savings. Becomes viable if: (a) computeInfluenceLayers returns Float16Array natively, (b) WebAssembly SIMD conversion, or (c) a GPU-based f32→f16 kernel runs between influence computation and value composition.

- **Skip fully-capped zones** — once an agent type (e.g. industrial) hits its budget cap mid-run, stop computing its value layer entirely. Saves compute + output buffer bandwidth for that zone for all remaining ticks. Easy to implement; benefit grows with number of ticks.

- **Reduce cold-start penalty** — the first tick of each GPUValueLayersSession uploads all 12 layers (69MB → ~42ms). Could pre-upload static spatial layers during session `create()` if they're available then, so the first compose() call only pays for dynamic layers.

## Pipeline

- **Generator-based pipeline** — replace LandFirstDevelopment state machine with generator functions and PipelineRunner with hook array. Spec in wiki/pages/pipeline-abstraction.md.

- **Planned growth strategy** — grid towns need roads-first growth (roads → identify blocks → assign uses), inverted from organic. Spec in wiki/pages/pipeline-abstraction.md.

- **Invariant checking hooks** — implement bitmap invariant checks (water ∩ roads = ∅ etc.) as PipelineRunner hooks firing after every named step. Spec in wiki/pages/bitmap-invariants.md.

## Tests

- **Speed up slow integration tests** — prepareCityScene, LandFirstDevelopment, plotPlacement all use cellSize=200 → 1200×1200 city grid (16× larger than needed for correctness testing). Switching to cellSize=50 would drop test time from ~80s to ~5s with no coverage loss. Keep one explicitly-marked slow test for production-scale regression.
