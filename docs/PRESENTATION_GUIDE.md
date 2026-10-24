# AuraFarming: Demo and Presentation Guide

As-built snapshot: 23 October 2026. Audience: team demo, slides and speaker preparation.

For scientific methods, trade-offs and the decision history, read [RESEARCH_AND_DECISIONS.md](RESEARCH_AND_DECISIONS.md).
This guide describes implemented behavior, not every feature proposed in the original [PLAN.md](PLAN.md).

## 1. The Two-Minute Story

> AuraFarming is a crop-rotation decision-support prototype. It combines long-term NASA weather, mapped soil,
> the farmer's crop history and their priorities to compare what to plant next and possible two-year rotations.
> It shows trade-offs in income, water, soil health and failure risk rather than promising one universally best crop.
>
> Creating an account does not download satellite or weather data. Adding a farm supplies the location that starts
> ingestion. Nearby farms share a weather-cell cache, but soil and vegetation are requested at the farm's coordinates.
> The farmer can correct the soil assumptions and record crops, dates, irrigation and residue management.
>
> We simulate candidate plans across historical weather windows and show distributions and failure counts.
> These are scenario results, not weather forecasts or guaranteed yields. Crop recommendations currently require
> the India crop pack; the architecture allows more region packs later.
>
> We found inconsistent upstream weather responses during QA. Instead of silently trusting them, we validate annual
> checkpoints and keep suspect observations quarantined. Planning can now remain available with a Low confidence tag:
> it uses checked historical data and an explicitly disclosed prior-year weather scenario for recent conditions.
> The information icon explains exactly what was substituted. Field validation is still needed before operational use.

## 2. What Is Ingested

| Input | Source and coverage | Spatial / temporal meaning | Purpose |
| --- | --- | --- | --- |
| Daily weather and modelled soil wetness | NASA POWER, requested from 1 January 1981 through the current UTC date | Point requests at a snapped 0.5 degree latitude by 0.625 degree longitude cell; daily LST values | Climate analysis; rain, temperature and ET0 inputs for simulation |
| Monthly rainfall and land evaporation | NASA POWER monthly endpoint, same history | Monthly mean daily rates, converted to monthly totals for checking | Consistency reference for daily downloads, not independent validation |
| Soil profile | ISRIC SoilGrids, 8 properties at 6 depths | Static mapped prediction at farm coordinates | Texture, water-holding capacity, SOC, soil chemistry; farmer can override |
| Vegetation history | ORNL DAAC MODIS MOD13Q1 NDVI, all available dates from around 2000 onward | One 250 m pixel, 16-day composites | Approximate growing-season timing and vigour; suggestions for journal dates |
| Crop knowledge | Versioned species and India YAML files in the repository | Crop traits, sowing windows, succession rules, indicative prices and costs | Parameterise simulations and explain constraints; not downloaded at signup |
| Farmer information | Forms | Location, optional boundary and area, irrigation, soil overrides, journal, priorities | Personalise the model; not automatically inferred crop identities |
| Basemap and place search | OpenStreetMap tiles and Nominatim search from the browser | Navigation and location selection | Locate a farm; not an agronomic model input |

### All 17 Daily POWER Variables

| Variables | Meaning | Units used / interpretation |
| --- | --- | --- |
| `T2M`, `T2M_MAX`, `T2M_MIN`, `T2MDEW` | Mean, maximum, minimum and dew-point air temperature | Degrees Celsius |
| `RH2M` | Relative humidity | Percent |
| `PRECTOTCORR` | Corrected precipitation | mm/day |
| `ALLSKY_SFC_SW_DWN`, `CLRSKY_SFC_SW_DWN` | All-sky and clear-sky shortwave radiation | MJ/m2/day |
| `ALLSKY_SFC_PAR_TOT` | Photosynthetically active radiation | MJ/m2/day, not W/m2 |
| `WS2M` | Wind speed at 2 m | m/s |
| `GWETTOP`, `GWETROOT`, `GWETPROF` | Modelled surface, root-zone and profile wetness | Relative indices, not measured mm of plant-available water |
| `EVPTRNS` | Evapotranspiration energy flux | MJ/m2/day; not the app's FAO-56 ET0 |
| `EVLAND` | Land evaporation | mm/day; also used in ingestion validation |
| `PS` | Surface pressure | kPa |
| `TS` | Surface skin temperature | Degrees Celsius |

