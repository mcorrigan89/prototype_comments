# Prototype Comments

Figma-style comments for static frontend prototypes. Add one script tag and reviewers can pin comments to any element, reply, @mention people and resolve threads.

```html
<script
  src="https://…/comments.js"
  data-notion="https://app.notion.com/p/acme/Prototype-Feedback-Kite-3ff97c…"
  data-endpoint="https://<your-function-url>.lambda-url.<region>.on.aws"
  defer
></script>
```

Each prototype has **its own Notion page**, named by `data-notion`. Its comments go into a **Comments** database inside that page, which is created automatically on the first comment. Every screen of the prototype shares it, and the **Page** column tells screens apart. Comments are read and written through a small, stateless backend (`server/`, one AWS Lambda function). Anyone who can open the prototype can read its comments. Commenting requires "Sign in with Notion", so every comment is attributed to a verified person.

### Adding comments to a new prototype

1. Create a page in Notion for the prototype, anywhere you like.
2. On that page: **••• → Connections →** add the integration. This is what lets the backend use it.
3. Copy the page's link (••• → Copy link) into `data-notion` and add the tag to the prototype's `<head>`.

You can write notes on the page as usual. The Comments database appears below them after the first comment. A link straight to an existing Comments database also works.

The backend can only see pages someone has connected to the integration, and it only writes to a database with the comment columns. So a script tag can't point it anywhere else.

A browser-only mode with no backend is also available: use `data-storage="local"` and `data-project` instead of `data-notion`.

## Using it

| Action | How |
| --- | --- |
| Leave a comment | Press **C** (or the 💬 toolbar button), then click anywhere |
| Post / new line | **Enter** / **Shift+Enter** |
| Mention someone | Type **@** and pick from the list |
| Close / cancel / exit comment mode | **Esc** |
| Show / hide pins | **Shift+C** |
| All comments | The list button in the toolbar. Filter by page and by Open/Resolved |
| Sign in / out, sync status, export | The sidebar footer |
| Move the toolbar out of the way | Drag its ⠿ handle; it snaps to the nearest corner or edge. Each reviewer's choice is remembered |

While comment mode is on, clicks don't reach the prototype, so buttons and links won't fire.

## Configuration

Set these on the script tag:

| Attribute | Default | |
| --- | --- | --- |
| `data-notion` | | The prototype's Notion page (link or id). Turns on Notion storage. |
| `data-endpoint` | | Backend URL, required with `data-notion`. |
| `data-storage` | `remote` with `data-notion`, else `local` | `local` keeps comments in this browser only. |
| `data-project` | hostname | Groups comments in `local` mode. |
| `data-page-key` | `path` | Set to `path+hash` if the prototype uses hash routing (`#/checkout`). |
| `data-shortcuts` | `true` | Set to `false` if the prototype uses the **C** key itself. |
| `data-toolbar` | `bottom-center` | Where the toolbar starts: `top-` or `bottom-` + `left`, `center` or `right`. |

With Notion, the people you can @mention are your workspace's members. In `local` mode, set them before the script loads:

```html
<script>
  window.PrototypeComments = {
    users: [{ id: 'ana', name: 'Ana Ruiz', email: 'ana@example.com' }],
  };
</script>
```

### Making pins more robust

Pins are anchored to the clicked element, not to a fixed x/y. The selector prefers, in order: `data-pc-anchor`, a unique `data-testid`, a unique non-generated `id`, and then a structural path. If the selector stops matching after the prototype changes, the pin finds the element again by its text. If the element is gone entirely, the pin falls back to its original page position and gets a dashed outline.

To keep a pin attached no matter how the layout changes, add an anchor to elements you expect to be reworked:

```html
<button data-pc-anchor="hero-cta">Shop now</button>
```

Pins on elements that are currently hidden (a closed modal, a collapsed menu) are hidden too. They still appear in the sidebar marked **Not visible**.

## Development

```sh
npm install
npm run dev        # demo prototype on :5173 + backend on :8787 (fake Notion, fake sign-in)
npm test           # unit tests: overlay, sync engine, backend, Notion mapping
npm run typecheck
npm run build      # → dist/comments.js (single IIFE) and server/dist/ (Lambda bundle)
npm run preview    # serves the demo with the *built* comments.js and backend
```

With no `.env`, the backend uses **fake Notion**: data is kept in `.data/fake-notion.json`, and "Sign in with Notion" shows a pick-a-user page. In fake mode any link or short name works for `data-notion`. To use real Notion locally, fill in `.env` (see below); the demo already points at the "Prototype Feedback - Kite" page. No code changes are needed.

### Hosting

- **`comments.js`** is published to GitHub Pages on every push to `main` (`.github/workflows/pages.yml`). Use `https://mcorrigan89.github.io/prototype_comments/comments.js` for the latest, or `…/v<version>/comments.js` for a version that never changes.
- **The backend** runs on Cloudflare Workers (`wrangler.jsonc`, entry `server/src/worker.ts`):
  ```sh
  npx wrangler login         # once
  npm run worker:secrets     # uploads NOTION_TOKEN, NOTION_CLIENT_ID/SECRET and a SESSION_SECRET from .env
  npm run worker:deploy      # prints the backend URL → use it as data-endpoint
  npm run worker:dev         # the Worker in Cloudflare's local runtime, on :8788, using .env
  ```
  Set `ALLOWED_ORIGINS` in `wrangler.jsonc` to your prototypes' origins. A `*` matches one part of a hostname, so auto-generated buckets can be allowed by naming convention: `http://govwell-*-prototype.s3-website.us-east-2.amazonaws.com`. Anyone can create a bucket that fits such a pattern, so moving prototypes to a domain you own is the stronger option long term. Set the OAuth connection's redirect URI to `<backend URL>/auth/callback`.
