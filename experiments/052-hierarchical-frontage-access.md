# 052 — Hierarchical Frontage Access

This follows `051`.

`051` improved the geometry of the parcel cuts by making them explicitly
perpendicular to the frontage. But it still treated every repeated cadence
along the frontage as if it were a road-access event.

That produced clutter:

- too many circles
- too many stubs
- too many tiny local road gestures near corners

The core mistake was conflating two different scales:

- **parcel rhythm** — how frontage land is subdivided into buildable strips
- **street access rhythm** — where actual access/stub roads should break the
  frontage system and connect into the land behind

`052` separates them:

1. the frontage is still represented as a smoothed span
2. parcel polygons are cut at a finer frontage cadence
3. real access gaps/stubs happen at a much coarser spacing
4. very short frontage spans near corners are suppressed instead of each
   becoming their own miniature road system

This is still a micro reservation experiment, but it is closer to the intended
hierarchy:

- parcels are frequent
- roads are comparatively sparse

The key question is whether this makes the frontage read like a coherent urban
edge instead of a noisy spray of micro-roads.
