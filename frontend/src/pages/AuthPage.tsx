import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { ApiError } from "../api/client";
import { useAuthCapabilities, useGuest, useLogin, useMe, useRegister } from "../api/hooks";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { Logo } from "../components/Logo";
import { ThemeToggle } from "../components/ThemeToggle";
import { Alert, Button, Field, Input } from "../components/ui";
import { useTheme } from "../lib/theme";

type Mode = "login" | "register";
export type AuthNotice = "reset" | "deleted" | "guestExpired";

/** Server messages are English; the common cases get the user's language. */
export function useAuthError() {
  const { t } = useTranslation();
  return (error: Error | null, mode?: Mode): string | null => {
    if (!error) return null;
    if (error instanceof ApiError) {
      if (error.message.startsWith("guest_") || error.message === "registered_required") return t("guest.requestError");
      if (error.status === 429) return t("auth.tooMany");
      if (error.status === 401 && mode === "login") return t("auth.invalidLogin");
      if (error.status === 409 && mode === "register") return t("auth.emailTaken");
    }
    return error.message;
  };
}

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      {/* A survey-grid backdrop and the data sources behind the advice. */}
      <aside className="auth-aside relative hidden flex-col justify-between overflow-hidden p-12 text-stone-900 lg:flex">
        <Logo light={theme === "dark"} />
        <div>
          <p className="text-xs font-semibold tracking-[0.2em] text-amber-700 uppercase">{t("auth.eyebrow")}</p>
          <p className="mt-4 max-w-md text-3xl leading-tight font-semibold">{t("app.tagline")}</p>
          <ul className="mt-8 max-w-md divide-y divide-stone-900/10 border-y border-stone-900/10 text-sm text-stone-700">
            {(["pitch1", "pitch2", "pitch3"] as const).map((key, index) => (
              <li key={key} className="flex gap-4 py-3">
                <span className="tabular w-5 shrink-0 font-mono text-xs leading-5 text-stone-500">0{index + 1}</span>
                {t(`auth.${key}`)}
              </li>
            ))}
          </ul>
          <dl className="mt-8 grid max-w-md grid-cols-3 gap-4 text-xs">
            {(["power", "modis", "soilgrids"] as const).map((key) => (
              <div key={key} className="border-l border-amber-600/50 pl-3">
                <dt className="font-semibold">{t(`auth.source.${key}`)}</dt>
                <dd className="mt-0.5 text-stone-600">{t(`auth.source.${key}Detail`)}</dd>
              </div>
            ))}
          </dl>
        </div>
        <p className="text-xs text-stone-600">{t("app.footer")}</p>
      </aside>

      <div className="flex flex-col bg-stone-50 px-4 py-6">
        <div className="flex justify-end gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
        <div className="flex flex-1 items-center justify-center py-6">
          <div className="w-full max-w-sm">
            <div className="mb-8 lg:hidden">
              <Logo />
            </div>
            <h1 className="text-2xl font-semibold">{title}</h1>
            <p className="mt-1 text-sm text-stone-500">{subtitle}</p>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  minLength = 10,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  minLength?: number;
}) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        required
        minLength={minLength}
        maxLength={128}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="pr-16"
      />
      <button
        type="button"
        onClick={() => setShow((current) => !current)}
        className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-stone-500 hover:text-stone-800"
      >
        {show ? t("auth.hide") : t("auth.show")}
      </button>
    </div>
  );
}

export function AuthPage({ mode }: { mode: Mode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const me = useMe();
  const login = useLogin();
  const register = useRegister();
  const guest = useGuest();
  const capabilities = useAuthCapabilities();
  const errorText = useAuthError();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const mutation = mode === "login" ? login : register;

  if (me.data && !me.isError) return <Navigate to={me.data.is_guest && mode === "register" ? "/account" : "/"} replace />;

  const state = location.state as { from?: string; notice?: AuthNotice } | null;
  const destination = state?.from?.startsWith("/") && !state.from.startsWith("//") ? state.from : "/";

  function submit(event: FormEvent) {
    event.preventDefault();
    const onSuccess = () => navigate(destination, { replace: true });
    if (mode === "login") login.mutate({ email: form.email, password: form.password }, { onSuccess });
    else register.mutate(form, { onSuccess });
  }

  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));

  return (
    <AuthShell
      title={t(mode === "login" ? "auth.loginTitle" : "auth.registerTitle")}
      subtitle={t(mode === "login" ? "auth.loginSubtitle" : "auth.registerSubtitle")}
    >
      {state?.notice && (
        <div className="mt-6">
          <Alert tone="info">{t(state.notice === "reset" ? "auth.resetDone" : state.notice === "guestExpired" ? "guestErrors.guest_expired" : "account.deleted")}</Alert>
        </div>
      )}
      <form className="mt-8 space-y-5" onSubmit={submit}>
        {mode === "register" && (
          <Field label={t("auth.name")}>
            {(id) => (
              <Input
                id={id}
                required
                maxLength={80}
                autoComplete="name"
                value={form.name}
                onChange={(event) => set("name")(event.target.value)}
              />
            )}
          </Field>
        )}
        <Field label={t("auth.email")}>
          {(id) => (
            <Input
              id={id}
              type="email"
              required
              autoComplete="email"
              value={form.email}
              onChange={(event) => set("email")(event.target.value)}
            />
          )}
        </Field>
        <Field label={t("auth.password")} hint={mode === "register" ? t("auth.passwordHint") : undefined}>
          {(id) => (
            <PasswordInput
              id={id}
              value={form.password}
              onChange={set("password")}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={mode === "register" ? 10 : 1}
            />
          )}
        </Field>
        {mode === "login" && (
          <p className="-mt-2 text-right text-sm">
            <Link to="/forgot-password" className="font-medium text-emerald-700 hover:text-emerald-800">
              {t("auth.forgot")}
            </Link>
          </p>
        )}

        {mutation.error && <Alert tone="error">{errorText(mutation.error, mode)}</Alert>}

        <Button type="submit" className="w-full" busy={mutation.isPending}>
          {t(mode === "login" ? "auth.login" : "auth.register")}
        </Button>
      </form>

      {capabilities.data?.guest_enabled && (
        <div className="mt-6 space-y-3 border-t border-stone-200 pt-5">
          <p className="text-xs leading-relaxed text-stone-600">{t("guest.disclosure", { days: capabilities.data.retention_days })}</p>
          <p className="text-xs text-stone-600">{t("guest.limits", { farms: capabilities.data.max_farms, requests: capabilities.data.sprout_daily_requests })}</p>
          <Button type="button" variant="secondary" className="w-full" busy={guest.isPending} disabled={mutation.isPending || me.isPending}
            onClick={() => guest.mutate(undefined, { onSuccess: () => navigate(destination, { replace: true }) })}>
            <UserRound className="mr-2 size-4" aria-hidden="true" />{t("guest.continue")}
          </Button>
          {guest.error && <Alert tone="error">{errorText(guest.error)}</Alert>}
        </div>
      )}

      <p className="mt-6 text-center text-sm">
        <Link
          to={mode === "login" ? "/register" : "/login"}
          state={location.state}
          className="font-medium text-emerald-700 hover:text-emerald-800"
        >
          {t(mode === "login" ? "auth.toRegister" : "auth.toLogin")}
        </Link>
      </p>
    </AuthShell>
  );
}
