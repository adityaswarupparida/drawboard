import "@xyflow/react/dist/style.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { RequireAuth } from "./components/RequireAuth";
import { CanvasPage } from "./pages/CanvasPage";
import { Home } from "./pages/Home";
import { InvitePage } from "./pages/InvitePage";
import { LoginPage } from "./pages/LoginPage";
import { NotFound } from "./pages/NotFound";
import { WorkspacePage } from "./pages/WorkspacePage";
import { WorkspaceSettings } from "./pages/WorkspaceSettings";

const router = createBrowserRouter([
  { path: "/login", Component: LoginPage },
  {
    path: "/",
    Component: RequireAuth,
    children: [
      { index: true, Component: Home },
      { path: "w/:workspaceId", Component: WorkspacePage },
      { path: "w/:workspaceId/settings", Component: WorkspaceSettings },
      { path: "p/:projectId", Component: CanvasPage },
      { path: "invite/:token", Component: InvitePage },
    ],
  },
  { path: "*", Component: NotFound },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
