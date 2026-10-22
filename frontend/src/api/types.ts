export type User = { id: string; email: string; name: string };

export type Irrigation = "rainfed" | "protective" | "full";
export type DataStatus = "pending" | "ready" | "error" | "limited";
export type WeatherContext = {
  mode: "observed" | "historical_proxy";
  confidence: "standard" | "low";
  revision: string;
  checked_through: string;
  reference_year: number | null;
  proxy_from: string | null;
  proxy_through: string | null;
};
export type SourceStatus = "pending" | "unverified" | "downloading" | "validating" | "verified" | "needs_attention" | "ready" | "partial" | "error" | "default" | "farmer";
export type Sources = {
  advice: { available: boolean; weather_context: WeatherContext | null };
  weather: { status: SourceStatus; years_done: number; years_total: number; through: string | null; updated_at: string | null; revision: string | null; error: string | null };
  soil: { status: SourceStatus; updated_at: string | null };
  satellite: { status: SourceStatus; done: number; total: number; through: string | null; updated_at: string | null };
};

export type Priorities = { income: number; water: number; soil: number; risk: number };
export type PillarKey = keyof Priorities;

export type GeoPolygon = { type: "Polygon"; coordinates: [number, number][][] };

export type Farm = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  area_ha: number | null;
  boundary: GeoPolygon | null;
  irrigation: Irrigation;
  priorities: Priorities | null;
  region: string | null;
  cell_id: string;
  data_status: DataStatus;
  data_error: string | null;
  created_at: string;
};

export type FarmInput = {
  name: string;
  lat: number;
  lon: number;
  area_ha?: number | null;
  boundary?: GeoPolygon | null;
  irrigation: Irrigation;
};

export type Probability = { p: number | null; k: number; n: number };

export type MonthlyRow = {
  month: number;
  rain_mm: number;
  et0_mm: number;
  tmax_c: number;
  tmin_c: number;
  hot_days: number;
  frost_days: number;
};

export type Trend = { name: string; slope_per_decade: number; p_value: number; significant: boolean };

export type CurrentSeason = {
  start: string;
  until: string;
  rain_mm: number;
  median_mm: number;
  rain_percentile: number;
  store_fraction: number;
  store_percentile: number;
  n_years: number;
};

export type Monsoon = {
  onset: {
    median: string | null;
    earliest: string | null;
    latest: string | null;
    p_by_jun_15: Probability;
    p_by_jun_30: Probability;
    p_after_jul_15: Probability;
    by_year: { year: number; date: string | null }[];
    this_year: { year: number; date: string | null; decided: boolean } | null;
    rule: string;
  };
  false_start: Probability;
  jjas_rain: { median_mm: number; p_deficient: Probability };
  dry_spells_jul_sep: { ge_10d: Probability; ge_14d: Probability; ge_21d: Probability };
  growing_period: {
    median_days: number | null;
    p_ge_120d: Probability;
    p_ge_150d: Probability;
    p_ge_180d: Probability;
    median_end: string | null;
  };
  rabi_terminal_heat: Probability;
};

export type SoilSource = "soilgrids" | "farmer" | "default";

/** Soil water on the last day with weather, from the journal replay (same figure on the Climate and Plan tabs). */
export type SoilNow = {
  mm: number;
  fraction: number;
  typical_mm: number;
  percentile: number;
  capacity_mm: number;
  replayed: string[];
  recorded_fallow: boolean;
  assumed: { crop: string; season: "kharif" | "rabi" | "summer"; season_year: number }[];
  since: string;
  as_of: string;
};

export type ClimateProfile = {
  period: { first_year: number; last_year: number; n_years: number; data_until: string };
  assumptions: { awc_mm: number; dry_day_mm: number; awc_source: SoilSource };
  location: { cell_id: string; cell_lat: number; cell_lon: number; elevation_m: number | null };
  monthly: MonthlyRow[];
  annual_rain: {
    mean_mm: number;
    median_mm: number;
    dependable_mm: number;
    wet_year_mm: number;
    cv: number;
    min: { mm: number; year: number };
    max: { mm: number; year: number };
    by_year: { year: number; mm: number }[];
  };
  aridity: { index: number; class: string; et0_mm: number };
  growing_season: {
    agri_year_start: string;
    windows: { start: string; end: string; days: number }[];
    p_season_ge_90d: Probability;
    p_two_seasons_ge_60d: Probability;
    median_longest_days: number | null;
  };
  heat: { days_ge_35_median: number; days_ge_40_median: number };
  frost: { has_frost: boolean | null; frost_days_median: number | null; frost_free_days_median: number | null };
  trends: Trend[];
  current_season: CurrentSeason | null;
  monsoon: Monsoon | null;
  soil_now: SoilNow | null;
};

export type SoilLayer = {
  depth: string;
  texture?: string;
  wilting_point?: number;
  field_capacity?: number;
  available_water?: number;
  ksat_mm_h?: number;
};

