import { useEffect, useRef, useState, type ReactNode } from "react";
import { colorFor, type Role } from "../../shared/protocol";

export function Avatar({ id, name, image, small }: { id: string; name: string; image?: string | null; small?: boolean }) {
  return (
    <span className={`pp${small ? " sm" : ""}`} style={{ background: colorFor(id) }} title={name}>
      {image ? <img src={image} alt="" /> : (name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  return <span className="role">{role}</span>;
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row">
          <h2 style={{ fontSize: "1.1rem" }}>{title}</h2>
          <span className="spacer" />
          <button className="btn small" type="button" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="linkbox">
      <input ref={ref} className="input" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Invite link" />
      <button
        className="btn"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            ref.current?.select();
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(ms).toLocaleDateString();
}

export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
