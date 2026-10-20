# Agent instructions

Figma-style comments for static prototypes hosted on S3. There are two parts:

- **`comments.js`** is the overlay (`src/`). It's built by Vite into a single IIFE and served from GitHub Pages.
- **The backend** (`server/`) is a stateless API on Cloudflare Workers. It reads and writes Notion and handles "Sign in with Notion".

`README.md` covers usage, configuration, the data model and the code layout. This file covers **setting it up and operating it**: Notion, sign-in, deploying, and adding it to a prototype. It also lists the mistakes we've already made once.

## Ground rules

- **Never print, echo, log or paste secret values.** That includes `.env`, `.dev.vars`, and the output of commands that might contain them. To check that a value is set, test for it without showing it, e.g. `grep -c '^NOTION_TOKEN=.' .env`. If the user pastes a secret into chat, tell them it only needs to go in `.env`.
- Secrets live in `.env` (git-ignored) locally and in Cloudflare Worker secrets in production. Nowhere else.
- **`.env.example` is committed and must stay blank.** Only keys and comments go in it, never values.
- `SESSION_SECRET` for production exists **only in Cloudflare**, not in `.env`. Running `npm run worker:secrets` with no arguments generates a new one, which **signs everyone out**. To update other secrets, name them, e.g. `npm run worker:secrets -- NOTION_CLIENT_ID NOTION_CLIENT_SECRET`.
- Commit and push only when the user asks.
- `wrangler` is pinned to an exact version on purpose. Don't let `npm audit fix` or upgrades move it to a release that's only days old.

## Commands

```sh
npm install
npm run dev            # demo on :5173 + backend on :8787 (fake or real Notion, depending on .env)
npm test               # vitest, should be all green
npm run typecheck
npm run build          # dist/comments.js + server/dist/
npm run preview        # demo using the built comments.js and backend, on :4173
npm run worker:dev     # the Worker in Cloudflare's local runtime on :8788 (writes .dev.vars from .env)
npm run worker:deploy  # deploys the backend
npm run worker:secrets [-- KEY ...]   # uploads secrets from .env to Cloudflare (see ground rules)
```

Run `npm run typecheck && npm test` after changes.

## How the pieces fit

```
prototype on S3 ──<script src=comments.js data-notion=… data-endpoint=…>
       │
       ▼
Cloudflare Worker (server/src/worker.ts → handler.ts)
  ├─ NOTION_TOKEN          internal connection: reads/writes the Comments database in each prototype's page
  ├─ NOTION_CLIENT_ID/…    OAuth connection: sign-in only, learns who you are, token discarded
  └─ SESSION_SECRET        signs session tokens (HMAC); no database of its own
```

- Each prototype has **one Notion page**, linked from `data-notion`. On the first comment, the backend creates an inline **Comments** database inside that page and arranges its columns.
- Anyone can read comments without signing in. Posting requires sign-in, and only members of the workspace can sign in.
- **Two separate Notion connections are needed, and they're easy to mix up.** The *internal* one holds the data. The *OAuth* one handles sign-in.

## Setting up from scratch

### 1. Notion: the internal connection (data)

You need workspace admin rights. In Notion: **Settings → Connections → Develop or manage connections**, or go to `https://app.notion.com/developers/connections` directly. Notion now calls these "connections"; older docs call them "integrations".

1. Create a new connection of type **Internal**, in the workspace that holds the prototype pages. We use the name "Prototype Comments Internal".
2. Capabilities: **Read content, Update content, Insert content, Read comments, Insert comments, Read user information including email addresses.**
3. Copy the **Internal Integration Secret** into `NOTION_TOKEN` in `.env`.

### 2. Notion: the OAuth connection (sign-in)

1. Create a new connection that uses **OAuth** (public). Restrict it to the **same workspace**. A connection that spans workspaces caused a `MemcachedCrossCellError` when we tried to add it to a page.
2. Capabilities: **only** *Read user information including email addresses*. It needs no content access.
3. Redirect URIs (add both):
   - `https://prototype-comments.mcorrigan89.workers.dev/auth/callback` (production)
   - `http://localhost:8787/auth/callback` (local dev)
4. Copy the **client ID** and **client secret** into `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET` in `.env`.

During sign-in, Notion always shows a page picker, and *Allow access* stays disabled until at least one page is ticked. The API can't skip this. Reviewers can pick any page: the backend ignores the OAuth token and never reads that page. The sign-in modal in `src/ui/modal.ts` already tells them so.

Without `NOTION_CLIENT_ID`, `npm run dev` replaces sign-in with a "pick a person" page. With a real `NOTION_TOKEN`, that page lists the workspace's real members, so you can test locally without OAuth.

### 3. Cloudflare (backend)

```sh
npx wrangler login        # once, interactive: the user runs it (`! npx wrangler login`)
npm run worker:secrets    # first time only: uploads all four, generates SESSION_SECRET
npm run worker:deploy     # prints the Worker URL, which goes in data-endpoint
```

