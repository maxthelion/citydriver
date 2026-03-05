# A6 Settlements — Observations

File: `src/regional/generateSettlements.js`

## What it does now

Single-pass scored site selection:
1. Scores every land cell on flatness, river access, fertile hinterland,
   coast proximity, harbor/bay features, spring line, defensive terrain
2. Picks top-scoring cells with minimum spacing (default 20 grid cells)
3. Assigns tiers by rank order: first = tier 1, next 2 = tier 2, rest = tier 3
4. Classifies type by site characteristics (estuary, harbor, crossing, hilltop,
   confluence, spring)

Max settlements defaults to 8, min spacing 20 cells (1000m at 50m cellSize).

## Problems

- Only 8 settlements on a 256x256 grid (12.8km x 12.8km) is very sparse
- No awareness of connectivity between settlements
- Tier assigned by rank order, not by function or relationships
- No concept of smaller habitations (farms, hamlets) that fill the landscape
- The city pipeline (B4 arterials) has to invent structure to fill empty space
  because there are no intermediate settlements to route through

## Satellite settlement types

Satellites aren't a single category — the reason for a settlement determines
what attracts it:

- **Farms/hamlets** — driven almost entirely by land quality (fertile soil,
  flat, water access). Weak or no road attraction. These exist whether or
  not a road passes nearby.
- **Market towns** — strong road attraction, especially at junctions or along
  arterials between two larger settlements. They exist *because* of the road.
- **Industrial/resource sites** — attracted to specific geology (quarries,
  mills at river confluences). Road attraction is moderate — they need access
  but location is resource-driven.
- **Suburban expansion** — strong attraction to both the parent settlement
  and roads leading out of it. Cluster along arterial corridors close to
  the parent.

This means a single `hubGravity` bonus isn't sufficient. The satellite pass
should pick a *reason* based on what opportunities exist, then score
accordingly. A fertile valley far from any road still gets a farm. A spot
where two arterials cross gets a market town regardless of soil quality.

Farms and resource sites don't need roads to exist first, so they could be
placed before A7. Market towns and suburban expansion need roads, so they
come after. This suggests two sub-passes or an iterative approach.
