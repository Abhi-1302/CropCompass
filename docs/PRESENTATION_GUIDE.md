# CropCompass: Demo and Presentation Guide

As-built snapshot: 24 October 2026. Audience: team demo, slides and speaker preparation.

For scientific methods, trade-offs and the decision history, read [RESEARCH_AND_DECISIONS.md](RESEARCH_AND_DECISIONS.md).
This guide describes implemented behavior, not every feature proposed in the original [PLAN.md](PLAN.md).

For the live walkthrough, jump to [the click-and-speak script](#7-click-and-speak-demo-script).
For remaining functionality, see [the MVP gap check](#10-mvp-gap-check-against-the-initial-plan).
This revision is a source-checked script, not evidence of a successful hosted-browser rehearsal.

## 1. The Two-Minute Story

> CropCompass is a crop-rotation decision-support prototype. It combines long-term NASA weather, mapped soil,
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

## 7. Click-and-Speak Demo Script

Target: 10-12 minutes, excluding loading delays and questions. English UI labels below match the current source.
Use the quoted text as speaker notes, not as extra text to add to the application. Read bracketed values from the
screen; do not say the brackets or reuse historical numbers from section 14 of the original plan.
Password reset is not part of this presentation or the requested first deployed-browser test pass.

### 7.1 Prepare Before the Meeting

1. Use a dedicated demo account and demo farms. Do not edit a real farmer's soil or journal for presentation effect.
2. In the deployed app, create an India farm in advance: **My farms > Add farm > Telangana, India**.
  Set **Farm name** to `Telangana demo`, **Area (hectares, optional)** to `1`, and **Water available** to **Rain-fed**;
  click **Create farm**. The preset uses latitude 17.0, longitude 78.125. This is an illustrative location, not a
  claim that a specific real field is represented. Existing local SQLite farms do not automatically appear in Neon.
3. Wait for **Ready** or **Low confidence** and confirm **Plan > What to sow next** and **Two-year rotations** load.
  Low confidence requires at least 30 consecutive checked full years through last December. If there is not enough
  history, no live recommendation demo is ready yet. Resume an interrupted build with **Refresh data** before the
  meeting, not repeatedly during it. Do not bypass verification to force a green status.
4. Open **Crop history** beforehand to allow satellite history to load/resume. Prefer a farm with a visible NDVI
  chart. Record whether a **Log this season** suggestion is available; it is optional, not guaranteed.
5. Prepare two or three prior seasons if you want a journal-derived rotation baseline. Use clearly labelled example
  records on this demo farm only. For the live edit below, prepare soybean with sowing 15 June 2026 and harvest
  20 September 2026, **Harvested**, **Intercrop (optional): None**, and notes `Illustrative demo record`.
  Leave unknown yield, irrigation count, residue, disease and herbicide fields blank. These dates fit the October
  2026 rehearsal; for later presentations choose completed dates appropriate to that date. Do not overlap records
  or present these illustrative values as observations from the satellite or a farmer.
6. Rehearse the **Rabi** next-crop screen and note the actual year displayed. If it has no viable options, retain
  that warning in the story and rehearse **Kharif** as a separate future-season example. Never promise a particular
  crop, rank, profit or failure count in advance. Make a note of the scenario/verified badge and source dates.
7. Prepare one saved next-crop plan and one saved rotation as a fallback, labelled by their existing automatic titles.
  Keep screenshots of this deployment's actual results, with date and confidence visible. Screenshots are a labelled
  fallback, not evidence that a failed live request succeeded. Keep the presenter notes in a separate window.
8. Start the live walkthrough signed in at **My farms**, with **Language** set to **English**, at a comfortable zoom.
  Warm the hosted API shortly before presenting; a free host can sleep or restart. Keep credentials, environment
  files, personal account data and provider dashboards off the shared screen.

### 7.2 Main Walkthrough

#### Scene 1 | 0:00-0:35 | The Farmer's Question

**Click / show:** Stay on **My farms**. Point at the prepared `Telangana demo` farm without opening it yet.

**Say:** "A farmer is not only choosing a crop. They are balancing income, available water, soil health and the
risk of a failed season. CropCompass lets them compare those trade-offs using NASA weather, soil maps and their
own crop history. It is decision support, not a guarantee or a weather forecast."

#### Scene 2 | 0:35-1:10 | Where the Farm Data Comes From

**Click / show:** Click **Add farm**, then **Telangana, India** under **Or try a demo location**. Point at the pin,
coordinates, area and **Water available**. Optionally select **Draw the field** and click three distinct corners
to show the calculated area. Do not click **Create farm** in the main presentation. Click **Back to my farms**.

**Say:** "The location connects the field to environmental data. A farmer can use coordinates, a pin or a drawn
boundary. Creating the farm starts the downloads, not creating the account. The boundary records the field and
its area; it does not turn coarse NASA weather into field-scale measurements. I prepared a farm earlier so we
can spend our time on the decisions instead of waiting for downloads."

**Wait / fallback:** If map tiles or search fail, point to Latitude and Longitude. Do not spend the demo debugging
the map. The Telangana preset fills the coordinates without requiring a place-search result.

#### Scene 3 | 1:10-1:55 | Explain Data Quality First

**Click / show:** Open `Telangana demo`. Point to the **Weather**, **Soil** and **Satellite** status row.
If the farm says **Low confidence**, click the small information icon in the amber message; its tooltip is
**Why is confidence low?** Read the checked-through date, reference year and substituted date range.

**Say, for Low confidence:** "These sources have separate readiness states. Recent weather failed our checks,
so the app has not quietly accepted it. Planning uses checked historical years and weather from the reference
year shown here for the recent starting-state scenario. This is not today's measured soil moisture. We keep
that limitation visible in the recommendations and in saved plans."

**Say, for Ready instead:** "The weather passed our ingestion checks through the date shown here. That is data
consistency checking, not proof that our crop model is accurate on this field. The soil and satellite inputs
have their own status, and the crop parameters still need local validation."

**Wait / fallback:** If neither verified weather nor limited advice is available, show the preparation status
honestly, then use a prepared alternative farm or a labelled saved-result screenshot. Do not promise a refresh
will finish in seconds. Keep **Refresh data** and **Delete farm** untouched during the main demo.

#### Scene 4 | 1:55-2:35 | The Farmer Can Correct the Soil

**Click / show:** Click **Soil**. Point at **Soil used by the models** and its source badge. Click **Edit soil**.
Open **Soil type** and **Soil depth (to rock or hard layer)**; point to texture, water held, organic carbon and pH.
Click **Cancel** to retain the rehearsed assumptions.

**Say:** "A soil map is an estimate, so the farmer's knowledge can take precedence. These values affect water
storage and subsequent simulations. The form supports soil type, depth, texture, water holding, carbon and pH.
It is not yet a complete N-P-K Soil Health Card or a fertiliser prescription. I am keeping the prepared values
unchanged so the comparisons later use a consistent baseline."

**Optional save demonstration:** On the disposable demo farm only, save a rehearsed hypothetical change with
**Save soil**, wait for the **Your values** badge, and say it is an assumed scenario, not a lab result. Rehearse
the downstream recommendations again if you change this baseline; do not invent soil measurements live.

#### Scene 5 | 2:35-3:25 | Satellite Suggestions and Farmer History

**Click / show:** Click **Crop history**. Point to **Your field from space** and hover a visible NDVI peak.
If available, click **Log this season** in **Seasons the satellite saw**. Point to the estimated dates and the
unselected **Main crop**, then click **Cancel**. Scroll to **Season journal** and click **Edit** beside the
prepared soybean record. Append `Reviewed during demo` in **Notes (optional)**, then click **Save season**.
Wait for the dialog to close and the note to appear in the row.

**Say:** "MODIS gives us greenness for a 250-metre pixel. It suggests when vegetation grew, not which crop was
planted. The farmer confirms the crop, dates and management. This soybean record is illustrative demo data.
The journal influences previous-crop rules, field availability and the simulated soil-water starting point.
Recorded fallow is different from missing history: missing information may require an explicit default assumption."

**If no record exists:** Use **Add season**, choose **Main crop: Soybean**, leave **Intercrop (optional): None**,
select **Harvested**, enter the prepared dates, select **Kharif (monsoon)**, add the illustrative note and click
**Save season**. Skip this variant if it would overlap an existing record. If the satellite is still downloading,
show its progress and continue with the journal; advice does not require complete NDVI history.

#### Scene 6 | 3:25-4:35 | Interpret a Next-Crop Option

**Click / show:** Click **Plan**, then **What to sow next**. Select **Rabi** for the October rehearsal; read the
year in the heading. Wait until **Updating...** disappears and faded results become fully visible. Point to
**Scenario soil water (not observed)** if present, then the first ranked crop and its confidence information.

**Say:** "We start with the modelled soil state and replay checked historical weather windows. For this crop,
the displayed best sowing date is [date]. Its simulated yield spans [bad-year yield] to [good-year yield], and
it failed in [k] of [n] historical trials. Failure means below half the crop's attainable yield, not necessarily
zero harvest. These are historical scenario frequencies, not a forecast probability for this coming season."

**Click / show:** Point to **Comparative score**, the four pillar bars and a visible reason or crop-rule warning.

**Say:** "The score compares these options under the selected priorities; it is not a safety percentage.
Read the failure count and any loss warning before the ranking. The reasons explain the trade-offs and
carry-over constraints rather than just giving one unexplained recommendation."

**No-options branch:** Say, "Under these assumptions, the model does not find a reliable crop for this season.
That is a result we need to show, not hide." Then, if rehearsed, select **Kharif** and explicitly say this is a
different future-season question. Never change irrigation silently to make the results look better.

#### Scene 7 | 4:35-5:15 | Change What Matters to the Farmer

**Click / show:** Scroll to **Your priorities**. Set **Income** and **Saving water** to `1`, **Soil health** and
**Low risk** to `5`. Use the sliders and verify the numbers beside their labels. Wait for ranking updates, then
click **Save as my priorities** if enabled; wait for **Saved for this farm**. Revisit the ranked options.

**Say:** "Now I am changing the decision preference: soil health and lower risk matter more. This changes how
the results are ranked; it does not change the underlying weather history. If the leading crop stays the same,
that is also valid. We compare the displayed scores and trade-offs rather than promising that every slider
movement must produce a different winner. These preferences can be saved for this farm."

#### Scene 8 | 5:15-5:55 | Separate Preference from Water Supply

**Click / show:** In **Your priorities**, change **Water** from **Rain-fed** to **Protective irrigation**.
Wait for the result update, point to the new failure and yield figures, then switch back to **Rain-fed** and wait.

**Say:** "This is a different kind of change. Protective irrigation changes the simulated water available,
not just how we rank crops. It assumes limited irrigation is actually possible. I am returning to the rain-fed
baseline; we should not recommend water the farmer does not have. This dropdown explores a planning scenario,
not a permanent change to the farm's stored water setting."

#### Scene 9 | 5:55-6:25 | Make the Economics Inspectable

**Click / show:** In **What to sow next**, scroll to **Prices and costs used**, below the options and Stress test.
Click **Show**. Point to **Price per kg**, **Price source** and **Cost per ha (without nitrogen)**.

**Say:** "Income estimates depend on assumptions we make visible. These prices come from the stated support
price tables or indicative estimates; they are not a live market feed. Costs are indicative too, so this helps
compare options, not promise a sale price or guaranteed profit. Farmer-editable prices are still on our backlog."

#### Scene 10 | 6:25-7:10 | Test a Hotter or Drier Scenario

**Click / show:** Scroll to **Stress test** in **What to sow next** and click **Stress-test these options**.
Wait for **Testing scenarios...** to finish. Point across **Past weather**, **+1.5 degrees C**, **+2 degrees C**,
**15% less rain** and **Driest 20% of years** (temperature labels use the degree symbol in the UI).
**Late-monsoon years** is conditional on an eligible kharif run; do not promise it for Rabi or rotations.

**Say:** "These are explicit what-if experiments: warmer temperatures, less rainfall, or a dry subset of the
record. They are not a forecast or a downscaled future-climate projection. We look at how profit, failures and
relative rank change together, not only whether a badge stays green."

**Presenter guard:** Settle priorities and irrigation before this run. The current UI can leave an old stress
table visible after an input change. To request a fresh table, switch to another Plan sub-tab and back, reselect
the intended season, wait for advice, and run the test again. Do not keep pointing at the previous table.

#### Scene 11 | 7:10-8:30 | Compare Two-Year Rotations

**Click / show:** Click **Two-year rotations**. Keep **Crop residue: Left in the field**. Wait for the results.
Point to **Your current practice** and read whether it comes from the journal or the stated default. Trace
**Year 1** and **Year 2** on one rotation card, including any **Fallow** slots. Tick **Compare** on two options,
then scroll below the option cards to **Side by side**.

**Say:** "A rotation is a sequence, not just a list of individually attractive crops. These calendars and
models account for crop order and water carry-over. The comparison includes current practice and the selected
alternatives, so we can inspect annual profit, bad-year profit, irrigation, failed seasons and soil indicators.
The ten-year carbon figure is a modelled extrapolation, not carbon measured during this two-year plan."

**If the baseline is a default:** Add, "Here the baseline is assumed rain-fed maize, not a verified description
of this farmer. A more complete journal is needed before claiming improvement over their actual practice."

**Presenter guard:** The main demo uses the next-crop stress test from Scene 10, not the rotation stress button.
Rotation stress ranking currently omits the carbon/residue contribution and ranks only the selected set. With
three or fewer tested rotations, every rank is in the top three, so **Holds up** is not meaningful evidence of
robustness. These are follow-ups in section 10, not capabilities to claim during this presentation.

#### Scene 12 | 8:30-9:10 | Save the Decision with Its Assumptions

**Click / show:** Return to one of the compared rotation cards. Click its **Save plan** and wait for
**Saved to your plans**. Click **Saved plans**. Point to the saved title, date, irrigation, priority weights and
any low-confidence explanation. Refresh the browser once to demonstrate persistence; wait for the saved list.

**Say:** "The saved plan is a snapshot of the decision and its assumptions. We can return to it later, and the
weather warning stays with it. Saving does not turn a low-confidence scenario into a verified recommendation.
New data or new assumptions mean generating a new plan, not silently rewriting the old result."

**Wait / fallback:** If a plan limit or service error appears, report it rather than claiming success. Show the
prepared saved plan and its date as a fallback. Do not delete other plans or accounts just to clear the error live.

#### Scene 13 | 9:10-9:45 | Language and Data Ownership

**Click / show:** Use the header **Language** dropdown to select Hindi or Telugu, pause, then return to English.
Click **Account**. Point to **Export your data** and **Delete account**; do not activate deletion or password
changes. Optionally click **Download my data** for the disposable demo account and confirm the file appears in
the browser's downloads without displaying personal data.

**Say:** "The interface is available in English, Hindi and Telugu; native-speaker review is still needed.
Users can export their records and delete their account. These controls are part of data ownership, not just
the crop model. We are not demonstrating password reset today."

#### Scene 14 | 9:45-10:20 | Close with the Actual MVP Claim

**Click / show:** Click **My farms**, reopen `Telangana demo`, and return to **Plan > Saved plans**.

**Say:** "The MVP connects environmental history, farmer knowledge and transparent simulations into one
decision workflow. It helps compare choices and makes uncertain inputs visible. It does not yet establish
field-level yield accuracy or guaranteed income. Our next steps are hosted end-to-end checks, the remaining
feature and stress-test gaps, and local agronomic validation before farmers rely on the advice."

### 7.3 Optional Detours, Only When Prepared

| Detour | Click sequence | Say |
| --- | --- | --- |
| Registration / login, 30 seconds | In a separate disposable session, **New here? Create an account**, enter name/email/password, **Create account**. For the prepared account use **Sign in**; never expose its password. | "Account creation stores an account and session. Environmental downloads start only after a farm location is submitted." A new account has no prepared farms; return to the prepared session for the main demo. |
| Full farm submission | On an additional demo farm, complete **Add farm**, then **Create farm**. Show the source progress, then **Back to my farms** and open the prepared farm. | "This download is asynchronous and resumable. We will not wait for the entire history in the live presentation." |
| Verified climate, 60 seconds | Only if Weather says **Verified**, open **Climate & risk**. Point at **This season**, **Know your season**, **Rain and water demand by month**, then **Long-term trends**. Hover a chart point. | "These are historical frequencies and modelled current-state comparisons for the data dates shown, at the source's spatial resolution." Read current values; do not reuse the old 'driest 7%' claim. |
| Weather-protected climate, 10 seconds | If not verified, open **Climate & risk**, show the warning, then return to **Plan**. | "This view is deliberately paused until recent weather passes checks. Historical-scenario planning is disclosed separately." Do not present the absent charts as currently available. |
| Verified crop fit, 40 seconds | On a verified India farm, **Crop fit > Rabi**, choose **Water**, then **Show details** on a crop card. | "This is the wider crop-suitability view across past seasons, including yield, water, nitrogen and carbon assumptions." Skip when weather is unverified. |
| Worldwide scope, 40 seconds | **My farms**, open a prepared Kenya, Iowa or Brazil farm, then **Climate & risk** only if its weather is verified. Otherwise show only the actual available Soil/History screens. | "Climate, soil and vegetation are designed for worldwide locations. Crop recommendations remain India-only; these are not validated crop plans for every country." Preset buttons are not preloaded demo datasets. |

### 7.4 When Something Does Not Match the Script

| What appears | What to do | What to say |
| --- | --- | --- |
| Backend unavailable / cold start | Pause once; retry after the host is reachable, or use a labelled screenshot. Do not repeatedly click mutating actions. | "The free backend is waking or unavailable. This screenshot is from our earlier rehearsal, not a live result." |
| Weather still preparing or needs attention without advice | Show source progress, then use a prepared alternative or saved result. | "We do not have enough checked data to calculate fresh advice here yet." |
| NDVI chart absent or downloading | Show its status and the existing journal. | "Satellite history is a separate download; the farmer can still record what was grown." |
| Rankings do not change after a slider move | Wait for updating to finish; explain the observed result. | "The same option still leads for these inputs. A preference change need not change the winner." |
| Every option fails / loses money | Show the warning before considering a separately labelled season or irrigation scenario. | "The system should be able to say the available choices are poor, not always force a positive recommendation." |
| Soil map unavailable | Point to **Standard soil** and the edit form. | "This uses a labelled default, not a measured soil profile." |
| A displayed number differs from rehearsal | Read today's displayed value, dates and trial count. | "The model reflects the current inputs and checked history; our presentation does not fix the answer in advance." |
| An old stress table remains after inputs change | Leave that sub-tab, return, reselect the intended season/options and run again. | "That result was for the previous assumptions. We need a new test before comparing." |

### 7.5 Five-Minute Version

Use Scenes 1 and 3 (purpose and confidence), 5 (journal, without editing), 6 (one option), 7 (one priority
change), 11 (two rotations side by side), 12 (save), and 14 (close). Skip live onboarding, satellite downloads,
soil changes, stress computation and account export. Keep the data-quality explanation even when time is short.

### Useful Answers to Likely Questions

| Question | Answer |
| --- | --- |
| Is this a forecast? | No. Historical weather trials and explicit perturbation scenarios, with a prior-year state proxy when recent data fails. |
| Is NASA giving the recommendation? | No. NASA supplies environmental data; CropCompass's own models and rules produce the recommendation. |
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
After the Mailjet integration on 24 October, 180 isolated backend regression tests passed; the live Neon test was
excluded from that run. The 37 focused mailer/account/configuration tests, lint and formatting passed again before
the Mailjet commit. These results are local checks, not hosted-browser acceptance or agronomic validation.

Neon PostgreSQL connectivity and migrations are implemented and separately integration-tested. Mailjet is wired into
password reset, but live delivery awaits configuration and a separate test. Local SQLite farms were not copied into
Neon, so a new deployment must have its own prepared demo farm and downloaded data.

Open work: deployed HTTPS/same-origin behavior, agronomist review, independent weather and yield validation,
native-language review, broader accessibility and physical-device GPS testing. Password reset is deliberately
excluded from the requested deployed-browser demo/test pass; its live delivery remains a separate open item.
A successful local demo does not establish production readiness. Dates on screen follow the actual backend UTC clock,
which can differ from local calendar date.

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

## 10. MVP Gap Check Against the Initial Plan

Assessment date: 24 October 2026. This is a source-based comparison with PLAN sections 2-4, 6-7, 11-12 and 16-17,
not a fresh browser test. No missing feature was implemented as part of writing this guide. The deployment and
browser pass are still to come; password-reset delivery is deliberately a separate check.

### Implemented Core Workflow

| Original capability | Current implementation / boundary |
| --- | --- |
| Accounts and multiple farms | Signup, login/logout, change password, export, delete, owner checks, sessions and CSRF; Mailjet reset integration exists, live mail delivery not yet verified. |
| Locate a field | Place search, GPS request, coordinates, pin, polygon and area calculation. One farm represents one field. Physical-device GPS and deployed behavior still need testing. |
| Environmental ingestion | Annual validated POWER checkpoints, SoilGrids profile and resumable MODIS NDVI. Per-source status is shown; EVI and the MODIS quality band are not fetched. |
| Climate and current-season view | Historical risk, growing windows, rain/ET0, trends, rain and modelled soil-water percentiles, and India onset. Climate/Crop fit require verified weather. |
| Soil and journal | Farmer soil overrides, crop records, intercrop identity, dates, residue, irrigation count, yield, problems and herbicide; NDVI timing suggestions and vigour. |
| Next-crop planner | Season selection, sowing-date trials, previous-crop rules, priorities, water scenarios, yield/income ranges, failure counts, reasons and confidence. |
| Two-year planner | Rotation timelines, current-practice baseline, up to three selected alternatives side by side, soil/water/risk/income metrics and saved snapshots. |
| Stress testing | Next-crop warming/rain/dry-year scenarios and conditional late-onset subsets; rotation scenarios exist but have the ranking limitations below. |
| Localisation and persistence | English/Hindi/Telugu UI, persisted priorities and plan snapshots; Neon connectivity and migrations tested. Native-language review and hosted acceptance are pending. |

### Real Omissions or Reduced Scope

These were in the original plan. They should be completed or explicitly deferred; calling the entire original
plan finished would be inaccurate. They do not all need to block a clearly labelled team prototype demo.

| Planned item | What exists now | Recommended treatment for this MVP |
| --- | --- | --- |
| Per-season report card: weather, NDVI, actual vs expected yield (4.5) | Journal stores yield and management; NDVI shows timing/vigour. No linked per-record weather/yield report card. | Explicitly defer, or implement next if demonstrating learning from past harvests is essential. |
| Full Soil Health Card N/P/K/EC input (4.2) | Overrides cover texture, depth, water holding, organic carbon and pH. Mapped total nitrogen is displayed, not a farmer N/P/K/EC editor. | Defer with clear wording; do not claim full nutrient diagnosis or fertiliser prescription. |
| Farmer price override (6) | Prices/costs and sources are visible, but static and read-only. | Worth prioritising before real farmer use; demo income is indicative, not local market advice. |
| Hectares/acres toggle (3) | Area and per-area values are hectare-based; no acres switch. | Small farmer-usability gap; defer only explicitly. |
| Similar-start analog years (7.1 / phase 3) | Historical trials and driest/late-onset subsets exist; no "years that started like this one" summary. | Defer. Do not confuse stress-test subsets with this missing matching feature. |
| Current dry-spell counter, season heat-day counter and heat/frost calendar (4.3-4.4) | Current rain, soil water and onset; historical dry-spell/heat/frost summaries. No dedicated current counters/calendar UI. | Defer rather than describing the season dashboard as fully matching the original specification. |
| Water-source capture and fertiliser records (4.2 / data model 9) | Rain-fed/protective/full modes and irrigation count; no well/canal/source field or fertiliser-application field. | Optional metadata for the demo; needed before claiming complete management records. |
| Guided soil/history/priorities onboarding (4.2) | Add farm collects location, area and irrigation; Soil, Crop history and Plan hold the remaining inputs. | Intentional workflow simplification, not missing underlying editors. Explain the tabs or add a guided checklist later. |
| EVI and satellite quality flags (6 table) | NDVI-only acquisition with smoothing, as later ingestion notes acknowledge. | Explicit data-scope reduction; never call the chart an EVI or QA-band product. |

### Correctness Follow-Ups Before a Free-Form Planner Demo

These are source-level findings, not new browser reproductions. The scripted route avoids the problematic
combinations; that is not a substitute for fixing and testing them.

1. **Invalidate stress results when inputs change.** NextCropView and RotationsView keep mutation results when
   priorities or irrigation change; rotation selection changes also leave the earlier table visible. The run
   button is hidden once a result exists. Reset/key the stress state by all its inputs and test a change-after-run.
2. **Align rotation stress inputs and rankings.** StressTestIn and the request omit residue; `stress_rotations`
   builds ranking metrics with zero carbon changes, unlike the main rotation ranking. Propagate the chosen inputs
   and explicitly define which soil metrics the baseline/scenarios use before comparing their ranks as equivalent.
3. **Make rotation robustness meaningful.** The UI tests at most three selected rotations, while "Holds up" means
   rank at most three in each scenario. Every selected option can satisfy that by construction. Define a meaningful
   comparison universe or absolute failure/loss criterion; do not sell this badge as evidence of a safe plan.

Owners: [NextCropView.tsx](../frontend/src/features/plan/NextCropView.tsx),
[RotationsView.tsx](../frontend/src/features/plan/RotationsView.tsx),
[schemas.py](../backend/app/schemas.py), [planner.py](../backend/app/services/planner.py),
[rotations.py](../backend/engine/planner/rotations.py).

### Release and Verification Work, Not Missing Screens

- Verify the deployed frontend/API/Neon flow, same-origin `/api` routing, Secure cookies, CSRF, session persistence,
  deep-link refresh and absence of secrets in client assets. A working local proxy is not hosted verification.
- Prepare actual cloud demo farms; validate ingestion, resume after restart/cold start, saved-plan persistence,
  ownership, export, delete and error states on the chosen hosting tier. Use disposable records for destructive tests.
- Address the recent-weather source problem if a fully working Climate/Crop fit demo is required. Low-confidence
  Plan is an approved fallback, not a repair of current observations. Never drop the checks just to unlock a view.
- Add CI checks including dependency/secret scanning. No workflow files or configured frontend Vitest/Playwright
  test suite were found; prior browser sessions and backend tests are useful but not a repeatable frontend CI suite.
- Finish keyboard/mobile/accessibility checks, native-language review and real-device GPS/download checks.
- Keep agronomic calibration, independent weather/yield evidence and economic validation separate from software
  testing. No production-readiness, WCAG conformance or improved-income claim follows from passing backend tests.
- Configure and separately verify Mailjet delivery later. The user's first deployed-browser pass excludes reset
  password; that exclusion does not mean email delivery has passed. No new auth provider is needed.

**Recommended order:** fix the three stress-result correctness items; deploy and verify the core workflow; prepare
the demo data and rehearse this script; explicitly defer or schedule the smaller original-plan omissions. Price
overrides and a season report card are the most directly useful follow-on decision features. Do not expand into
new region packs, alerts or forecasting just to make the checklist look fuller.

### Intentionally Later, Not Missing MVP Work

Phone OTP, email verification, forecasts, push/email alerts, photo/pest uploads, LLM narration, future-climate
datasets, new regional crop packs, offline PWA, detailed irrigation scheduling and flooded-rice mode remain later
work. Perennial crops and pesticide/chemical recommendations remain out of scope. The old stretch list also
mentions Hindi/Telugu and password reset, but those have since been implemented and should not be counted missing.