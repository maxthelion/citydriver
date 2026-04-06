# 054 — Vector Frontage With Civic Park

This follows `053`.

`053` deliberately stripped the problem back to one clean commercial edge:

- one dominant frontage span
- one smooth service road behind it
- perpendicular parcel cuts
- sparse real access roads

`054` adds the next missing civic element on top of that baseline:

- a single central park polygon
- a ring road around that park
- a connector back into the frontage/service-road system

The important constraint is that the park is still treated as **vector truth**.

The grid is only used to search for a viable siting and reject obviously bad
placements. Once chosen, the park is represented as:

- a real park polygon
- real planned park roads
- a real connector road

This is still intentionally narrower than the older micro-allocation branch:

- no residual ribbon fill
- no terrace collar
- no commercial cell painting

The question here is not "can we finish the whole sector yet?"

It is:

> If we combine one clean frontage system with one clean civic insertion, do
> they still read as a coherent piece of urban structure?

If this works, then later experiments can derive residual polygons from these
roads and parcels rather than going back to grid-first leftover filling.
