import type { FormEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { ApiError } from "../api/client";
import { useChangePassword, useDeleteAccount, useExportData, useMe } from "../api/hooks";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { Alert, Button, Card, Field, SectionHeader } from "../components/ui";
import { PasswordInput, useAuthError, type AuthNotice } from "./AuthPage";

function ChangePassword() {
  const { t } = useTranslation();
  const change = useChangePassword();
  const errorText = useAuthError();
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [mismatch, setMismatch] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (form.next !== form.confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    change.mutate(
      { current_password: form.current, new_password: form.next },
      { onSuccess: () => setForm({ current: "", next: "", confirm: "" }) },
    );
  }

  const wrong = change.error instanceof ApiError && change.error.status === 400;
  return (
    <Card>
      <SectionHeader title={t("account.passwordTitle")} subtitle={t("account.passwordSub")} />
      <form className="max-w-sm space-y-4" onSubmit={submit}>
        <Field label={t("account.currentPassword")}>
          {(id) => (
            <PasswordInput
              id={id}
              value={form.current}
              onChange={set("current")}
              autoComplete="current-password"
              minLength={1}
            />
          )}
        </Field>
        <Field label={t("auth.newPassword")} hint={t("auth.passwordHint")}>
          {(id) => <PasswordInput id={id} value={form.next} onChange={set("next")} autoComplete="new-password" />}
        </Field>
        <Field label={t("auth.confirmPassword")}>
          {(id) => <PasswordInput id={id} value={form.confirm} onChange={set("confirm")} autoComplete="new-password" />}
        </Field>
        {mismatch && <Alert tone="error">{t("auth.mismatch")}</Alert>}
        {change.error && <Alert tone="error">{wrong ? t("account.wrongPassword") : errorText(change.error)}</Alert>}
        {change.isSuccess && <Alert tone="info">{t("account.passwordChanged")}</Alert>}
        <Button type="submit" busy={change.isPending}>
          {t("account.changePassword")}
        </Button>
      </form>
    </Card>
  );
}

function DeleteAccount() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const remove = useDeleteAccount();
  const errorText = useAuthError();
  const [password, setPassword] = useState("");
  const [sure, setSure] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    const notice: AuthNotice = "deleted";
    remove.mutate(password, { onSuccess: () => navigate("/login", { replace: true, state: { notice } }) });
  }

  const wrong = remove.error instanceof ApiError && remove.error.status === 400;
  return (
    <Card className="border-red-200">
      <SectionHeader title={t("account.deleteTitle")} subtitle={t("account.deleteSub")} />
      <form className="max-w-sm space-y-4" onSubmit={submit}>
        <Field label={t("account.deletePassword")}>
          {(id) => (
            <PasswordInput id={id} value={password} onChange={setPassword} autoComplete="current-password" minLength={1} />
          )}
        </Field>
        <label className="flex items-start gap-2 text-sm text-stone-700">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-red-700"
            checked={sure}
            onChange={(event) => setSure(event.target.checked)}
          />
          {t("account.deleteConfirm")}
        </label>
        {remove.error && <Alert tone="error">{wrong ? t("account.wrongPassword") : errorText(remove.error)}</Alert>}
        <Button type="submit" variant="danger" busy={remove.isPending} disabled={!sure || !password}>
          {t("account.delete")}
        </Button>
      </form>
    </Card>
  );
}

export function AccountPage() {
  const { t } = useTranslation();
  const me = useMe();
  const exportData = useExportData();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900">{t("account.title")}</h1>
        <p className="mt-1 text-sm text-stone-500">{t("account.subtitle", { name: me.data?.name, email: me.data?.email })}</p>
      </div>
      <ChangePassword />
      <Card>
        <SectionHeader title={t("account.languageTitle")} subtitle={t("account.languageSub")} />
        <LanguageSwitcher />
      </Card>
      <Card>
        <SectionHeader title={t("account.exportTitle")} subtitle={t("account.exportSub")} />
        <Button variant="secondary" busy={exportData.isPending} onClick={() => exportData.mutate()}>
          {t("account.export")}
        </Button>
        {exportData.isSuccess && <p role="status" className="mt-3 text-sm text-emerald-700">{t("quality.exportStarted")}</p>}
        {exportData.error && (
          <div className="mt-3">
            <Alert tone="error">{exportData.error.message}</Alert>
          </div>
        )}
      </Card>
      <DeleteAccount />
    </div>
  );
}
