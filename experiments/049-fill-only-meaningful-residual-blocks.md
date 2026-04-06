# 049 — Fill Only Meaningful Residual Blocks

This follows `048`.

`048` showed that once buyer-emitted roads are committed as real roads, the
leftover land is not one simple residual sector. It becomes a mix of:

- one or two substantial residual areas
- many tiny raster scraps around corners and edges

Those scraps are not useful street-fill targets.

`049` keeps the same buyer-road-first approach:

1. commit commercial service roads, stubs, and park roads as real temporary
   roads
2. derive residual connected components from the resulting network
3. ignore tiny residual components below a size threshold
4. run cross streets and ribbons only inside the substantial residual areas

This is meant to test whether the street-fill step becomes more coherent once
it only acts on meaningful leftover blocks rather than every little fragment.
