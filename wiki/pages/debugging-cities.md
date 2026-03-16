---
title: "Debugging Cities"
category: "functionality"
tags: [debugging, archetypes, growth-ticks, bitmap-layers, url-state]
summary: "How to inspect city generation by controlling archetype, tick, and bitmap lens via URL, including side-by-side comparison across archetypes."
last-modified-by: user
---

## Overview

The debugging workflow for cities centres on selecting an [[city-archetypes|archetype]], running growth ticks, and inspecting the results through different bitmap lenses. All of this state is encoded in the URL so that specific views can be linked and shared.

## URL State

The current view is fully described by the URL, including:

- **Archetype** — which city archetype is being applied
- **Tick** — which growth tick the city has been advanced to
- **Bitmap lens** — which layer (e.g. land reservation, buildability, land value) is being visualised

This means you can link directly to, say, tick 5 of the market town archetype viewed through the land reservation lens.

## Side-by-Side Comparison

Multiple views can be run side by side to compare:

- **Same city, different archetypes** — tick all archetypes to the same tick number and compare the results (e.g. land reservation at tick 5 across harbour, market town, and planned city)
- **Same archetype, different ticks** — see how a city evolves over successive growth ticks
- **Same city and tick, different lenses** — compare bitmap layers (e.g. buildability vs land value) for the same state

This is particularly useful for comparing land reservation patterns across archetypes for identical geography.

## Typical Workflow

1. Pick a city from the regional map
2. Select an archetype (or select several for side-by-side)
3. Advance to the desired tick
4. Choose a bitmap lens to inspect
5. Share the URL to reference a specific state
