# Prototype Comments

Figma-style comments for static frontend prototypes. Add one script tag and reviewers can pin comments to any element, reply, @mention people and resolve threads.

```html
<script
  src="https://…/comments.js"
  data-notion="https://www.notion.so/acme/Checkout-v2-Feedback-1a2b3c…"
  data-endpoint="https://<your-function-url>.lambda-url.<region>.on.aws"
  defer
></script>
```

Each prototype's comments live in **its own Notion database**, named by `data-notion`. Every screen of the prototype shares that database, and the **Page** column tells screens apart. Comments are read and written through a small, stateless backend (`server/`, one AWS Lambda function). Anyone who can open the prototype can read its comments. Commenting requires "Sign in with Notion", so every comment is attributed to a verified person.

### Adding comments to a new prototype

1. In Notion, inside the **hub page** (e.g. "Prototype Feedback"), duplicate any existing feedback database and rename it. Or run `npm run notion:setup -- "Checkout v2"`, which creates one and prints the script tag.
2. Copy the database's link into `data-notion` and add the tag to the prototype's `<head>`.

The backend only accepts databases inside the hub page that have the expected columns, so a script tag can't point it anywhere else.

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

While comment mode is on, clicks don't reach the prototype, so buttons and links won't fire.

## Configuration

Set these on the script tag:

| Attribute | Default | |
| --- | --- | --- |
| `data-notion` | | The prototype's Notion feedback database (link or id). Turns on Notion storage. |
| `data-endpoint` | | Backend URL, required with `data-notion`. |
| `data-storage` | `remote` with `data-notion`, else `local` | `local` keeps comments in this browser only. |
| `data-project` | hostname | Groups comments in `local` mode. |
| `data-page-key` | `path` | Set to `path+hash` if the prototype uses hash routing (`#/checkout`). |
| `data-shortcuts` | `true` | Set to `false` if the prototype uses the **C** key itself. |

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

With no `.env`, the backend uses **fake Notion**: data is kept in `.data/fake-notion.json`, and "Sign in with Notion" shows a pick-a-user page. In fake mode `data-notion` can be any short name (the demo uses `data-notion="demo-shop"`). To use real Notion locally, fill in `.env` (see below) and point the demo's `data-notion` at a real feedback database. No code changes are needed.

### How data flows

```
comments.js                          server/ (Lambda, stateless)                    Notion
 local copy ◄── sync every 20s ──── GET  /threads?db=…&since=…  ── 1 query ────► this prototype's database
 outbox ─────── send in order ─────► POST /threads, /threads/:id/comments ──────► rows + comments
                                     PATCH/DELETE /threads/:id
 sign-in popup ───────────────────► /auth/start → Notion OAuth → /auth/callback
                                     (signs a session token; nothing is stored)
```

- The overlay always renders from a **local copy** in the browser, so it's instant and works offline.
- **Writes** apply locally right away and go into an **outbox** that's sent in order, retried with backoff and kept across reloads. A rejected write shows "Not sent · Retry".
- Syncs ask only for threads **changed since the last sync**, with a full sync every 5 minutes to catch deletions. A thread's full comments are fetched when it's opened, which also picks up replies made directly in Notion.
- The backend holds the Notion credentials and sets the author from the verified session, so nobody can post as someone else. It only touches feedback databases inside the hub page, and it remembers each check for 10 minutes. It has no database of its own.

### Connecting real Notion

You need workspace admin rights for steps 1 and 3.

1. **Internal integration** (reads and writes the data): [notion.so/profile/integrations](https://www.notion.so/profile/integrations) → New integration → *Internal*. Enable *Read content, Update content, Insert content, Read comments, Insert comments,* and *Read user information including email addresses*. Copy its secret into `NOTION_TOKEN` in `.env`.
2. **Hub page:** create a page such as "Prototype Feedback", then use its ••• menu → *Connections* → add the integration. Everything created inside it later is automatically accessible. Put its link in `NOTION_HUB_PAGE_ID`, then create the first feedback database with `npm run notion:setup -- "<prototype name>"`.
3. **Public integration** (only for "Sign in with Notion"): New integration → *Public*. Set the redirect URI to `<API URL>/auth/callback` (locally `http://localhost:8787/auth/callback`). Copy the OAuth client ID and secret into `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET`. The access token Notion returns is discarded; it's only used to learn who signed in. Only members of your workspace can sign in.
4. Set `SESSION_SECRET` (e.g. `openssl rand -base64 32`) and `ALLOWED_ORIGINS` (your prototypes' origins).

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
  src/stores/notion.ts   Notion API (data sources, version 2026-03-11) and the hub-page check
  src/stores/memory.ts   fake Notion for development and tests
  src/identity.ts        Notion OAuth sign-in, and the fake sign-in
  src/session.ts         HMAC-signed stateless tokens
  src/lambda.ts          AWS Lambda (Function URL) entry
  src/dev-entry.ts       loaded by the Vite dev server
  src/local.ts           standalone local server (npm run preview)
  scripts/notion-setup.ts  creates a prototype's feedback database
demo/                    a small multi-page prototype to try it on
test/                    unit tests
```

The overlay renders inside a shadow root attached to `<html>`, so the prototype's CSS can't affect it and its CSS can't affect the prototype.

## Data model

Each thread is one row in the prototype's Notion database. Its replies are Notion comments on that row.

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

- Deploy script for the Lambda function (Function URL, environment variables).
- Migrating `local` exports into Notion.
- Editing comments, unread indicators, image attachments.
