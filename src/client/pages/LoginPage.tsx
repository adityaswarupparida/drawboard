import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { authClient } from "../auth-client";
import { Logo } from "../icons";

type Providers = { github: boolean; google: boolean };

export function LoginPage() {
  const [params] = useSearchParams();
  const next = params.get("next") || "/";
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<Providers>({ github: false, google: false });

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json() as Promise<{ providers: Providers }>)
      .then((j) => setProviders(j.providers))
      .catch(() => {});
  }, []);

  if (!isPending && session) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res =
      mode === "up"
        ? await authClient.signUp.email({ name: name.trim() || email.split("@")[0]!, email, password })
        : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (res.error) {
      setError(res.error.message || "That didn't work. Check your details and try again.");
      return;
    }
    navigate(next, { replace: true });
  };

  const social = (provider: "github" | "google") =>
    authClient.signIn.social({ provider, callbackURL: next, errorCallbackURL: "/login" });

  const inviting = next.startsWith("/invite/");

  return (
    <div className="center">
      <div className="card auth">
        <div className="brand">
          <Logo />
          <b>Drawboard</b>
        </div>
        <div>
          <h1>{mode === "in" ? "Sign in" : "Create your account"}</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            {inviting ? "Sign in or create an account to accept your invite." : "Design systems together with your team and an AI architect."}
          </p>
        </div>

        {(providers.github || providers.google) && (
          <>
            <div className="row" style={{ display: "grid", gap: 8 }}>
              {providers.github && <button className="btn" type="button" onClick={() => social("github")}>Continue with GitHub</button>}
              {providers.google && <button className="btn" type="button" onClick={() => social("google")}>Continue with Google</button>}
            </div>
            <div className="divider">or with email</div>
          </>
        )}

        <form onSubmit={submit}>
          {mode === "up" && (
            <label>
              <span className="label">Name</span>
              <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </label>
          )}
          <label>
            <span className="label">Email</span>
            <input id="email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </label>
          <label>
            <span className="label">Password</span>
            <input
              id="password"
              className="input"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "up" ? "new-password" : "current-password"}
            />
          </label>
          {error && <div className="err">{error}</div>}
          <button className="btn dark" type="submit" disabled={busy} style={{ justifyContent: "center", padding: "9px 12px" }}>
            {busy ? "One moment…" : mode === "in" ? "Sign in" : "Create account"}
          </button>
        </form>
        <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }}>
          {mode === "in" ? "New here? " : "Already have an account? "}
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setMode(mode === "in" ? "up" : "in");
              setError(null);
            }}
          >
            {mode === "in" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}
