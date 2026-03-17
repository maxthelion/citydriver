---
title: "Progress Indicators"
category: "ui"
tags: [ux, loading, feedback, performance]
summary: "The need for progress modals during slow operations like city generation, tick advancing, and archetype comparison."
last-modified-by: user
---

## Problem

Many operations in the app take noticeable time but give no visual feedback. The user presses a button and nothing seems to happen — it's impossible to tell whether the app is working, stuck, or broken.

Examples:

- **Enter City** from the region screen — city setup and rendering can take several seconds with no indication anything is happening
- **Compare Archetypes screen** — advancing a tick regenerates all selected archetypes from scratch; the UI freezes with no feedback, making it look like the button is broken
- **Debug screen tick advancing** — similar delay when advancing through pipeline ticks on larger cities

## Desired Behaviour

Show a small modal overlay during any operation that blocks the UI for more than ~200ms. The modal should:

- Appear quickly (not wait for the full operation to finish)
- Show which step is currently running (e.g. "Setting up terrain...", "Computing land value...", "Reserving land use (portCity)...")
- Disappear automatically when the operation completes

This is especially important for the [[debugging-cities|compare archetypes screen]], where ticking multiple archetypes multiplies the wait time. Without feedback, it's ambiguous whether a tick change is a bug or just slow.

## Current State

No progress indicators exist. All generation and pipeline operations run synchronously on the main thread, blocking the UI entirely until complete.

## Considerations

- The pipeline is currently synchronous — showing progress would require breaking work into async chunks (e.g. `requestAnimationFrame` or `setTimeout` between steps) so the browser can repaint
- Each pipeline tick is a distinct named step (setup, skeleton, land value, zones, spatial layers, reservations, ribbons, connections) which maps naturally to progress messages
- The compare screen runs N archetypes × M ticks, so progress should ideally show which archetype is being processed
