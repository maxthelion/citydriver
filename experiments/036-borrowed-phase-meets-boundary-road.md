## 036 Borrowed Phase Meets Boundary Road

This builds on `035`.

`035` borrowed a modulo-`spacing` phase from neighboring cross-street endpoints on a shared boundary, but the resulting streets could still land *near* those roads instead of actually meeting them. In practice that created `txn-parallel` rejections in places like Zone 0 Sector 4.

### Change

For sectors using borrowed shared-boundary phase:

1. still infer the phase from the neighboring sector's boundary-facing street ends
2. also reuse those same boundary points as snap targets
3. when a borrowed-phase candidate gets close enough to one of those targets, force its nearest endpoint onto that exact boundary point

So this variant tries to make the new cross street *meet* the already-laid boundary road, rather than running almost parallel beside it.

### Goal

- reduce `txn-parallel` commit rejections caused by near-miss borrowed-phase streets
- make boundary-adjacent streets read more like through-roads across sector seams