Not all retained variables directly drive crop yield. The engine primarily uses rain, maximum temperature and
reference evapotranspiration calculated from weather. It does not convert `GWETROOT` directly into plant-available water.
No weather forecast, live market feed, SMAP, GPM, HLS, EVI band or MODIS quality band is currently ingested.

SoilGrids properties: bulk density (`bdod`), cation-exchange capacity (`cec`), clay, nitrogen, pH in water (`phh2o`),
sand, silt and organic carbon (`soc`). Depths: 0-5, 5-15, 15-30, 30-60, 60-100 and 100-200 cm.
The response's unit conversion factor is applied before storage. Rootable depth and effective soil parameters are
then derived separately; six fetched depths do not mean every crop roots to 2 m.

## 3. Exactly When Work Happens

| Event | Environmental downloads | Local computation / stored changes |
| --- | --- | --- |
| Create account | None | Validate input, hash password, create user and session |
| Login / open My farms | None | Authenticate; read farm summaries and readiness |
| Move a map pin / draw boundary | Basemap tiles; place search only when submitted | Select coordinates; calculate polygon centre and area |
| Submit Add farm | Queue soil/weather build and vegetation task | Store farm, snap weather cell, assign supported region |
| Farm build: soil | Request SoilGrids only if that farm has no stored profile | Save converted layers and summary; failure permits a labelled default |
| Farm build: weather | Reuse a fresh verified cell, otherwise monthly checks and annual daily downloads | Checkpoint valid years; publish complete verified dataset atomically |
| Farm build: satellite | Request available dates and missing NDVI chunks | Save partial progress and then completion |
| Open farm detail | No automatic POWER download | Read farm and source status; mounted views request their own derived results |
| Open Plan / change season or irrigation | None | Simulate or reuse a cached run; compare and rank |
| Move priority sliders | None | Reuse expensive simulations when cached; recalculate the ranking |
| Edit soil or crop journal | None | Persist user values; invalidate affected results and recompute on access |
| Farm Refresh data | Queue soil/weather build again | Resume checkpoints; existing soil profile is retained, not forcibly re-fetched |
| Open Crop history / request vegetation | May resume pending/partial satellite download or fetch stale composites | Smooth NDVI and describe detected seasons |
| Satellite refresh / resume | Queue missing satellite chunks | Reuse saved observations; retry error state explicitly |
| Save plan | None | Store result snapshot, inputs, weights, engine version and weather provenance |
| Password-reset request | No environmental data; SMTP attempted only if configured | Generic account-private response; development mode does not claim email delivery |

**Task ordering:** farm creation returns before background work completes. In the current FastAPI background-task
list, soil/weather is queued before vegetation and tasks from that response execute in order. They are not a durable
distributed queue. Other requests can independently queue satellite work; process-local guards avoid duplicate jobs.
Within an NDVI download, three worker threads fetch chunks concurrently.

### Weather Reuse and Refresh Rules

1. A verified cell no more than 4 days behind is reused when a build is requested.
2. Otherwise, the build requests POWER monthly rainfall and evaporation for the historical span.
3. It processes calendar years sequentially. Each successfully checked year is committed as a checkpoint.
4. Historical checkpoints with the current validation version are reused before the refresh boundary.
5. The boundary is the calendar year containing today minus 60 days. Entire affected years are refreshed, not
   literally only 60 daily rows. Near New Year, this can mean two years.
6. An annual response that fails validation is retried using month-sized daily requests and checked again.
7. The full series is replaced only when all required years pass. Failure preserves old blobs and good checkpoints.
8. A later refresh resumes rather than discarding completed historical downloads.

There is no nightly scheduler and simply opening a farm does not trigger a POWER refresh. The 4-day threshold is a
cache-reuse rule during a build, not an automatic refresh timer. Monthly checks come from the same provider and do
not prove station-level weather accuracy.

### Satellite Rules

- Request at most 10 consecutive composite dates per call, scheduling missing chunks newest-first.
- Use up to 3 concurrent requests per process; commit progress every 3 completed chunks and at the end/error.
- On vegetation access, resume pending/partial records if no local job is running.
- A completed record is eligible for lazy refresh when its newest observation is more than 24 days old and the
  last update is more than a day old. A failed record has an explicit retry path.
