import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import { api } from "../api";

export const LAST_WS_KEY = "drawboard:lastWorkspace";

export function Home() {
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .workspaces()
      .then((list) => {
        let last: string | null = null;
        try {
          last = localStorage.getItem(LAST_WS_KEY);
        } catch {
          /* storage blocked */
        }
        const pick = list.find((w) => w.id === last) ?? list[0];
        if (pick) setTarget(`/w/${pick.id}`);
        else setError("No workspace found.");
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  if (target) return <Navigate to={target} replace />;
  return <div className="center muted">{error ?? "Loading your workspace…"}</div>;
}
