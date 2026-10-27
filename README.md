# Drawboard

Design software architecture together with your team and an AI architect, on one live canvas.

Describe a system ("Design a URL shortener for 100M links a month") by typing or talking, and the AI draws it box by box. Drag, add, rename and connect boxes yourself; the AI sees your edits and keeps working with you. Teammates in the same project see every change, cursor and chat message instantly.

## What it does

- **Talk to draw.** Ask for a system or a change; Llama 3.3 turns it into small, validated diagram edits that play out live on the canvas.
- **Edit together.** Humans and the AI change the diagram through the same edit operations, so nobody overwrites anybody. Every box shows who added it.
- **Ask questions.** "What happens if the database goes down?" highlights the boxes at risk and explains why.
- **Design review.** One click runs a multi-step review (reliability, scaling, security, cost) as a durable Workflow and pins findings to the boxes they're about.
- **Walkthrough.** Anyone, viewers included, can step through the diagram box by box in the order a request travels. Each stop spotlights the box and explains, in plain words, what it is and why this design needs it. It can also be read aloud and advance on its own.
- **Live voice.** Press the mic and just talk, hands-free. The AI says a short line right away, draws while it thinks, then answers out loud. Filler like "okay" or "mm" is ignored, so it doesn't start a new turn or cut the AI off.
- **History and undo.** Every change is logged with its author; undo rolls back the last change.
- **Workspaces and sharing.** Sign in with email (or GitHub/Google), organise projects into workspaces, invite teammates as owner, editor or viewer, or share a single project with a guest.

## Built with

- **Cloudflare Workers** serves the React app and the API from one Worker, with **Hono** for routing and **Better Auth** for sign-in.
- **Durable Objects** via the **Agents SDK**: each project gets its own `CanvasAgent`. It holds the diagram, checks every edit, syncs everyone over WebSockets and runs one AI request at a time. Chat, history and undo live in its built-in SQLite.
- **Workers AI**: Llama 3.3 70B designs, edits, answers questions and writes walkthroughs. Deepgram Flux handles live speech-to-text and Aura-2 does the speaking.
- **Workflows** runs the design review, one retried step per area.
- **D1** stores users, workspaces, projects, roles and invites.
- **React Flow** draws the canvas.

## Architecture

```
Browser  (React + React Flow)
   │
   │  REST /api/*                      WebSocket /agents/canvas-agent/:projectId
   ▼                                    ▼
Worker  (Hono)  ──  Better Auth session check  ──►  D1
   │                                    │            users, workspaces, projects,
   │                                    │            roles, invites
   │                                    │
   │                                    │  role checked here,
   │                                    │  identity passed in trusted headers
   │                                    ▼
   │                              CanvasAgent  (Durable Object, one per project)
   │
   │                                • validates edits, applies them, broadcasts state
   │                                • chat, history and undo snapshots in SQLite
   │                                • AI turns: Llama 3.3 → edits, replayed live
   │                                • walkthroughs: streamed, cached per diagram
   │                                • voice calls: Flux STT → AI turn → Aura-2 TTS
   │
   │                                starts  ──►  DesignReviewWorkflow
   │                                             4 durable steps, findings back via RPC
   │
   └──  /api/projects/:id/speak  ──►  Aura-2  (walkthrough narration)
```

Key design choice: the AI never rewrites the whole diagram. It returns a list of small edits (`add_node`, `connect`, `update_node`, `remove_node`, …) that go through the same validation as human edits (`src/shared/apply.ts`). Invalid edits are skipped and reported, positions come from a deterministic auto-layout, and the shared Zod schema (`src/shared/diagram.ts`) is used by the browser, the server and the AI path.

## Run it locally

You'll need Node 22+, pnpm and a Cloudflare account (Workers AI runs on Cloudflare even in local dev).

```bash
pnpm install
cp .dev.vars.example .dev.vars        # then set BETTER_AUTH_SECRET to a long random string
npx wrangler login                    # needed for Workers AI
pnpm db:migrate:local                 # create the local D1 tables
pnpm dev                              # http://localhost:5173
```

Create an account on the sign-in page. To try collaboration, open a second browser profile, sign up as someone else, and share an invite link from **Members & sharing** or the project's **Share** button.

No Cloudflare login? `OFFLINE=1 pnpm dev` runs everything except the AI features.

### Optional: GitHub / Google sign-in

Add these to `.dev.vars` (and as secrets when deploying). The buttons appear automatically.

- GitHub OAuth app callback: `http://localhost:5173/api/auth/callback/github`
- Google OAuth client redirect URI: `http://localhost:5173/api/auth/callback/google`

```
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

## Deploy

```bash
npx wrangler d1 create drawboard-db           # copy the database_id into wrangler.jsonc
pnpm db:migrate:remote
npx wrangler secret put BETTER_AUTH_SECRET     # long random string
pnpm run deploy
```

If you add GitHub or Google sign-in, set their secrets the same way and use your `*.workers.dev` URL in the OAuth callback URLs.

## Project layout

```
src/shared/     diagram types, edit schema, apply + layout (used by browser and server)
src/server/     Worker entry, REST API, auth, canvas agent, review workflow, AI prompts
src/client/     React app: pages, canvas (React Flow), chat panel, sharing
migrations/     D1 schema
```

## Limitations

- The AI quality depends on Llama 3.3 following the JSON edit format; invalid edits are dropped rather than applied.
- Undo is per project, not per person: it rolls back the most recent change by anyone.
- Invite links are shared manually; there's no email delivery.
