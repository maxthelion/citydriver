## 035 Borrow Shared Boundary Phase

This variant changes cross-street seeding near shared sector boundaries.

Instead of:
- rephasing the whole sector from a boundary midpoint (`032`), or
- locally rotating individual streets toward nearby boundary endpoints (`033`), or
- anchoring the whole sector from one shared boundary point (`034`),

`035` borrows a phase from the neighboring sector that has already been laid.

### Idea

If a sector shares a substantial boundary with a neighboring sector, and the two sectors have similar gradient directions, then:

1. collect the neighboring cross-street endpoints that already land on that shared boundary
2. project those points onto this sector's contour axis
3. derive a shared modulo-`spacing` phase from those projected positions
4. lay this sector's cross-street sweep with that borrowed phase

That means we are borrowing the neighboring sector's street rhythm, not just one point.

### Expected Behavior

- cross streets should look more like they continue across the shared boundary
- the sector interior should keep a consistent sweep rhythm
- seam alignment should improve without the one-point brittleness of `034`

### Debugging

The cross-street failure view now also shows:

- rejected cross-street candidates
- pruned cross-street candidates
- missing scanlines where no final street survived

The event log also records these as:

- `street-rejected`
- `street-pruned`
- `scanline-no-street`

