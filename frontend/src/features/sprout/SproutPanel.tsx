import { useEffect, useEffectEvent, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Info, MessageSquarePlus, RotateCcw, SendHorizontal, Square, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { api, ApiError, streamApi } from "../../api/client";
import { useFarms } from "../../api/hooks";
import { Spinner } from "../../components/ui";
import { WeatherConfidence } from "../plan/WeatherConfidence";
import { ConfidenceNote } from "../plan/parts";
import { catalogLabel } from "../crops/text";
import { completedHistory } from "./history";
import type { SproutAsk, SproutEvidence, SproutHistory, SproutMessage, SproutRun, SproutScenario, SproutThread } from "./types";

type Props = {
  open: boolean; onClose: () => void; userId: string; farmId: string | null;
  onScope: (farmId: string | null) => void; threadId: string | null; onThread: (id: string | null) => void;
  pending: (SproutAsk & { nonce: number }) | null; available: boolean;
};

function Sources({ evidence }: { evidence: Partial<SproutEvidence> }) {
  const { t, i18n } = useTranslation();
  const number = (value: number) => new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1 }).format(value);
  return <div className="sprout-evidence">
    {evidence.confidence && <ConfidenceNote confidence={evidence.confidence} />}
    {evidence.weather_context && <WeatherConfidence context={evidence.weather_context} />}
    {evidence.notice && <p className="sprout-notice">{t(evidence.notice === "select_farm" ? "sprout.selectFarm" :
      evidence.notice === "selection_changed" ? "sprout.selectionChanged" : "sprout.adviceUnavailable")}</p>}
    {evidence.options?.map(option => <div className="sprout-option" key={option.id}>
      <strong>{option.rank ? `${option.rank}. ` : ""}{evidence.intent === "next_crop" ? catalogLabel("crop", option.id, option.label) : option.label}</strong>
      <dl>
        {option.yield_kg_ha_p50 != null && <div><dt>{t("sprout.yield")}</dt><dd>{number(option.yield_kg_ha_p50)} kg/ha</dd></div>}
        {option.income_inr_ha != null && <div><dt>{t("sprout.income")}</dt><dd>{number(option.income_inr_ha)} INR/ha<br />
          <small>{t(option.income_period === "year" ? "sprout.year" : "sprout.season")}</small></dd></div>}
        {option.irrigation_mm != null && <div><dt>{t("sprout.irrigation")}</dt><dd>{number(option.irrigation_mm)} mm<br /><small>{t("sprout.year")}</small></dd></div>}
      </dl>
    </div>)}
    {evidence.sources?.length ? <details className="sprout-sources"><summary>{t("sprout.sources")} ({evidence.sources.length})</summary>
      {evidence.sources.map((source, index) => <section key={source.id}>
        <strong>{index + 1}. {source.title}</strong><p>{source.text}</p>
        {source.href?.startsWith("/farms/") && <Link to={source.href}>{t("sprout.openFarm")}</Link>}
      </section>)}
      {evidence.as_of && <p>{t("sprout.snapshot", { date: new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: "medium" }).format(new Date(evidence.as_of)) })}</p>}
    </details> : null}
  </div>;
}

function consentFor(userId: string) {
  try { return sessionStorage.getItem(`sprout-consent:${userId}`) === "1"; } catch { return false; }
}

