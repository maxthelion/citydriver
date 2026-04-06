# 060 Boundary Park, Single Commercial Edge, Terraces, Then Residual Ribbons

This experiment keeps the vector-first structure from `059`:

- one attached civic park on the anchor road
- one strongest remaining commercial edge
- shallow residential terraces on the park side and rear roads

Then, instead of treating the remainder as already residential, it:

1. keeps the park, commercial, terrace parcels, and buyer roads as vector truth
2. derives residual polygons from those claims
3. rasterizes only those residual polygons into planning cells
4. fills the meaningful residual sectors with committed cross streets and ribbons

So this is deliberately a hybrid experiment:

- vector is the source of truth for reservations
- grid is only used as a planning artifact for the residual street fill

Questions:

- Does the residual fill read like it belongs to the park/commercial structure?
- Are the remaining areas large enough to justify ribbons at all?
- Does the hybrid boundary feel disciplined, or does it start to drag us back into cell-first planning?
