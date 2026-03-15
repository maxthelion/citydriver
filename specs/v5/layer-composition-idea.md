# Layer Composition with Blend Modes (Future Idea)

Photoshop-style layer composition for spatial data. Each layer is a float32
grid with a blend mode and optional filter. Composites are built by folding
layers with blend operations rather than monolithic computation functions.

## The Model

```
Layer {
  grid:      Grid2D (float32)
  blendMode: 'add' | 'subtract' | 'multiply' | 'min' | 'max' | 'screen'
  weight:    Float (0-1)
  filter:    optional post-process (blur, threshold, clamp)
}

compose(layers) → Grid2D (float32)
```

## Example Recipes

```js
const landValue = compose([
  { grid: flatnessGrid,    blend: 'base',     weight: 0.6 },
  { grid: proximityGrid,   blend: 'add',      weight: 0.4 },
  { grid: waterDistGrid,   blend: 'add',      weight: 0.15, filter: threshold(0, 50) },
])

const buildable = compose([
  { grid: slopeScoreGrid,  blend: 'base' },
  { grid: edgeTaperGrid,   blend: 'multiply' },
  { grid: waterMask,       blend: 'subtract' },
  { grid: roadGrid,        blend: 'subtract' },
])
```

## Where It Helps

- **Land value**: already a composite of multiple spatial fields. Adding new
  contributors (road proximity, park bonus, institutional anchors) means
  adding a layer rather than editing a monolithic function.
- **Episodes**: an episode's spatial effect expressed as layer additions.
  Railway episode adds corridor layer (subtract buildability) and station
  proximity layer (add land value). Clean, diffable, replayable.
- **LLM integration**: named float layers with clear semantics are what you'd
  serialize as bitmaps for LLM input. The LLM sees decomposed layers rather
  than pre-baked composites.
- **Debugging**: "why is this cell high-value?" answered by inspecting
  per-layer contributions.

## Concerns

- **Pathfinding performance**: cost function sampled millions of times.
  Composing 5 layers per sample is too slow — must materialize composite
  grids before pathfinding.
- **Debuggability of blend interactions**: multiple blend modes interacting
  can be hard to reason about. Explicit composition functions are clearer
  until there are enough layers to justify the abstraction.
- **Premature**: the current work (reservations, archetypes) needs one new
  grid and one check. The framework earns its keep when 3-4 episodes are
  running and composition code becomes repetitive.

## When to Revisit

When the episode system is running and you find yourself writing repetitive
grid composition code across multiple episodes. That's when the abstraction
pays for itself.
