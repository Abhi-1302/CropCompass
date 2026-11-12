import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, ApiError, identityOperation, resetIdentityRequests } from "./client";
import type {
  Catalog,
  AuthCapabilities,
  ClimateProfile,
  CropFit,
  CropSeason,
  Farm,
  FarmInput,
  Irrigation,
  NextCropAdvice,
  NextCropStress,
  Priorities,
  ResidueChoice,
  RotationAdvice,
  RotationStress,
  SavedPlan,
  SeasonInput,
  SeasonRecord,
  SoilOverride,
  SoilProfile,
  Sources,
  User,
  VegetationView,
} from "./types";

export const keys = {
  me: ["me"] as const,
  catalog: ["catalog"] as const,
  farms: ["farms"] as const,
  farm: (id: string) => ["farm", id] as const,
  climate: (id: string) => ["farm", id, "climate"] as const,
  soil: (id: string) => ["farm", id, "soil"] as const,
  vegetation: (id: string) => ["farm", id, "vegetation"] as const,
  seasons: (id: string) => ["farm", id, "seasons"] as const,
  cropFits: (id: string) => ["farm", id, "crop-fit"] as const,
  cropFit: (id: string, season: CropSeason | undefined, irrigation: Irrigation) =>
    ["farm", id, "crop-fit", season ?? "next", irrigation] as const,
  advice: (id: string) => ["farm", id, "advice"] as const,
  plans: (id: string) => ["farm", id, "plans"] as const,
};

export function useMe() {
  const client = useQueryClient();
  return useQuery({ queryKey: keys.me, queryFn: async () => {
    const user = await api<User>("/auth/me").catch((error) => {
      if (error instanceof ApiError && error.status === 401 && client.getQueryData<User>(keys.me)) {
        resetIdentityRequests();
        clearSproutPreferences();
        client.removeQueries({ predicate: (query) => query.queryKey[0] !== "me" && query.queryKey[0] !== "auth-capabilities" });
      }
      throw error;
    });
    const previous = client.getQueryData<User>(keys.me);
    if (previous && previous.id !== user.id) {
      resetIdentityRequests();
      clearSproutPreferences();
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== "me" });
    }
    return user;
  }, retry: false, staleTime: 5 * 60_000, refetchOnWindowFocus: "always" });
}

function identityChanged(client: QueryClient, user?: User) {
  resetIdentityRequests();
  if (!user || client.getQueryData<User>(keys.me)?.id !== user.id) {
    clearSproutPreferences();
    client.clear();
  }
  if (user) client.setQueryData(keys.me, user);
  try { localStorage.setItem("cropcompass:identity", crypto.randomUUID()); } catch {}
}

export function useIdentitySync() {
  const client = useQueryClient();
  useEffect(() => {
    const refresh = () => { resetIdentityRequests(); clearSproutPreferences(); client.clear(); void client.invalidateQueries(); };
    const storage = (event: StorageEvent) => { if (event.key === "cropcompass:identity") refresh(); };
    window.addEventListener("storage", storage);
    window.addEventListener("cropcompass:session-expired", refresh);
    return () => { window.removeEventListener("storage", storage); window.removeEventListener("cropcompass:session-expired", refresh); };
  }, [client]);
}

export function useAuthCapabilities() {
  return useQuery({ queryKey: ["auth-capabilities"], queryFn: () => api<AuthCapabilities>("/auth/capabilities"), staleTime: 60_000, retry: false });
}

export function useGuest() {
  const client = useQueryClient();
  return useMutation({ mutationFn: () => identityOperation(async () => {
    try { return await api<User>("/auth/guest", { method: "POST", body: {} }); }
    catch (error) {
      if (!(error instanceof ApiError)) {
        const resumed = await api<User>("/auth/me").catch(() => null);
        if (resumed) return resumed;
      }
      throw error;
    }
  }), onSuccess: (user) => identityChanged(client, user) });
}

export function useConvertGuest() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (body: { name: string; email: string; password: string }) =>
    identityOperation(() => api<User>("/account/convert-guest", { method: "POST", body })),
    onSuccess: (user) => identityChanged(client, user) });
}

export function useDeleteGuest() {
  const client = useQueryClient();
  return useMutation({ mutationFn: () => identityOperation(() => api<void>("/account/guest/delete", { method: "POST", body: { confirm: true } })),
    onSuccess: () => identityChanged(client) });
}

