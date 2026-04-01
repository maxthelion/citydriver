## 038 Precommit Boundary Endpoint Join

This builds on `037`.

`036` could reconnect borrowed-phase cross streets only after a `txn-parallel`
rejection. `037` strengthened the phase model by injecting explicit borrowed
boundary offsets, but it still left some clean near-miss seams when a cross
street committed successfully without quite meeting the neighboring endpoint.

### Change

For borrowed-phase sectors using shared-boundary snap points:

1. keep the explicit borrowed sweep offsets from `037`
2. before committing a cross street, check whether one endpoint is already near
   a neighboring shared-boundary endpoint
3. if so, snap that endpoint onto the neighboring endpoint before the first
   transaction attempt
4. still keep the `txn-parallel` retry path from `036` as a fallback

### Goal

- catch visually obvious near-miss seams even when the street would otherwise
  commit cleanly
- make borrowed-phase sectors feel more like continuous through-roads across
  sector boundaries
