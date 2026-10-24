import type { FormEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { ApiError } from "../api/client";
import { useForgotPassword, useResetPassword } from "../api/hooks";
import { Alert, Button, Field, Input } from "../components/ui";
import { AuthShell, PasswordInput, useAuthError, type AuthNotice } from "./AuthPage";

export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const forgot = useForgotPassword();
  const errorText = useAuthError();
  const [email, setEmail] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    forgot.mutate(email);
  }

  return (
    <AuthShell title={t("auth.forgotTitle")} subtitle={t("auth.forgotSubtitle")}>
      {forgot.isSuccess ? (
        <div className="mt-8">
          <Alert tone={forgot.data.delivery === "email" ? "info" : "warning"}>
            {t(forgot.data.delivery === "email" ? "quality.resetAccepted" : forgot.data.delivery === "development" ? "quality.resetDev" : "quality.resetUnavailable")}
          </Alert>
        </div>
      ) : (
        <form className="mt-8 space-y-5" onSubmit={submit}>
          <Field label={t("auth.email")}>
            {(id) => (
              <Input
                id={id}
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </Field>
          {forgot.error && <Alert tone="error">{errorText(forgot.error)}</Alert>}
          <Button type="submit" className="w-full" busy={forgot.isPending}>
            {t("auth.sendLink")}
          </Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm">
        <Link to="/login" className="font-medium text-emerald-700 hover:text-emerald-800">
          {t("auth.backToLogin")}
        </Link>
      </p>
    </AuthShell>
  );
}

function tokenFromUrl(): string {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
  if (token) window.history.replaceState(window.history.state, "", window.location.pathname);
  return token;
}

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const reset = useResetPassword();
  const errorText = useAuthError();
  const [token] = useState(tokenFromUrl);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    const notice: AuthNotice = "reset";
    reset.mutate({ token, password }, { onSuccess: () => navigate("/login", { replace: true, state: { notice } }) });
  }

  const invalid = reset.error instanceof ApiError && reset.error.status === 400;
  return (
    <AuthShell title={t("auth.resetTitle")} subtitle={t("auth.resetSubtitle")}>
      {!token ? (
        <div className="mt-8">
          <Alert tone="error">{t("auth.resetMissing")}</Alert>
        </div>
      ) : (
        <form className="mt-8 space-y-5" onSubmit={submit}>
          <Field label={t("auth.newPassword")} hint={t("auth.passwordHint")}>
            {(id) => <PasswordInput id={id} value={password} onChange={setPassword} autoComplete="new-password" />}
          </Field>
          <Field label={t("auth.confirmPassword")}>
            {(id) => <PasswordInput id={id} value={confirm} onChange={setConfirm} autoComplete="new-password" />}
          </Field>
          {mismatch && <Alert tone="error">{t("auth.mismatch")}</Alert>}
          {reset.error && <Alert tone="error">{invalid ? t("auth.resetInvalid") : errorText(reset.error)}</Alert>}
          <Button type="submit" className="w-full" busy={reset.isPending}>
            {t("auth.savePassword")}
          </Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm">
        <Link
          to={token && !invalid ? "/login" : "/forgot-password"}
          className="font-medium text-emerald-700 hover:text-emerald-800"
        >
          {t(token && !invalid ? "auth.backToLogin" : "auth.askAgain")}
        </Link>
      </p>
    </AuthShell>
  );
}
