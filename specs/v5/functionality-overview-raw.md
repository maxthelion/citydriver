# What's the process I'm trying to follow?

The overall goal is to have a pipeline of modifications that takes a seed and some variables and creates a realistic looking city. One of the insights that created this approach was that it's not possible to model the micro level realistically without imagining the macro that it sits within. Therefore:

* A region is created with geography (topology, water,  geology)
* The region is populated by settlements in locations deemed most valuable. 
* The settlements are connected together with roads. 

At a level higher than this, the railway network brings in concepts of where the region sits in an even larger context, imagining where cities might exist, and which ones are important (eg capital). I also imagined that we might do this for sea trade to determine whether a port was large. 

Some rivers come into the edges of the region that have accumulated elsewhere. The road network doesn't currently connect to the wider macro picture.

A macro concern that is not imagined at this stage is resources. This would traditionally shape what industry takes place in the region. Another variable that would affect a city is climate, both in terms of temperature and rainfall. This shapes the landscape, and also the buildings.

At the city level, we zoom in on a point on the region map and constrain to a smaller area with higher resolution. The goal is to populate the whole area with a series of roads, buildings and other features. This happens in stages:

1. The elevation data, rivers, railways, roads and settlements is imported from the region
2. Additional noise is added to terrain at higher granularity
3. The city is built according to a city archetype

The city archetypes are primarily designed to determine how the city is laid out, and how much land is given over to various purposes. Some archetypes are only suited to certain region conditions. Archetypes include: harbour, port, market town, industrial city, civil centre. They all have different rules about what order land is reserved for different uses. 

In addition to these archetypes, city age plays a factor in city layout. New cities built from scratch are likely to have planned layouts (grids, radial etc), while older cities are likely to be more organic. For many older cities, there are likely to be a number of local nuclei that grew simultaneously, and merged into a larger whole.

So assuming an oldish city with an organic pipeline, the pipeline at the city level would be as follows:

* Add nuclei to the city area in valuable [1] places
* Connect these nuclei together [2]
* Split the map into zones and sectors [3]

This is about as much as we have today. The following is an idealistic pipeline to get to the end state. We have yet to decide on ordering and when a thing happens. 

The general idea is that we want to divide up the whole city map so that the type of ownership of each bit of land is determined. An assumption about this is that land uses that requires large areas needs to be reserved in advance in our model. Once streets have subdivided everything, there is no room for it any more.

In reality, there are lots of competing forces, transactions about land ownership happen in many ticks over a long period of time.  Land use can change, it can split and it can merge. But roads tend to be quite permanent. We can't model all of that, we can only aim for approximate percentage coverage given over to different types.

There are some assumptions for how this might happen: 

* That some city archetypes will designate land for certain usage at zone/sector level
* That commercial real estate tends to stick to anchor roads
* That density is higher (plots are relatively smaller) where space is at a premium
* That land usage for non core types will be secondarily placed (eg industrial down wind)
* That different usage types value land differently
* That some civic uses need to be spread out evenly (parks, churches, cinemas, market squares)
* That in some archetypes, demand is determined dynamically by placement of other types (eg clustering around civic centers or industrial)

This means thinking about custom growth pipelines for different city archetypes, composed of various sub pipelines. 

My current thinking is that:

* We split into sectors as now
* We decided the macro reservation order based on the archetype
* The primary land use for the archetype makes a number of claims, then the other types make some claims up to a certain budget
* Repeat until the map is full

So for an industrial archetype, a growth tick might look like the following:

* Industrial reserves some sectors that are flat and near transport.
* Commercial reserves some plots along nearby streets
* Residential fills in a nearby sector and near the commercial

For a harbour, it might be that:

* Warehouses etc are near river frontage, favouring rail and road links
* Commercial goes nearby, but is mindful of what is useful to Warehouses etc
* Market squares appear nearby
* Industrial centres appear downwind and within easy reach of the port

For a market town:

* Commercial springs up near confluence of big roads, residential fills around it.
* Commercial spreads along roads
* Industrial down wind

This is partly based on assumption that residential will fill areas that aren't claimed for another purpose. But there will be a lot of variety based on plot size, proximity to industrial, elevation, sea views etc. This leads to a matrix of rich/poor, high/low density.

Civic would placed in each tick according to its own rules. Certain numbers of parks, churches etc.

The budget used at each point is interesting to consider too. To large, and things become too blocky. Too small and small allocations poison ability for large land reservations to be allocated.

We've been working on ribbon streets for residential. The end goal would be that this can fill an area around land reservations for different types. This suggests that residential might need to be late in the process, rather than laid down in each tick.

Some other points to consider:

* Water features: promenades. Beaches
* Rural plots like farms. 
* Where are train stations placed (and at what point in the process?)

The other questions are:  How do we build this? How can we create a modular and composeable system where we can experiment with each step in isolation? What are the pipeline steps? What are the contracts between each one? How does the output of one feed into the next?


Footnotes

1. Value is determined here by similar factors that placed regional settlements, proximity to water, large flat areas etc
2. Algo to be specified
3. These may be contradictory and duplicative
