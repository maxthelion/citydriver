# 053 — Clean Vector Frontage Baseline

This is a deliberate reset after `050`–`052`.

Those experiments found the right ideas, but they were still trapped inside a
large mixed renderer and still partially anchored on cell-painted thinking.

`053` keeps only the pieces we actually trust so far:

1. **vector frontage spans are the source of truth**
2. **commercial parcels are polygons built from those spans**
3. **the back road is a real planned road polyline**
4. **parcel cuts are perpendicular to the frontage**
5. **parcel cadence is finer than access-road cadence**
6. **corner noise is reduced by trimming frontage ends geometrically**

It is intentionally narrower than the recent micro-allocation experiments:

- no park
- no civic insertions
- no residual ribbon fill
- no attempt to solve the whole sector in one pass

The purpose is to answer a simpler question first:

> If we zoom into one commercial edge, does the frontage, the road behind it,
> and the parcel rhythm look like something we could plausibly keep refining
> toward plot-level urban form?

This experiment is the baseline for the next stage.

If it reads cleanly, later experiments can reintroduce:

- park polygons
- terrace bands
- residual residential blocks

but on top of this vector-first frontage model rather than the older
grid-canonical micro-allocation path.