export function useGuestActivity(user: User | undefined) {
  const client = useQueryClient();
  const capabilities = useAuthCapabilities().data;
  useEffect(() => {
    if (!user?.is_guest) return;
    let last = 0;
    let pending = false;
    let active = true;
    const checkpoint = () => {
      if (document.visibilityState !== "visible" || pending || Date.now() - last < (capabilities?.activity_interval_seconds ?? 900) * 1000) return;
      pending = true;
      last = Date.now();
      void identityOperation(async () => {
        if (!active || client.getQueryData<User>(keys.me)?.is_guest !== true) return;
        const updated = await api<User>("/auth/guest/activity", { method: "POST", body: {} });
        if (active && client.getQueryData<User>(keys.me)?.id === updated.id) client.setQueryData(keys.me, updated);
      }).catch(() => undefined).finally(() => { pending = false; });
    };
    document.addEventListener("pointerdown", checkpoint);
    document.addEventListener("keydown", checkpoint);
    document.addEventListener("visibilitychange", checkpoint);
    window.addEventListener("focus", checkpoint);
    return () => {
      active = false;
      document.removeEventListener("pointerdown", checkpoint);
      document.removeEventListener("keydown", checkpoint);
      document.removeEventListener("visibilitychange", checkpoint);
      window.removeEventListener("focus", checkpoint);
    };
  }, [user?.id, user?.is_guest, client, capabilities?.activity_interval_seconds]);
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) => api<User>("/auth/login", { method: "POST", body }),
    onSuccess: (user) => identityChanged(client, user),
  });
}

export function useRegister() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; email: string; password: string }) =>
      api<User>("/auth/register", { method: "POST", body }),
    onSuccess: (user) => identityChanged(client, user),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => identityOperation(() => api<void>("/auth/logout", { method: "POST" })),
    onSuccess: () => identityChanged(client),
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (email: string) => api<{ detail: string; delivery: "email" | "development" | "unavailable" }>("/auth/password/forgot", { method: "POST", body: { email } }),
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: (body: { token: string; password: string }) =>
      api<void>("/auth/password/reset", { method: "POST", body }),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: { current_password: string; new_password: string }) =>
      api<void>("/account/password", { method: "POST", body }),
  });
}

export function useDeleteAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => api<void>("/account/delete", { method: "POST", body: { password } }),
    onSuccess: () => identityChanged(client),
  });
}

function clearSproutPreferences() {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith("sprout:") || key.startsWith("sprout-consent:")) sessionStorage.removeItem(key);
    }
  } catch {}
}

