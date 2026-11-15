import type { SavedPlan, SeasonRecord } from "../../api/types";

type JournalEntry = Pick<SeasonRecord, "id" | "crops" | "sow_date" | "harvest_date" | "status" | "season" | "season_year">;
type JourneyPlan = Pick<SavedPlan, "id" | "title" | "created_at" | "weather_status">;

export function cropJourney(records: readonly JournalEntry[], plans: readonly JourneyPlan[]) {
  const journal = [...records].sort((left, right) => right.sow_date.localeCompare(left.sow_date) || left.id.localeCompare(right.id));
  const saved = [...plans].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  return { previous: journal[1], latest: journal[0], plan: saved[0] };
}

export function journalState(record: JournalEntry, today: string) {
  if (record.status === "planned" || record.sow_date > today) return "planned";
  if (record.crops.includes("fallow")) return "fallow";
  return record.status;
}