- **AWS Lambda** later: `server/src/lambda.ts` is the same handler behind a Lambda Function URL (`npm run build:server` → `server/dist/`).

### How data flows

```
comments.js                          server/ (Lambda, stateless)                    Notion
 local copy ◄── sync every 20s ──── GET  /threads?db=…&since=…  ── 1 query ────► Comments database in the page
 outbox ─────── send in order ─────► POST /threads, /threads/:id/comments ──────► rows + comments
                                     PATCH/DELETE /threads/:id
 sign-in popup ───────────────────► /auth/start → Notion OAuth → /auth/callback
                                     (signs a session token; nothing is stored)
```

- The overlay always renders from a **local copy** in the browser, so it's instant and works offline.
- **Writes** apply locally right away and go into an **outbox** that's sent in order, retried with backoff and kept across reloads. A rejected write shows "Not sent · Retry".
- Syncs ask only for threads **changed since the last sync**, with a full sync every 5 minutes to catch deletions. A thread's full comments are fetched when it's opened, which also picks up replies made directly in Notion.
- The backend holds the Notion credentials and sets the author from the verified session, so nobody can post as someone else. It only touches pages connected to the integration, and only writes to their Comments database. It remembers which database a link points to for 10 minutes. It has no database of its own.

### Connecting real Notion

You need workspace admin rights for steps 1 and 2.

1. **Internal integration** (reads and writes the data): [notion.so/profile/integrations](https://www.notion.so/profile/integrations) → New integration → *Internal*. Enable *Read content, Update content, Insert content, Read comments, Insert comments,* and *Read user information including email addresses*. Copy its secret into `NOTION_TOKEN` in `.env`.
2. **Public integration** (only for "Sign in with Notion"): New integration → *Public*. Set the redirect URI to `<API URL>/auth/callback` (locally `http://localhost:8787/auth/callback`). Copy the OAuth client ID and secret into `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET`. The access token Notion returns is discarded; it's only used to learn who signed in. Only members of your workspace can sign in.
3. Set `SESSION_SECRET` (e.g. `openssl rand -base64 32`) and `ALLOWED_ORIGINS` (your prototypes' origins).

See `.env.example` for every setting.

**Still to verify against real Notion:**
- What a comment posted with a custom display name looks like (name and avatar).
- That `http://localhost` is accepted as an OAuth redirect URI. If not, use a tunnel such as `cloudflared` for local sign-in.
- Notion's API can't delete comments, so only unsent comments can be discarded. Thread authors can still delete whole threads, which moves the row to Notion's trash.

### Layout

```
src/                     the overlay (comments.js)
  index.ts               entry: reads config, picks the storage adapter, mounts the overlay
  config.ts              script-tag attributes
  api.ts                 HTTP contract shared with the backend
  types.ts               Thread / Comment / Pin / User and the StorageAdapter interface
  anchor.ts              building selectors, dropping pins, re-finding elements
  storage/local.ts       browser-only storage
  storage/remote.ts      local copy + outbox + sync against the backend
  ui/                    overlay UI (shadow DOM)
server/
  src/handler.ts         routes, auth, validation; runtime-agnostic
  src/stores/notion.ts   Notion API (data sources, version 2026-03-11): finds or creates each page's Comments database
  src/stores/memory.ts   fake Notion for development and tests
  src/identity.ts        Notion OAuth sign-in, and the fake sign-in
  src/session.ts         HMAC-signed stateless tokens
  src/worker.ts          Cloudflare Workers entry
  src/lambda.ts          AWS Lambda (Function URL) entry
  src/dev-entry.ts       loaded by the Vite dev server
  src/local.ts           standalone local server (npm run preview)
demo/                    a small multi-page prototype to try it on
test/                    unit tests
```

The overlay renders inside a shadow root attached to `<html>`, so the prototype's CSS can't affect it and its CSS can't affect the prototype.

## Data model

Each thread is one row in the prototype page's Comments database. Its replies are Notion comments on that row.

| Column | Type | Holds |
| --- | --- | --- |
| Feedback | title | The first comment's text |
| Status | select | Open / Resolved |
| Reviewer | person | Who started the thread |
| Mentioned | person | People @mentioned in the first comment |
| Resolved by | person | |
| Page | text | Which screen, e.g. `/cart.html` |
| Link | url | Opens the prototype at that pin |
| Comment count | number | Kept up to date so syncs notice new replies |
| Pin | text | JSON: where to put the pin back (below) |
| Client ID | text | The overlay's id for the thread, which makes retries safe |

```jsonc
// Pin
{
  "selector": "#checkout",
  "tag": "button",
  "text": "Checkout",
  "offset": { "x": 0.42, "y": 0.6 },   // position inside the element (0–1)
  "page": { "x": 640, "y": 1320 },     // fallback document coordinates
  "viewport": { "w": 1440, "h": 900 }
}
```

## Roadmap

- Deploying the backend from GitHub Actions, and the move to AWS Lambda.
- Migrating `local` exports into Notion.
- Editing comments, unread indicators, image attachments.
