import { Navigate, Outlet, useLocation, useOutletContext } from "react-router";
import { authClient, type SessionUser } from "../auth-client";

export function RequireAuth() {
  const { data, isPending } = authClient.useSession();
  const location = useLocation();
  if (isPending) return <div className="center muted">Loading…</div>;
  if (!data) {
    const next = location.pathname + location.search;
    return <Navigate to={`/login${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`} replace />;
  }
  return <Outlet context={{ user: data.user satisfies SessionUser }} />;
}

export function useUser(): SessionUser {
  return useOutletContext<{ user: SessionUser }>().user;
}
