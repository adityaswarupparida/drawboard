import type { NodeKind } from "../shared/diagram";

const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const PATHS: Record<NodeKind, React.ReactNode> = {
  client: (<><rect x="2" y="3" width="16" height="11" rx="1.5" /><path d="M7 18h6M10 14v4" /></>),
  cdn: (<><circle cx="10" cy="10" r="7.5" /><ellipse cx="10" cy="10" rx="3.2" ry="7.5" /><path d="M2.5 10h15" /></>),
  lb: (<><circle cx="4" cy="10" r="2" /><circle cx="16" cy="4" r="2" /><circle cx="16" cy="16" r="2" /><path d="M6 10h3l5-5M9 10l5 5" /></>),
  gateway: <path d="M3 4v12M3 10h13M12 6l4 4-4 4" />,
  service: (<><rect x="3" y="3" width="14" height="14" rx="3" /><path d="M7 8h6M7 12h4" /></>),
  socket: <path d="M3 7h12M12 4l3 3-3 3M17 13H5M8 10l-3 3 3 3" />,
  auth: (<><rect x="4" y="9" width="12" height="8.5" rx="1.5" /><path d="M7 9V6.5a3 3 0 0 1 6 0V9" /></>),
  db: (<><ellipse cx="10" cy="5" rx="6.5" ry="2.5" /><path d="M3.5 5v10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V5M3.5 10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5" /></>),
  cache: <path d="M11 2 4 11h5l-1 7 7-9h-5z" />,
  queue: (<><rect x="2" y="3.5" width="16" height="3" rx="1" /><rect x="2" y="8.5" width="16" height="3" rx="1" /><rect x="2" y="13.5" width="16" height="3" rx="1" /></>),
  worker: (<><circle cx="10" cy="10" r="3" /><path d="M10 2v3M10 15v3M2 10h3M15 10h3M4.3 4.3l2.1 2.1M13.6 13.6l2.1 2.1M4.3 15.7l2.1-2.1M13.6 6.4l2.1-2.1" /></>),
  storage: <path d="M3 5h14M4.5 5l1.3 12h8.4L15.5 5" />,
  search: (<><circle cx="8.5" cy="8.5" r="5.5" /><path d="M12.5 12.5 17 17" /></>),
  limiter: (<><path d="M3 14a7 7 0 0 1 14 0M10 14l3.5-4" /><circle cx="10" cy="14" r="1" /></>),
  push: <path d="M5 14V9a5 5 0 0 1 10 0v5l1.5 2h-13zM8.5 18h3" />,
  external: (<><path d="M11 3h6v6M17 3l-8 8" /><path d="M14 11v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>),
};

export function KindIcon({ kind }: { kind: NodeKind }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <g {...P}>{PATHS[kind] ?? PATHS.service}</g>
    </svg>
  );
}

export function Logo() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="2.5" y="3" width="7" height="5" rx="1.2" />
      <rect x="14.5" y="3" width="7" height="5" rx="1.2" />
      <rect x="8.5" y="16" width="7" height="5" rx="1.2" />
      <path d="M6 8v3.5h12V8M12 11.5V16" />
    </svg>
  );
}

export function MicIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
    </svg>
  );
}