- Newest-first scheduling does not guarantee completion order under concurrency.
- Historical timing was roughly 30 seconds per ORNL request and around 11 minutes for about 612 composites.
  These are observations, not a service guarantee. The current validated weather workflow has no fixed completion SLA.

## 4. When Does the App Show Ready?

| State | Actual meaning | What can be used |
| --- | --- | --- |
| Preparing / pending | Weather is being downloaded or validated and a fallback is not yet available | Journal and soil; saved plans remain readable |
| Ready | Farm build completed with a published, verified weather revision | Climate, crop fit and Plan where a crop pack exists; satellite may still be downloading |
| Low confidence / API `limited` | Weather is not verified, but at least 30 consecutive checked complete years through last December exist and a crop pack is available | Plan: next crop, rotations, comparisons, stress tests and saved plans; journal and soil |
| Needs attention / error | Build failed and there is not enough eligible checked history, or the region has no advice pack | Journal, soil and existing saved plans; refresh/retry as appropriate |

Readiness is not scientific validation. A Ready farm can still have a Medium confidence recommendation because the
India pack is unvalidated or soil/journal assumptions remain. Low confidence is not a numerical uncertainty interval.

Weather, soil and satellite each show their own status. Soil can be available from the farmer, from SoilGrids, or as
a standard estimate. Satellite completion is not a prerequisite for planning: suggestions only affect simulation
after the farmer records them in the journal. Advice is unavailable for regions without a supported crop pack.

**Polling is not ingestion:** the farm detail polls while pending (2 seconds), farm list while any farm is pending
(3 seconds), source status every 5 seconds, and vegetation every 10 seconds while downloading. These mostly read local
state; the vegetation route can also queue a resume as described above.

## 5. What Low Confidence Means Now

This mode was explicitly approved after the initial decision to block all advice during failed weather verification.

- The stored suspect weather is still quarantined. There is no blanket division by 24.
- Advice reads only annual checkpoints that passed the active validation version.
- For the current year up to yesterday, it uses matching calendar days from the most recent checked complete year.
  February 29 uses February 28 of the reference year. The reference year must be last year, not an arbitrarily old one.
- The farmer's recent journal is replayed against that weather scenario to initialise next-crop soil water.
- Substituted days are excluded from historical outcome windows. Trial counts can therefore be smaller than the
  number of checked calendar years, especially for a rabi crop that crosses December.
- The tag and information control show why confidence is low, the checked-through date, reference year and replaced dates.
- Saved plans retain this context even after verified weather later becomes available; they never silently become
  fully verified results. Regenerate a plan to obtain a new result.
- Climate and Crop fit remain protected until verified weather is available. The Plan tab is deliberately opened
  independently and is the default landing tab for a limited farm.

Demo wording: **"This is a historical-weather planning scenario, not an assessment of today's actual field moisture."**
The prior year can be unusually wet or dry; it is not asserted to be the typical year or a forecast.

## 6. Suggested Eight-Slide Deck

| Slide | On-screen content | Speaker emphasis |
| --- | --- | --- |
| 1. Problem | Crop sequence, uncertain weather, competing farm priorities | A single crop recommendation hides trade-offs and carry-over effects |
| 2. Inputs | NASA POWER + SoilGrids + MODIS + farmer journal + crop pack | Different resolutions and update rates; not all satellite measurements |
| 3. Farm onboarding | Account -> farm location -> ingestion -> status | Signup alone does not download 45 years of data |
| 4. Model | Weather -> ET0/water balance -> yield/rules/carbon -> ranking | Transparent deterministic models, not a trained predictive AI model |
| 5. Personalisation | Previous crop, soil, irrigation and four priorities | Changing a real constraint differs from changing a ranking preference |
| 6. Live Plan demo | Next crop, exact failures, rotation comparison, saved plan | Scores are relative; inspect losses and failure counts first |
| 7. Data quality | Annual checks, checkpoints, low-confidence information icon | Availability with explicit limitations, not silent correction |
| 8. Evidence and next work | Automated checks, observed data defect, field evaluation plan | Software correctness is not agronomic effectiveness |

## 7. Seven-Minute Demo Runbook

1. Before the meeting, start the API and frontend using [README.md](../README.md). Use a prepared India farm with
   checked history. Do not rely on a full new satellite download completing during the presentation.
