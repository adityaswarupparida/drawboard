import { Link } from "react-router";

export function NotFound() {
  return (
    <div className="center">
      <div style={{ textAlign: "center", display: "grid", gap: 10 }}>
        <h1 style={{ fontFamily: "var(--display)" }}>Page not found</h1>
        <p className="muted" style={{ margin: 0 }}>This page doesn't exist, or you don't have access to it.</p>
        <Link className="btn" to="/" style={{ justifySelf: "center" }}>Go to your workspace</Link>
      </div>
    </div>
  );
}