export type SoilSummary = {
  root_depth_cm: number;
  awc_mm: number | null;
  soc_stock_t_ha_0_30cm: number | null;
  topsoil: {
    texture: string | null;
    sand_pct: number | null;
    silt_pct: number | null;
    clay_pct: number | null;
    organic_carbon_pct: number | null;
    ph: number | null;
    ph_class: string | null;
    cec_cmol_kg: number | null;
    cec_class: string | null;
    nitrogen_g_kg: number | null;
    bulk_density_g_cm3: number | null;
  };
  layers: SoilLayer[];
};

export type SoilType = "black" | "red" | "alluvial" | "laterite" | "sandy" | "custom";

export type SoilOverride = {
  soil_type?: SoilType;
  sand_pct?: number;
  silt_pct?: number;
  clay_pct?: number;
  awc_mm_per_m?: number;
  depth_cm?: number;
  organic_carbon_pct?: number;
  ph?: number;
};

export type EffectiveSoil = {
  source: SoilSource;
  soil_type: SoilType | null;
  depth_cm: number;
  awc_mm_per_m: number;
  awc_mm: number;
  tew_mm: number;
  texture: string | null;
  sand_pct: number | null;
  silt_pct: number | null;
  clay_pct: number | null;
  organic_carbon_pct: number | null;
  soc_stock_t_ha_0_30cm: number | null;
  ph: number | null;
  ph_class: string | null;
};

export type SoilProfile = {
  source: "soilgrids" | "none";
  fetched_at: string | null;
  summary: SoilSummary | Record<string, never>;
  layers: unknown[];
  override: SoilOverride | null;
  effective: EffectiveSoil;
};

export type SeasonName = "kharif" | "rabi" | "summer" | "other";
export type SeasonStatus = "planned" | "in_field" | "harvested";

export type CropInfo = {
  id: string;
  name: string;
  family: string | null;
  group: string;
  seasons: SeasonName[];
  duration_days: [number, number];
  host_groups: string[];
};

export type Catalog = {
  version: number;
  region: string;
  seasons: Record<SeasonName, { name: string; sowing_months: number[] }>;
  families: Record<string, { name: string; nutrient_role: string; gap_years: number }>;
  host_groups: Record<string, string>;
  crops: CropInfo[];
  groups: Record<string, string>;
  problems: Record<string, { name: string; host_groups?: string[] }>;
  residue: Record<string, string>;
  agronomy: Record<
    string,
    { ym: number; n_rec: number; price: number; cost: number; product?: string; sowing: Record<string, [string, string]> }
  >;
  economics: { currency: string; n_price_per_kg: number; validated: boolean; price_sources: Record<string, string[]> };
};

export type SeasonRecord = {
  id: string;
  season: SeasonName;
  season_year: number;
  crops: string[];
  sow_date: string;
  harvest_date: string | null;
  status: SeasonStatus;
  residue: string | null;
  irrigations: number | null;
  yield_kg_ha: number | null;
  problems: string[];
  herbicide: string | null;
  notes: string | null;
  source: "farmer" | "satellite";
  created_at: string;
};

export type SeasonInput = Omit<SeasonRecord, "id" | "season" | "season_year" | "created_at"> & {
  season: SeasonName | null;
};

export type DetectedSeason = {
  season: SeasonName;
  season_year: number;
  green_up: string;
  peak: string;
  senescence: string | null;
  est_sowing: string;
  est_harvest: string | null;
  length_days: number | null;
  peak_ndvi: number;
  in_progress: boolean;
  logged: boolean;
  vigour_percentile: number | null;
};

export type VegetationView = {
  status: "pending" | "partial" | "ready" | "error";
  running: boolean;
  progress: { done: number; total: number };
  error: string | null;
  updated_at: string | null;
  points: { date: string; raw: number | null; smooth: number }[];
  seasons: DetectedSeason[];
};

export type CropSeason = Exclude<SeasonName, "other">;

export type RuleName =
  | "same_crop"
  | "same_family"
  | "shared_pest"
  | "legume_credit"
  | "n_lockup"
  | "residue_toxic"
  | "herbicide"
  | "calendar"
  | "window_passed";

export type RuleEffect = {
  rule: RuleName;
  kind: "block" | "penalty" | "risk" | "benefit" | "warning";
  factor: number;
  n_kg: number;
  severity: "low" | "medium" | "high";
  facts: {
    crop?: string;
    problems?: string[];
    family?: string;
    years?: number;
    gap_years?: number;
    group?: string;
    reported?: boolean;
    kg?: number;
    wait_days?: number;
    herbicide?: string;
    ready?: string;
    window_end?: string;
  };
};

export type CarbonRange = { low: number; mid: number; high: number };

export type MoneyRange = { mean: number | null; p10: number | null; p50: number | null; p90: number | null };

export type CropOutcome = {
  id: string;
  blocked: boolean;
  sowing: { window: [string, string]; median: string | null; late: Probability; dry: Probability };
  harvest: { median: string | null };
  duration_days: number;
  water: {
    need_mm: number | null;
    met: number | null;
    rain_mm: number | null;
    irrigation_mm: number;
    irrigations: number;
    soil_at_sowing_mm: number | null;
  };
  yield: {
    attainable: number | null;
    p10: number | null;
    p50: number | null;
    p90: number | null;
    relative: number;
    failure: Probability;
    by_year: { year: number; kg_ha: number }[];
  };
  income: MoneyRange;
  heat: { threshold_c: number | null; risk: Probability | null };
  nitrogen: { recommended: number; credit: number; extra: number; to_apply: number; fixed: number; leaves: number };
  rules: RuleEffect[];
  carbon: { kept: CarbonRange; removed: CarbonRange } | null;
};

