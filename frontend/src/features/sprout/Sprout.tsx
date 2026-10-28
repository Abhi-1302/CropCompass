import { createContext, lazy, Suspense, useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sprout as SproutIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import { api } from "../../api/client";
import { useMe } from "../../api/hooks";
import type { SproutAsk, SproutCapabilities } from "./types";
import "./sprout.css";

const Panel = lazy(() => import("./SproutPanel"));
const SproutContext = createContext<{ enabled: boolean; ask: (request: SproutAsk) => void } | null>(null);

function activeThread(userId: string, scope: string): string | null {
  try { return sessionStorage.getItem(`sprout:${userId}:${scope}`); } catch { return null; }
}

export function AskSprout(props: SproutAsk) {
  const { t } = useTranslation();
  const sprout = useContext(SproutContext);
  if (!sprout?.enabled) return null;
  return <button type="button" className="sprout-ask" onClick={() => sprout.ask(props)}>
    <SproutIcon size={16} aria-hidden="true" />{t("sprout.ask")}
  </button>;
}

export function SproutProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const userId = useMe().data?.id ?? "";
  const location = useLocation();
  const routeFarm = location.pathname.match(/^\/farms\/([0-9a-f-]{36})(?:\/|$)/i)?.[1] ?? null;
  const capabilities = useQuery({
    queryKey: ["sprout", "capabilities", userId], queryFn: () => api<SproutCapabilities>("/chat/capabilities"),
    enabled: Boolean(userId), staleTime: 60_000, retry: false,
  });
  const [open, setOpen] = useState(false);
  const [activated, setActivated] = useState(false);
  const [farmId, setFarmId] = useState<string | null>(routeFarm);
  const [threadId, setThreadId] = useState<string | null>(() => activeThread(userId, routeFarm ?? "platform"));
  const [pending, setPending] = useState<(SproutAsk & { nonce: number }) | null>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const sequence = useRef(0);
  const enabled = capabilities.data?.enabled === true;

  const selectScope = (nextFarm: string | null) => {
    setFarmId(nextFarm);
    setThreadId(activeThread(userId, nextFarm ?? "platform"));
    setPending(null);
  };
  const syncRoute = useEffectEvent(() => selectScope(routeFarm));
  useEffect(() => { syncRoute(); }, [routeFarm]);

  const selectThread = (id: string | null) => {
    setThreadId(id);
    try {
      const key = `sprout:${userId}:${farmId ?? "platform"}`;
      if (id) sessionStorage.setItem(key, id); else sessionStorage.removeItem(key);
    } catch {}
  };
  const show = () => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActivated(true);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => (trigger.current?.isConnected ? trigger.current : launcher.current)?.focus());
  };
  const ask = (request: SproutAsk) => {
    const target = request.farmId ?? routeFarm;
    if (target !== farmId) selectScope(target);
    setPending({ ...request, nonce: ++sequence.current });
    show();
  };

  return <SproutContext value={{ enabled, ask }}>
    <div className={enabled ? "sprout-shell" : undefined}>{children}</div>
    {enabled && <>
      <button ref={launcher} type="button" className="sprout-launcher" hidden={open}
        onClick={show} aria-label={t("sprout.open")} title={t("sprout.open")}
        aria-expanded={open} aria-controls="sprout-panel">
        <img src="/sprout.png" width="64" height="64" alt="" />
        <span className="sprout-launcher-label">Sprout</span>
      </button>
      {activated && <Suspense fallback={null}><Panel key={`${userId}:${farmId ?? "platform"}`}
        open={open} onClose={close} userId={userId} farmId={farmId} onScope={selectScope}
        threadId={threadId} onThread={selectThread} pending={pending}
        available={capabilities.data?.available === true} />
      </Suspense>}
    </>}
  </SproutContext>;
}