Non-secret settings are under `vars` in `wrangler.jsonc`:

- **`ALLOWED_ORIGINS`**: the prototypes' origins (`scheme://host[:port]`, no path), comma-separated. These are allowed for CORS and as sign-in return URLs. A `*` matches exactly one hostname label (never a dot). S3 bucket hostnames are generated automatically, so we allow `http://govwell-*-prototype.s3-website.us-east-2.amazonaws.com`. The user accepted that anyone could create a bucket matching this pattern. Moving the prototypes to a domain we own would close that gap.
- **`PRIVATE_DATABASES`**: pages whose comments need sign-in to read.

After editing `wrangler.jsonc`, redeploy.

### 4. comments.js (GitHub Pages)

`.github/workflows/pages.yml` publishes on every push to `main`. The workflow runs typecheck and tests, then builds:

- `https://mcorrigan89.github.io/prototype_comments/comments.js` is the latest build.
- `https://mcorrigan89.github.io/prototype_comments/v<version>/comments.js` is pinned to `package.json`'s version.

## Adding comments to a prototype

1. Create a Notion page for the prototype or feature, in the workspace with the connections.
2. On that page: **••• → Connections →** add **Prototype Comments Internal**, the *internal* connection. Adding the OAuth connection instead is the most common mistake, and the backend will say it can't see the page.
3. Make sure the prototype's origin matches `ALLOWED_ORIGINS`.
4. Add this to the prototype's `<head>`:

   ```html
   <script
     src="https://mcorrigan89.github.io/prototype_comments/comments.js"
     data-notion="https://app.notion.com/p/<page-link>"
     data-endpoint="https://prototype-comments.mcorrigan89.workers.dev"
     defer
   ></script>
   ```

   `data-notion` accepts the page link as copied (`app.notion.com/p/…`, `notion.so/…`, with or without `?source=…`) or a bare id.

### Verifying a page is wired up

Run these without credentials, against the live backend:

```sh
API=https://prototype-comments.mcorrigan89.workers.dev
curl -s $API/health                                      # {"ok":true,"identity":"notion"}
curl -s "$API/threads?db=<page-link-or-id>"              # 200 with a threads list (empty before the first comment)
curl -sI -H "Origin: <prototype origin>" "$API/threads?db=<id>" | grep -i access-control-allow-origin   # echoes the origin
```

A 404 saying "The backend can’t see that Notion page" means step 2 above was skipped, or the wrong connection was added.

## Local development against real Notion

1. Fill in `.env`. With nothing set, `npm run dev` uses fake Notion (`.data/fake-notion.json`) and fake sign-in.
2. Restart `npm run dev` whenever `.env` changes. It reads `.env` only at startup.
3. The demo pages in `demo/` point at the test workspace's "Kite Prototype Comments" page.

The dev API prints which mode it's in: `real Notion` or `fake Notion`, and `notion` or `fake` sign-in.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `ALLOWED_ORIGINS is not set` | Production config without origins. Locally, a blank value falls back to localhost. |
| “The backend can’t see that Notion page” | The internal connection isn't added to that page (••• → Connections). |
| Notion OAuth: `redirect_uri` error | The callback URL isn't listed on the OAuth connection (setup step 2.3). |
| `MemcachedCrossCellError` when adding a connection | The connection belongs to or spans another workspace. Restrict it to this workspace. |
| “… isn't an allowed prototype origin” | The prototype's origin isn't in `ALLOWED_ORIGINS`; add it to `wrangler.jsonc` and redeploy. |
| “Only members of the workspace can comment” | The person isn't a member (guests aren't in the users list). |
| Everyone got signed out | `SESSION_SECRET` changed, probably because `worker:secrets` ran with no arguments. |
| Comments silently stay in localStorage | The script tag wasn't found or `data-notion` is missing, so it fell back to `local`. |
| New OAuth client not picked up | Upload just those two secrets (see ground rules). Locally, restart `npm run dev`. |

## Code notes

- Notion API version is `2026-03-11` (data sources). Query via `POST /data_sources/:id/query`, create rows with a `data_source_id` parent, and use `in_trash`. Keep to this version.
- The Notion API can't post as a user. Comments are posted by the internal connection with `display_name: custom` set to the signed-in person. The **Reviewer** column holds the real person.
- `server/src/handler.ts` doesn't depend on any runtime. Runtime entries are `worker.ts`, `lambda.ts` (planned move to AWS) and `local.ts`/`dev-entry.ts`. Don't import `node:fs` or `stores/memory.ts` from anything the Worker bundles.
- `comments.js` must not export anything at runtime. The IIFE global would overwrite `window.PrototypeComments`, which pages use for config.
- Tests use happy-dom. The dev API Vite plugin is skipped under `VITEST`.
