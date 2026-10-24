import { createBrowserRouter } from "react-router";
import { Layout, RequireAuth } from "./components/Layout";
import { AccountPage } from "./pages/AccountPage";
import { AuthPage } from "./pages/AuthPage";
import { FarmPage } from "./pages/FarmPage";
import { FarmsPage } from "./pages/FarmsPage";
import { NewFarmPage } from "./pages/NewFarmPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ForgotPasswordPage, ResetPasswordPage } from "./pages/PasswordPages";

export const router = createBrowserRouter([
  { path: "/login", element: <AuthPage mode="login" /> },
  { path: "/register", element: <AuthPage mode="register" /> },
  { path: "/forgot-password", element: <ForgotPasswordPage /> },
  { path: "/reset-password", element: <ResetPasswordPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <FarmsPage /> },
          { path: "farms/new", element: <NewFarmPage /> },
          { path: "farms/:farmId", element: <FarmPage /> },
          { path: "account", element: <AccountPage /> },
        ],
      },
    ],
  },
  { path: "*", element: <NotFoundPage /> },
]);
