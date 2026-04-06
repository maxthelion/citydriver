# 048 — Real Buyer Roads And Residual Blocks

This is the step-back experiment.

Instead of treating park roads and service roads as painted constraint cells,
`048` promotes buyer-emitted roads into actual temporary roads inside the
experiment map:

- commercial service roads
- commercial access stubs
- park ring roads
- park connector roads

The goal is to inspect the residual blocks those roads create before asking the
generic cross-street / ribbon fillers to do more work.

So this experiment does **not** run the residual ribbon fill. It:

1. runs the buyer program
2. commits buyer roads via the normal road transaction path
3. derives connected residual blocks from the resulting road network plus
   reserved land
4. renders those blocks and the committed buyer roads explicitly

This should answer whether the micro buyer geometry is creating believable
street-bounded blocks at all, before we continue tuning ribbon behavior on top
of it.
