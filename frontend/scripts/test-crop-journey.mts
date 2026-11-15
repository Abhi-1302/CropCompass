import assert from "node:assert/strict";
import test from "node:test";
import { cropJourney, journalState } from "../src/features/crops/journey.ts";

const earlier = { id: "earlier", crops: ["maize"], sow_date: "2025-11-15", harvest_date: "2026-03-20", status: "harvested" as const, season: "rabi" as const, season_year: 2025 };
const latest = { ...earlier, id: "latest", crops: ["green_gram", "maize"], sow_date: "2026-06-20", harvest_date: "2026-08-25", season: "kharif" as const, season_year: 2026 };

test("empty and one-entry journals do not invent history or plans", () => {
  assert.deepEqual(cropJourney([], []), { previous: undefined, latest: undefined, plan: undefined });
  assert.deepEqual(cropJourney([latest], []), { previous: undefined, latest, plan: undefined });
});

test("the two most recent sowings are chronological without mutating cached records", () => {
  const oldest = { ...earlier, id: "oldest", sow_date: "2024-06-20" };
  const records = [earlier, oldest, latest];
  const result = cropJourney(records, []);
  assert.equal(result.previous, earlier);
  assert.equal(result.latest, latest);
  assert.deepEqual(result.latest?.crops, ["green_gram", "maize"]);
  assert.deepEqual(records, [earlier, oldest, latest]);
});

test("future sowings and planned entries are not described as growing or harvested", () => {
  assert.equal(journalState({ ...latest, sow_date: "2026-12-01" }, "2026-11-15"), "planned");
  assert.equal(journalState({ ...latest, status: "planned" }, "2026-11-15"), "planned");
  assert.equal(journalState(latest, "2026-11-15"), "harvested");
});

test("overdue in-field records are not automatically harvested and fallow remains explicit", () => {
  assert.equal(journalState({ ...latest, status: "in_field" }, "2026-11-15"), "in_field");
  assert.equal(journalState({ ...latest, crops: ["fallow"] }, "2026-11-15"), "fallow");
});

test("the newest saved plan retains its title and outdated status rather than becoming advice", () => {
  const old = { id: "old", title: "Earlier choice", created_at: "2026-11-13T10:00:00Z", weather_status: "current" as const };
  const recent = { id: "recent", title: "Two-year rotation", created_at: "2026-11-14T10:00:00Z", weather_status: "outdated" as const };
  const plans = [old, recent];
  assert.equal(cropJourney([], plans).plan, recent);
  assert.deepEqual(plans, [old, recent]);
});