export type CropFitCrop = CropOutcome & { succession_factor: number };

export type CropFit = {
  season: CropSeason;
  season_year: number;
  irrigation: Irrigation;
  period: { first_year: number; last_year: number; n_years: number };
  soil: { awc_mm: number; depth_m: number; source: SoilSource };
  previous: { crops: string[]; sow_date: string; end_date: string; harvested: boolean; replayed: boolean } | null;
  carbon: {
    soc_t_ha: number;
    years: number;
    baseline_source: "journal" | "default";
    baseline: { crop: string; season: SeasonName; residue: string | null }[];
  } | null;
  crops: CropFitCrop[];
};

export type ConfidenceFlag = "pack_unvalidated" | "soil_default" | "no_soil_carbon" | "short_record" | "no_history" | "weather_proxy";
export type Confidence = { level: "high" | "medium" | "low"; flags: ConfidenceFlag[] };
export type Reason = { code: "strong" | "weak"; pillar: PillarKey };
export type Economics = { currency: string; validated: boolean };

export type Ranked = {
  rank: number;
  score: number;
  comparable_pillars?: PillarKey[];
  pillars: Priorities;
  pareto: boolean;
  reasons: Reason[];
};

export type NextCropOption = CropOutcome &
  Ranked & {
    sowing: CropOutcome["sowing"] & {
      best: string;
      options: { date: string; failure: Probability; p50: number | null; income_mean: number | null }[];
    };
    normal: { failure: Probability; p50: number | null; income_mean: number | null; water_met: number | null };
  };

export type NextCropAdvice = {
  weather_context: WeatherContext;
  kind: "next_crop";
  season: CropSeason;
  season_year: number;
  irrigation: Irrigation;
  as_of: string;
  earliest_sowing: string;
  period: { first_year: number; last_year: number; n_years: number };
  soil_now: SoilNow;
  in_field: { crop: string; sow_date: string; expected_harvest: string } | null;
  carbon: CropFit["carbon"];
  economics: Economics;
  confidence: Confidence;
  weights: Priorities;
  options: NextCropOption[];
  blocked: CropOutcome[];
  unsuitable: CropOutcome[];
  excluded: { id: string; reason: string; window_end: string }[];
};

export type RotationSeason = {
  season: CropSeason;
  crop: string | null;
  sow?: string | null;
  harvest?: string | null;
  p50?: number;
  failure?: number;
};

export type RotationOption = Partial<Ranked> & {
  key: string;
  rank: number | null;
  blocked: boolean;
  years: { season_year: number; seasons: RotationSeason[] }[];
  income: { mean: number; p10: number; p90: number };
  water: { irrigation_mm: number; productivity: number | null };
  soil: { soc_change: CarbonRange | null; n_fixed: number; cover_months: number; families: number };
  risk: { failure: number; pest_flags: number };
  rules: (RuleEffect & { year: number; season: CropSeason })[];
  vs_current?: { income: number; income_p10: number; irrigation_mm: number; soc: number | null; failure: number };
};

export type ResidueChoice = "incorporated" | "removed";

export type RotationAdvice = {
  weather_context: WeatherContext;
  kind: "rotation";
  first_year: number;
  irrigation: Irrigation;
  residue: ResidueChoice;
  weights: Priorities;
  period: { first_year: number; last_year: number; n_pairs: number };
  considered: { patterns: number; rotations: number };
  current: RotationOption | null;
  current_source: "journal" | "default";
  economics: Economics;
  confidence: Confidence;
  options: RotationOption[];
};

export type ScenarioKey = "baseline" | "warm_1_5" | "warm_2" | "rain_minus_15" | "driest" | "late_onset";

export type NextCropStress = {
  weather_context: WeatherContext;
  kind: "next_crop";
  scenarios: ScenarioKey[];
  crops: {
    id: string;
    robust: boolean;
    results: Partial<
      Record<
        ScenarioKey,
        { rank: number | null; failure: Probability; p50: number | null; income_mean: number | null; income_p10: number | null } | null
      >
    >;
  }[];
};

export type RotationStress = {
  weather_context: WeatherContext;
  kind: "rotation";
  scenarios: ScenarioKey[];
  rotations: {
    key: string;
    robust: boolean;
    results: Partial<Record<ScenarioKey, { rank: number; income_mean: number; income_p10: number; failure: number }>>;
  }[];
};

export type SavedPlan = {
  weather_status: "current" | "outdated" | "unverified" | "low_confidence";
  id: string;
  kind: "next_crop" | "rotation";
  title: string;
  inputs: { irrigation: Irrigation; weights: Priorities; season?: CropSeason; season_year?: number; first_year?: number; weather_context?: WeatherContext };
  option: NextCropOption | RotationOption;
  engine_version: string;
  created_at: string;
};
