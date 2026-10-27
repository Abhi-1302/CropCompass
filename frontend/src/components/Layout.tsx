import { useTranslation } from "react-i18next";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { ApiError } from "../api/client";
import { useLogout, useMe } from "../api/hooks";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { Logo } from "./Logo";
import { Alert, Button, PageSpinner } from "./ui";
import { SproutProvider } from "../features/sprout/Sprout";

export function RequireAuth() {
  const { t } = useTranslation();
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <PageSpinner />;
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (me.isError) {
    return (
      <div className="mx-auto max-w-md p-8">
        <Alert tone="error">
          {t("common.serverDown")}{" "}
          <button type="button" className="font-medium underline" onClick={() => void me.refetch()}>
            {t("common.retry")}
          </button>
        </Alert>
      </div>
    );
  }
  return <Outlet />;
}

export function Layout() {
  const { t } = useTranslation();
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-3 py-1.5 font-medium ${isActive ? "bg-emerald-50 text-emerald-800" : "text-stone-600 hover:bg-stone-100"}`;

  return (
    <SproutProvider><div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-[1000] border-b border-stone-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2">
          <Link to="/" aria-label={t("nav.farms")}>
            <Logo />
          </Link>
          <nav className="flex w-full min-w-0 flex-wrap items-center gap-1 text-sm sm:w-auto sm:gap-2">
            <NavLink to="/" end className={link}>
              {t("nav.farms")}
            </NavLink>
            <NavLink to="/account" className={link} title={me.data?.name}>
              {t("nav.account")}
            </NavLink>
            <LanguageSwitcher className="max-w-[6.5rem]" />
            <Button
              variant="ghost"
              size="sm"
              busy={logout.isPending}
              onClick={() => logout.mutate(undefined, { onSettled: () => navigate("/login", { replace: true }) })}
            >
              {t("nav.signOut")}
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-6 sm:py-8">
        <Outlet />
      </main>
      <footer className="border-t border-stone-200 py-4 text-center text-xs text-stone-500">{t("app.footer")}</footer>
    </div></SproutProvider>
  );
}