2. Show My farms and open the farm. Explain the current badge before showing recommendations.
3. Open the Low confidence information control. State the checked dates and the historical substitution clearly.
4. Show the Soil tab. Explain the effective source; a farmer override takes precedence over the mapped estimate.
5. Show Crop history. Explain that a recorded Fallow is evidence of an empty field, while missing history causes a
   default-practice assumption. Satellite-derived dates are suggestions, not crop identification.
6. Return to Plan. Show the scenario soil-water label, a candidate's yield range, exact failure count and income.
   Do not present a comparative score as the probability of success.
7. Change a priority, then an irrigation option. Describe ranking changes versus changes in simulated water supply.
   Do not select irrigation merely to make the demonstration look favourable to a rain-fed farmer.
8. Open Two-year rotations, compare alternatives and current practice, and run one stress test.
9. Save a plan and show that its warning persists. Finish with limitations and the field-evaluation roadmap.

If every crop is unsuitable, show that result honestly. It is a meaningful model outcome, not a UI failure or a
reason to lower the failure threshold. No option is promised to be profitable or safe.

### Useful Answers to Likely Questions

| Question | Answer |
| --- | --- |
| Is this a forecast? | No. Historical weather trials and explicit perturbation scenarios, with a prior-year state proxy when recent data fails. |
| Is NASA giving the recommendation? | No. NASA supplies environmental data; AuraFarming's own models and rules produce the recommendation. |
| Does a drawn boundary improve weather resolution? | No. It stores location and area; weather still uses one coarse cell, vegetation one pixel. |
| Does the satellite know the crop? | No. NDVI suggests timing and vigour. The farmer supplies crop identity. |
| Is 100 the safest crop? | No. Relative scores depend on the candidate set; tied/singleton comparisons are not shown as perfect. |
| Do we download all data for every user? | No. Weather is shared per cell; ingestion begins with the farm location, not the account. |
| Why not just divide rainfall by 24? | Some cells were already correct and recent errors persisted even in short requests. A universal rescale would corrupt good data. |
| Is soil water measured? | No. It is modelled; in limited mode even its recent weather input is a disclosed scenario. |
| Can we claim higher farm income? | Not yet. Independent field/yield and economic evaluation has not been performed. |
| What is AI here? | The implemented recommender is a transparent simulation-and-rules system. No LLM or trained ML predictor runs the advice. |

## 8. Current Evidence and Boundaries

The local audit retained 225 checked annual checkpoints: 1981-2025 across five cells. Recent 2026 POWER evaporation
still failed screening, including a one-day response. Warangal's checked 2024 rainfall was 1,112.89 mm versus
26,709.36 mm in the previous suspect blob; two other cells' totals already matched. This is ingestion evidence,
not an estimate of prediction accuracy. Original data and a pre-migration SQLite backup were preserved.

The new low-confidence path has tests for suspect-blob exclusion, insufficient/gapped history, leap-day mapping,
cache revisions, historical-window cutoffs, confidence propagation, rotations, stress tests and saved-plan warnings.
The original audit and prior test counts are recorded chronologically in [QA-2026-10-23.md](QA-2026-10-23.md).
Use the latest measured test count in that report, not an earlier slide or status paragraph.

Open work: agronomist review, independent weather and yield validation, real SMTP delivery, deployed Neon/HTTPS,
native-language review, accessibility and physical-device GPS testing. A successful local demo does not establish
production readiness. Dates on screen follow the actual backend UTC clock, which can differ from local calendar date.

## 9. Code Map for Presenter Follow-Up

| Topic | Owning implementation |
| --- | --- |
| Registration, no environmental downloads | [auth.py](../backend/app/routers/auth.py) |
| Create, refresh, source status and limited readiness | [farms.py](../backend/app/routers/farms.py) |
| Soil/weather build ordering | [farm_data.py](../backend/app/services/farm_data.py) |
| Annual cache, validation state, advice proxy | [climate_cache.py](../backend/app/services/climate_cache.py) |
| Refresh defaults | [config.py](../backend/app/config.py) |
| Satellite scheduling/resume | [vegetation.py](../backend/app/services/vegetation.py) |
| Client polling and invalidation | [hooks.ts](../frontend/src/api/hooks.ts) |
| Low-confidence information control | [WeatherConfidence.tsx](../frontend/src/features/plan/WeatherConfidence.tsx) |