export default function SproutPanel({ open, onClose, userId, farmId, onScope, threadId, onThread, pending, available }: Props) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const farms = useFarms();
  const [draft, setDraft] = useState("");
  const [intent, setIntent] = useState<SproutAsk["intent"]>();
  const [scenario, setScenario] = useState<SproutScenario | undefined>();
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [displayedRevision, setDisplayedRevision] = useState<string | undefined>();
  const [reset, setReset] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [consent, setConsent] = useState(() => consentFor(userId));
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [sentText, setSentText] = useState("");
  const [streamEvidence, setStreamEvidence] = useState<Partial<SproutEvidence>>({});
  const [stage, setStage] = useState("retrieving");
  const [error, setError] = useState<string | null>(null);
  const [older, setOlder] = useState<SproutMessage[]>([]);
  const [before, setBefore] = useState<number | null | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [viewport, setViewport] = useState({ height: window.visualViewport?.height ?? window.innerHeight, mobile: window.innerWidth < 640 });
  const abort = useRef<AbortController | null>(null);
  const run = useRef<{ threadId: string; id: string } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const previousThread = useRef(threadId);
  const scope = farmId ?? "platform";
  const threads = useQuery({ queryKey: ["sprout", "threads", userId],
    queryFn: () => api<SproutThread[]>("/chat/threads"), enabled: open, retry: false });
  const history = useQuery({ queryKey: ["sprout", "thread", userId, threadId],
    queryFn: () => api<SproutHistory>(`/chat/threads/${threadId}`), enabled: open && Boolean(threadId), retry: false,
    refetchInterval: query => query.state.data?.run?.state === "running" ? 2000 : false,
  });
  const fallback = useQuery({ queryKey: ["sprout", "knowledge", userId],
    queryFn: () => api<{ sections: { id: string; title: string; text: string }[] }>("/chat/knowledge"),
    enabled: open && (!available || Boolean(error)), staleTime: 300_000, retry: false,
  });
  const validHistory = history.data?.thread.farm_id === farmId ? history.data : undefined;
  const activeRun = validHistory?.run?.state === "running";
  const waiting = busy || activeRun;
  const scopeThreads = threads.data?.filter(thread => thread.farm_id === farmId) ?? [];

  const closePanel = useEffectEvent(onClose);
  useEffect(() => {
    const resize = () => setViewport({ height: window.visualViewport?.height ?? window.innerHeight, mobile: window.innerWidth < 640 });
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => { window.removeEventListener("resize", resize); window.visualViewport?.removeEventListener("resize", resize); };
  }, []);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const previousOverflow = document.body.style.overflow;
    if (viewport.mobile) document.body.style.overflow = "hidden";
    const keyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closePanel(); }
      if (event.key !== "Tab" || !viewport.mobile) return;
      const elements = [...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), textarea:not(:disabled), select:not(:disabled), input:not(:disabled), a[href], summary") ?? [])]
        .filter(element => element.getClientRects().length > 0);
      const first = elements[0]; const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    panel.current?.addEventListener("keydown", keyboard);
    const currentPanel = panel.current;
    return () => { document.body.style.overflow = previousOverflow; currentPanel?.removeEventListener("keydown", keyboard); };
  }, [open, viewport.mobile]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (!pending) return;
    setDraft(pending.text); setIntent(pending.intent); setScenario(pending.scenario);
    setSelectedOptions(pending.selectedOptionIds ?? []); setReset(false); setShowHistory(false);
    setDisplayedRevision(pending.displayedWeatherRevision);
  }, [pending]);
  const resetThreadView = useEffectEvent(() => {
    setOlder([]); setBefore(undefined); setError(null);
    if (!busy) { setDraft(""); setIntent(undefined); setScenario(undefined); setSelectedOptions([]); setDisplayedRevision(undefined); setReset(false); setStreamEvidence({}); }
  });
  useEffect(() => {
    if (previousThread.current === threadId) return;
    previousThread.current = threadId;
    resetThreadView();
  }, [threadId]);
  const handleMissing = useEffectEvent(() => {
    if (history.error instanceof ApiError && history.error.status === 404) onThread(null);
    if (history.error instanceof ApiError && history.error.status === 401) {
      abort.current?.abort();
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    }
  });
  useEffect(() => { handleMissing(); }, [history.error]);
  useEffect(() => {
    if (nearBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [streamText, validHistory?.messages.length, open]);

  function errorText(code: string) {
    if (["sprout_daily_limit", "provider_quota"].includes(code)) return t("sprout.quota");
    if (["sprout_busy", "sprout_running"].includes(code)) return t("sprout.busy");
    if (["sprout_stale_thread", "sprout_request_conflict"].includes(code)) return t("sprout.stale");
    if (code === "sprout_thread_limit") return t("sprout.threadLimit");
    if (code === "sprout_thread_full") return t("sprout.threadFull");
    if (["interrupted", "incomplete_response", "output_limit"].includes(code)) return t("sprout.interrupted");
    if (code === "cancelled") return t("sprout.cancelled");
    if (code === "expired") return t("sprout.expired");
    return t("sprout.unavailable");
  }
  function recordError(caught: unknown) {
    if (caught instanceof ApiError && caught.status === 401) {
      void queryClient.invalidateQueries({ queryKey: ["me"] }); setError("expired");
    } else setError(caught instanceof ApiError ? caught.message : "provider_error");
  }
  async function send(retry?: SproutRun) {
    if (waiting || !available) return;
    if (threadId && !validHistory) return;
    if (!consent) { setShowPrivacy(true); return; }
    const original = retry ? validHistory?.messages.find(message => message.id === retry.user_message_id)?.content : undefined;
    const text = (original ?? draft).trim();
    if (!text) return;
    setBusy(true); setError(null); setStreamText(""); setStreamEvidence({}); setSentText(text); setShowHistory(false);
    nearBottom.current = true;
    const controller = new AbortController(); abort.current = controller;
    let completed = false;
    const received: { thread?: SproutThread; run?: SproutRun; answer?: SproutMessage } = {};
    try {
      let thread = validHistory?.thread;
      if (!thread) {
        thread = await api<SproutThread>("/chat/threads", { method: "POST", body: { farm_id: farmId, language: language() } });
        onThread(thread.id);
      }
      const id = thread.id;
      received.thread = thread;
      await streamApi(`/chat/threads/${id}/messages`, {
        text, request_id: crypto.randomUUID(), expected_version: thread.version,
        language: language(), intent: retry ? null : intent, scenario: retry ? null : scenario,
        allow_ai: consent, displayed_weather_revision: retry ? null : displayedRevision ?? null,
        selected_option_ids: retry ? [] : selectedOptions, reset_scenario: retry ? false : reset,
        retry_run_id: retry?.id ?? null,
      }, controller.signal, (kind, raw) => {
        if (kind === "started") { const data = raw as { run: SproutRun }; received.run = data.run; run.current = { threadId: id, id: data.run.id }; }
        if (kind === "status") setStage((raw as { stage: string }).stage);
        if (kind === "evidence") setStreamEvidence(raw as SproutEvidence);
        if (kind === "delta") setStreamText(current => current + (raw as { text: string }).text);
        if (kind === "error") { setError((raw as { code: string }).code); setStreamText(""); }
        if (kind === "done") { received.answer = (raw as { message: SproutMessage }).message; completed = true; setDraft(""); setIntent(undefined); setScenario(undefined); setSelectedOptions([]); setReset(false); }
      });
    } catch (caught) {
      if (controller.signal.aborted) setError("cancelled"); else recordError(caught);
      setStreamText("");
    } finally {
      if (completed && received.thread && received.run && received.answer) {
        const key = ["sprout", "thread", userId, received.thread.id];
        await queryClient.cancelQueries({ queryKey: key });
        if (!controller.signal.aborted) {
          const current = queryClient.getQueryData<SproutHistory>(key);
          queryClient.setQueryData(key, completedHistory(current, received.thread, received.run, text, received.answer));
        }
      }
      setBusy(false); run.current = null; abort.current = null; setSentText("");
      if (completed) { setStreamText(""); setStreamEvidence({}); }
      await queryClient.invalidateQueries({ queryKey: ["sprout", "thread", userId] });
      await queryClient.invalidateQueries({ queryKey: ["sprout", "threads", userId] });
    }
  }
  function language(): "en" | "hi" | "te" {
    return i18n.resolvedLanguage === "hi" ? "hi" : i18n.resolvedLanguage === "te" ? "te" : "en";
  }
  async function stop() {
    const target = run.current ?? (validHistory?.run ? { threadId: validHistory.thread.id, id: validHistory.run.id } : null);
    if (target) {
      try { await api(`/chat/threads/${target.threadId}/runs/${target.id}/cancel`, { method: "POST" }); }
      catch (caught) { recordError(caught); }
    }
    abort.current?.abort();
    await queryClient.invalidateQueries({ queryKey: ["sprout", "thread", userId] });
  }
  async function remove() {
    if (!threadId || !window.confirm(t("sprout.confirmDelete"))) return;
    try {
      await api(`/chat/threads/${threadId}`, { method: "DELETE" });
      queryClient.removeQueries({ queryKey: ["sprout", "thread", userId, threadId] });
      onThread(null); setDraft(""); setStreamEvidence({}); setShowHistory(false);
      await queryClient.invalidateQueries({ queryKey: ["sprout", "threads", userId] });
    } catch (caught) { recordError(caught); }
  }
  async function loadOlder() {
    const cursor = before === undefined ? validHistory?.before : before;
    if (!cursor || !threadId) return;
    setLoadingOlder(true);
    try {
      const page = await api<SproutHistory>(`/chat/threads/${threadId}?before=${cursor}`);
      setOlder(current => [...page.messages, ...current]); setBefore(page.before);
    } catch (caught) { recordError(caught); } finally { setLoadingOlder(false); }
  }
  const chooseStarter = (text: string, nextIntent: SproutAsk["intent"]) => {
    setDraft(text); setIntent(nextIntent); setScenario(undefined); setSelectedOptions([]); setDisplayedRevision(undefined); setReset(false); input.current?.focus();
  };
  const onInputKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !viewport.mobile) {
      event.preventDefault(); void send();
    }
  };
  const currentScenario = scenario ?? validHistory?.thread.scenario;
  const lastRun = validHistory?.run;
  const messages = [...older, ...(validHistory?.messages ?? [])];

  return <section ref={panel} id="sprout-panel" className="sprout-panel" hidden={!open}
    role="dialog" aria-modal={viewport.mobile ? true : undefined} aria-labelledby="sprout-title"
    style={{ "--sprout-viewport-height": `${viewport.height}px` } as CSSProperties}>
    <header className="sprout-header">
      <img src="/sprout.png" alt="" width="42" height="42" /><h2 id="sprout-title">Sprout</h2>
      <div className="sprout-actions">
        <button type="button" disabled={waiting} onClick={() => setShowHistory(value => !value)} aria-label={t("sprout.history")} title={t("sprout.history")} aria-pressed={showHistory}><Clock3 size={18} /></button>
        <button type="button" disabled={waiting} onClick={() => { onThread(null); setDraft(""); setStreamEvidence({}); setShowHistory(false); setScenario(undefined); }} aria-label={t("sprout.newChat")} title={t("sprout.newChat")}><MessageSquarePlus size={18} /></button>
        <button type="button" onClick={onClose} aria-label={t("sprout.close")} title={t("sprout.close")}><X size={20} /></button>
      </div>
    </header>
    <div className="sprout-scope">
      <select aria-label={t("sprout.scope")} value={scope} disabled={waiting} onChange={event => onScope(event.target.value === "platform" ? null : event.target.value)}>
        <option value="platform">{t("sprout.platform")}</option>
        {farmId && !farms.data?.some(farm => farm.id === farmId) && <option value={farmId}>{t("common.loading")}</option>}
        {farms.data?.map(farm => <option key={farm.id} value={farm.id}>{farm.name}</option>)}
      </select>
      <button type="button" className="sprout-icon" aria-label={t("sprout.privacy")} title={t("sprout.privacy")} onClick={() => setShowPrivacy(value => !value)}><Info size={17} /></button>
      {threadId && <button type="button" className="sprout-icon" disabled={waiting} aria-label={t("sprout.delete")} title={t("sprout.delete")} onClick={() => void remove()}><Trash2 size={17} /></button>}
    </div>
    {farmId && <div className="sprout-scenario">
      <span>{currentScenario?.irrigation ? `${t("sprout.scenario")}: ${t(`farms.irrigation.${currentScenario.irrigation}`)}` : t("sprout.savedSettings")}
        {currentScenario?.season ? ` / ${t(`history.seasonName.${currentScenario.season}`)}` : ""}</span>
      <button className="sprout-icon" type="button" disabled={waiting} aria-label={t("sprout.reset")} title={t("sprout.reset")} onClick={() => { setReset(true); setScenario(undefined); setSelectedOptions([]); setDisplayedRevision(undefined); setDraft(t("sprout.resetQuestion")); setIntent(undefined); input.current?.focus(); }}><RotateCcw size={15} /></button>
    </div>}
    <div ref={scroll} className="sprout-transcript" onScroll={() => { const element = scroll.current; if (element) nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90; }}>
      {showHistory ? <div className="sprout-history"><h3>{t("sprout.history")}</h3>
        {threads.isPending && <Spinner />}
        {scopeThreads.map(thread => <button key={thread.id} type="button" onClick={() => { onThread(thread.id); setShowHistory(false); setStreamEvidence({}); }}><span>{thread.title}</span><small>{new Date(thread.updated_at).toLocaleDateString(i18n.resolvedLanguage)}</small></button>)}
      </div> : <>
        {(before === undefined ? validHistory?.before : before) && <button type="button" className="sprout-text-action" disabled={loadingOlder} onClick={() => void loadOlder()}>{t("sprout.older")}</button>}
        {history.isFetching && !validHistory && threadId && <Spinner />}
        {messages.length === 0 && !sentText && <div className="sprout-empty"><img src="/sprout.png" width="76" height="76" alt="" /><h3>{t("sprout.empty")}</h3>
          <div className="sprout-starters">
            {farmId && <><button type="button" onClick={() => chooseStarter(t("sprout.soilQuestion"), "soil")}>{t("sprout.soilQuestion")}</button><button type="button" onClick={() => chooseStarter(t("sprout.nextQuestion"), "next_crop")}>{t("sprout.nextQuestion")}</button></>}
            <button type="button" onClick={() => chooseStarter(t("sprout.helpQuestion"), "help")}>{t("sprout.helpQuestion")}</button>
          </div>
        </div>}
        <div role="log" aria-label={t("sprout.history")} aria-live="off">
          {messages.map(message => <article key={message.id} className={`sprout-message ${message.role}`}>
            <p>{message.role === "assistant" ? message.content.replace(/[\[\u3010]((?:kb|planner|farm):[^\]\u3011\s]+)[\]\u3011]/g, (match, id: string) => {
              const index = message.evidence.sources?.findIndex(source => source.id === id) ?? -1;
              return index >= 0 ? `[${index + 1}]` : match;
            }) : message.content}</p>{message.role === "assistant" && <Sources evidence={message.evidence} />}
          </article>)}
          {sentText && !messages.some(message => message.role === "user" && message.content === sentText && message.id === lastRun?.user_message_id) && <article className="sprout-message user"><p>{sentText}</p></article>}
          {busy && <article className="sprout-message assistant"><p>{streamText}</p><Sources evidence={streamEvidence} /></article>}
        </div>
        {waiting && <div className="sprout-status" role="status"><Spinner />{t(busy ? stage === "answering" ? "sprout.answering" : "sprout.retrieving" : "sprout.running")}</div>}
        {!busy && !error && lastRun && ["failed", "interrupted", "cancelled"].includes(lastRun.state) && <p className="sprout-notice">{errorText(lastRun.error_code ?? "interrupted")}</p>}
        {error && <p role="alert" className="sprout-notice">{errorText(error)}</p>}
        {(history.isError || threads.isError) && <p role="alert" className="sprout-notice">{t("sprout.unavailable")}</p>}
        {!available && <p className="sprout-notice">{t("sprout.unavailable")}</p>}
        {!waiting && lastRun && ["failed", "interrupted", "cancelled"].includes(lastRun.state) && <button type="button" className="sprout-text-action" disabled={!available || !consent} onClick={() => void send(lastRun)}><RotateCcw size={15} />{t("sprout.retry")}</button>}
        {!busy && error && <Sources evidence={streamEvidence} />}
        {fallback.data && <details className="sprout-sources"><summary>{t("sprout.fallback")}</summary>{fallback.data.sections.map(section => <details key={section.id}><summary>{section.title}</summary><p>{section.text}</p></details>)}</details>}
      </>}
    </div>
    {(showPrivacy || !consent) && <div className="sprout-privacy"><p>{t("sprout.privacyText")}</p>
      <label><input type="checkbox" checked={consent} onChange={event => {
        setConsent(event.target.checked);
        try { sessionStorage.setItem(`sprout-consent:${userId}`, event.target.checked ? "1" : "0"); } catch {}
        if (event.target.checked) setShowPrivacy(false);
      }} />{t("sprout.consent")}</label>
    </div>}
    <form className="sprout-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea ref={input} rows={2} maxLength={2000} aria-label={t("sprout.message")} placeholder={t("sprout.placeholder")}
        value={draft} disabled={waiting} onChange={event => { setDraft(event.target.value); setIntent(undefined); }} onKeyDown={onInputKey} />
      <div className="sprout-compose-actions"><small>{draft.length}/2000</small>{waiting ?
        <button type="button" onClick={() => void stop()} aria-label={t("sprout.stop")} title={t("sprout.stop")}><Square size={17} /></button> :
        <button type="submit" disabled={!draft.trim() || !consent || !available || Boolean(threadId && !validHistory)} aria-label={t("sprout.send")} title={t("sprout.send")}><SendHorizontal size={19} /></button>}
      </div>
    </form>
    <span className="sr-only" role="status">{!waiting && lastRun?.state === "complete" ? t("sprout.saved") : ""}</span>
  </section>;
}