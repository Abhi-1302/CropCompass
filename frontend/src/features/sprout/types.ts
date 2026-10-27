import type { Confidence, CropSeason, Irrigation, Priorities, WeatherContext } from "../../api/types";

export type SproutIntent = "help" | "farm" | "soil" | "history" | "next_crop" | "rotations" | "saved_plans";
export type SproutScenario = {
  season?: CropSeason; irrigation?: Irrigation; weights?: Priorities; residue?: "incorporated" | "removed";
};
export type SproutAsk = {
  farmId?: string | null; text: string; intent?: SproutIntent;
  scenario?: SproutScenario; selectedOptionIds?: string[];
  displayedWeatherRevision?: string;
};
export type SproutThread = {
  id: string; farm_id: string | null; title: string; language: "en" | "hi" | "te";
  scenario: SproutScenario; version: number; updated_at: string;
};
export type SproutEvidence = {
  intent: SproutIntent; as_of: string; input_revision?: string; knowledge_version?: string;
  scenario: SproutScenario; notice?: string; weather_context?: WeatherContext | null;
  confidence?: Confidence;
  sources: { id: string; title: string; text: string; version: string; href?: string }[];
  options: {
    id: string; label: string; rank?: number;
    yield_kg_ha_p50?: number | null; income_inr_ha?: number | null;
    income_period?: "season" | "year"; irrigation_mm?: number | null;
  }[];
};
export type SproutMessage = {
  id: string; sequence: number; role: "user" | "assistant"; content: string;
  evidence: Partial<SproutEvidence>; created_at: string;
};
export type SproutRun = {
  id: string; request_id: string; user_message_id: string;
  state: "running" | "complete" | "failed" | "cancelled" | "interrupted";
  error_code: string | null; cancel_requested: boolean;
};
export type SproutHistory = {
  thread: SproutThread; messages: SproutMessage[]; before: number | null; run: SproutRun | null;
};
export type SproutCapabilities = { enabled: boolean; available: boolean; provider: string };