/** Download everything the account holds as a JSON file. */
export function useExportData() {
  return useMutation({
    mutationFn: async () => {
      const data = await api<unknown>("/account/export");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `cropcompass-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      // Revoking straight away can cancel the download in some browsers.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  });
}

export function useFarms() {
  return useQuery({
    queryKey: keys.farms,
    queryFn: () => api<Farm[]>("/farms"),
    refetchInterval: (query) => (query.state.data?.some((farm) => farm.data_status === "pending") ? 3000 : false),
  });
}

export function useFarm(id: string) {
  return useQuery({
    queryKey: keys.farm(id),
    queryFn: () => api<Farm>(`/farms/${id}`),
    refetchInterval: (query) => (query.state.data?.data_status === "pending" ? 2000 : false),
  });
}

export function useSources(id: string) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["farm", id, "sources"],
    queryFn: () => api<Sources>(`/farms/${id}/sources`),
    refetchInterval: 5000,
  });
  const revision = query.data?.weather.revision;
  const adviceRevision = query.data?.advice.weather_context?.revision;
  const status = query.data?.weather.status;
  useEffect(() => {
    for (const key of [keys.climate(id), keys.cropFits(id), keys.advice(id), keys.plans(id)]) {
      client.removeQueries({ queryKey: key, type: "inactive" });
      void client.invalidateQueries({ queryKey: key });
    }
  }, [client, id, revision, adviceRevision, status]);
  return query;
}

export function useCreateFarm() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: FarmInput) => api<Farm>("/farms", { method: "POST", body }),
    onSuccess: (farm) => {
      client.setQueryData(keys.farm(farm.id), farm);
      void client.invalidateQueries({ queryKey: keys.farms });
    },
  });
}

export function useRefreshFarm(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<Farm>(`/farms/${id}/refresh`, { method: "POST" }),
    onSuccess: (farm) => {
      client.setQueryData(keys.farm(id), farm);
      client.removeQueries({ queryKey: keys.climate(id) });
      client.removeQueries({ queryKey: keys.soil(id) });
      client.removeQueries({ queryKey: keys.cropFits(id) });
      client.removeQueries({ queryKey: keys.advice(id) });
    },
  });
}

export function useDeleteFarm() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/farms/${id}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      client.removeQueries({ queryKey: keys.farm(id) });
      void client.invalidateQueries({ queryKey: keys.farms });
    },
  });
}

export function useClimate(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.climate(id),
    queryFn: () => api<ClimateProfile>(`/farms/${id}/climate`),
    enabled,
    staleTime: 30 * 60_000,
  });
}

export function useSoil(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.soil(id),
    queryFn: () => api<SoilProfile>(`/farms/${id}/soil`),
    enabled,
    staleTime: 30 * 60_000,
    retry: false,
  });
}

/** Soil feeds every model, so new values refresh climate, crop fit and advice too. */
export function useSaveSoil(farmId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (values: SoilOverride | null) =>
      values
        ? api<SoilProfile>(`/farms/${farmId}/soil/override`, { method: "PUT", body: values })
        : api<SoilProfile>(`/farms/${farmId}/soil/override`, { method: "DELETE" }),
    onSuccess: (soil) => {
      client.setQueryData(keys.soil(farmId), soil);
      client.removeQueries({ queryKey: keys.climate(farmId) });
      client.removeQueries({ queryKey: keys.cropFits(farmId) });
      client.removeQueries({ queryKey: keys.advice(farmId) });
    },
  });
}

export function useCatalog() {
  return useQuery({ queryKey: keys.catalog, queryFn: () => api<Catalog>("/crops"), staleTime: Infinity });
}

function downloading(view: VegetationView | undefined): boolean {
  return !!view && (view.running || view.status === "pending" || view.status === "partial");
}

export function useVegetation(id: string) {
  return useQuery({
    queryKey: keys.vegetation(id),
    queryFn: () => api<VegetationView>(`/farms/${id}/vegetation`),
    refetchInterval: (query) => (downloading(query.state.data) ? 10_000 : false),
  });
}

export function useResumeVegetation(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<VegetationView>(`/farms/${id}/vegetation/refresh`, { method: "POST" }),
    onSuccess: (view) => client.setQueryData(keys.vegetation(id), { ...view, running: true }),
  });
}

export function useSeasons(id: string) {
  return useQuery({ queryKey: keys.seasons(id), queryFn: () => api<SeasonRecord[]>(`/farms/${id}/seasons`) });
}

export function useSaveSeason(farmId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: SeasonInput }) =>
      id
        ? api<SeasonRecord>(`/farms/${farmId}/seasons/${id}`, { method: "PATCH", body })
        : api<SeasonRecord>(`/farms/${farmId}/seasons`, { method: "POST", body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.seasons(farmId) });
      void client.invalidateQueries({ queryKey: keys.vegetation(farmId) });
      void client.invalidateQueries({ queryKey: keys.climate(farmId) });
      void client.invalidateQueries({ queryKey: keys.cropFits(farmId) });
      void client.invalidateQueries({ queryKey: keys.advice(farmId) });
    },
  });
}

export function useDeleteSeason(farmId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/farms/${farmId}/seasons/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.seasons(farmId) });
      void client.invalidateQueries({ queryKey: keys.vegetation(farmId) });
      void client.invalidateQueries({ queryKey: keys.climate(farmId) });
      void client.invalidateQueries({ queryKey: keys.cropFits(farmId) });
      void client.invalidateQueries({ queryKey: keys.advice(farmId) });
    },
  });
}

export function useCropFit(id: string, season: CropSeason | undefined, irrigation: Irrigation, enabled = true) {
  return useQuery({
    enabled,
    queryKey: keys.cropFit(id, season, irrigation),
    queryFn: () => {
      const params = new URLSearchParams({ irrigation });
      if (season) params.set("season", season);
      return api<CropFit>(`/farms/${id}/crop-fit?${params}`);
    },
    staleTime: 30 * 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

const ADVICE_STALE = 10 * 60_000;

export function useNextCrop(id: string, season: CropSeason | undefined, irrigation: Irrigation, weights: Priorities) {
  return useQuery({
    queryKey: [...keys.advice(id), "next", season ?? "next", irrigation, weights] as const,
    queryFn: () =>
      api<NextCropAdvice>(`/farms/${id}/advice/next-crop`, { method: "POST", body: { season, irrigation, weights } }),
    staleTime: ADVICE_STALE,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useRotations(id: string, irrigation: Irrigation, weights: Priorities, residue: ResidueChoice) {
  return useQuery({
    queryKey: [...keys.advice(id), "rotations", irrigation, weights, residue] as const,
    queryFn: () =>
      api<RotationAdvice>(`/farms/${id}/advice/rotations`, { method: "POST", body: { irrigation, weights, residue } }),
    staleTime: ADVICE_STALE,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export type StressInput =
  | { kind: "next_crop"; season?: CropSeason; irrigation: Irrigation; weights: Priorities }
  | { kind: "rotation"; irrigation: Irrigation; weights: Priorities; rotations: string[] };

export function useStressTest(id: string) {
  return useMutation({
    mutationFn: (body: StressInput) =>
      api<NextCropStress | RotationStress>(`/farms/${id}/advice/stress-test`, { method: "POST", body }),
  });
}

export function usePlans(id: string) {
  return useQuery({ queryKey: keys.plans(id), queryFn: () => api<SavedPlan[]>(`/farms/${id}/plans`) });
}

export type PlanInput = {
  kind: SavedPlan["kind"];
  title: string;
  choice: string;
  season?: CropSeason;
  irrigation: Irrigation;
  weights: Priorities;
  residue?: ResidueChoice;
};

export function useSavePlan(farmId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PlanInput) => api<SavedPlan>(`/farms/${farmId}/plans`, { method: "POST", body }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.plans(farmId) }),
  });
}

export function useDeletePlan(farmId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => api<void>(`/farms/${farmId}/plans/${planId}`, { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.plans(farmId) }),
  });
}

export function useSavePriorities(farmId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (priorities: Priorities) => api<Farm>(`/farms/${farmId}`, { method: "PATCH", body: { priorities } }),
    onSuccess: (farm) => client.setQueryData(keys.farm(farmId), farm),
  });
}
