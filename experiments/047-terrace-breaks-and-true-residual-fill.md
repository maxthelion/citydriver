# 047 — Terrace Breaks And True Residual Fill

`046` proved two useful things:

- parks must behave as real barriers for residual street layout
- a continuous terrace collar around the park is too sealing

In Zone 1 especially, the terrace ring left the residual land fragmented into
thin wedges, which reduced good ribbon opportunities even though the park
crossing bug was fixed.

`047` changes two things:

1. park-edge terraces now have periodic breaks / access slots along each side
2. terrace cells are no longer treated as part of the residual-fill geometry

That means the residual street layout runs only over the actual leftover fill
land, while terraces remain a separate reserved frontage condition around the
park.

Buyer order:

1. `commercial/frontage-strip`
2. `civic/park`
3. `residential/park-edge-terrace` with periodic breaks
4. `residential/residual-fill`

What to look for:

- park remains a hard barrier for ribbons
- terrace frontage still reads clearly
- residual cross streets and ribbons recover in the broken-up sectors,
  especially Zone 1
