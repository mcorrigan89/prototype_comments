# Prototype Comments

Figma-style comments for static frontend prototypes. Add one script tag and reviewers can pin comments to any element, reply, @mention people and resolve threads.

```html
<script src="https://your-bucket.s3.amazonaws.com/comments.js" data-project="checkout-v2" defer></script>
```

Storage is pluggable. Right now comments are saved in the browser (`localStorage`). A Notion backend is planned (see [Roadmap](#roadmap)).

## Using it

| Action | How |
| --- | --- |
| Leave a comment | Press **C** (or the 💬 toolbar button), then click anywhere |
| Post / new line | **Enter** / **Shift+Enter** |
| Mention someone | Type **@** and pick from the list |
| Close / cancel / exit comment mode | **Esc** |
| Show / hide pins | **Shift+C** |
| All comments | The list button in the toolbar. Filter by page and by Open/Resolved |
| Share or back up | Export / Import JSON in the sidebar footer |

While comment mode is on, clicks don't reach the prototype, so buttons and links won't fire.

## Configuration

Set these on the script tag:

| Attribute | Default | |
| --- | --- | --- |
| `data-project` | hostname | Groups comments. Use one per prototype. |
| `data-storage` | `local` | Storage adapter. |
| `data-page-key` | `path` | Set to `path+hash` if the prototype uses hash routing (`#/checkout`). |
| `data-shortcuts` | `true` | Set to `false` if the prototype uses the **C** key itself. |

Set the people who can be @mentioned before the script loads:

```html
<script>
  window.PrototypeComments = {
    users: [{ id: 'ana', name: 'Ana Ruiz', email: 'ana@example.com' }],
  };
</script>
```

Anyone who has commented is added to the list automatically.

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
npm run dev        # Vite dev server → http://localhost:5173/demo/
npm test           # unit tests (Vitest + happy-dom)
npm run typecheck
npm run build      # → dist/comments.js (single IIFE file, ~14 kB gzipped)
npm run preview    # builds, then serves the demo using dist/comments.js as a classic <script defer>
```

To deploy, upload `dist/comments.js` (and the `.map` if you want readable stack traces) somewhere the prototypes can load it, for example the same S3 bucket.

### Layout

```
src/
  index.ts            entry: reads config, picks the storage adapter, mounts the overlay
  config.ts           script-tag attributes + window.PrototypeComments
  types.ts            Thread / Comment / Pin / User and the StorageAdapter interface
  anchor.ts           building selectors, dropping pins, re-finding elements
  storage/
    index.ts          adapter registry (data-storage="…")
    local.ts          localStorage adapter
  ui/
    app.ts            state, page event handling, pins, popover, toolbar
    sidebar.ts        thread list
    composer.ts       comment box with @mention autocomplete
    modal.ts          "Who's commenting?" prompt
    dom.ts, icons.ts  helpers
    styles.css        inlined into the shadow root at build time
demo/                 a small multi-page prototype to try it on
test/                 unit tests
```

The overlay renders inside a shadow root attached to `<html>`, so the prototype's CSS can't affect it and its CSS can't affect the prototype.

## Data model

Each thread maps one-to-one to a future Notion row:

```jsonc
{
  "id": "…",
  "project": "checkout-v2",
  "page": "/cart.html",
  "url": "https://…/cart.html",
  "status": "open",              // or "resolved"
  "createdBy": { "id": "…", "name": "Michael" },
  "pin": {
    "selector": "#checkout",
    "tag": "button",
    "text": "Checkout",
    "offset": { "x": 0.42, "y": 0.6 },   // position inside the element (0–1)
    "page": { "x": 640, "y": 1320 },     // fallback document coordinates
    "viewport": { "w": 1440, "h": 900 }
  },
  "comments": [
    { "id": "…", "author": { … }, "body": "…", "mentions": [{ "id": "…", "name": "Ana Ruiz" }], "createdAt": "…" }
  ]
}
```

## Roadmap

- **Notion adapter.** Add `src/storage/notion.ts` implementing `StorageAdapter` against a small proxy (AWS Lambda): sign in with Notion, read and write a feedback database, cache responses. Set `auth: 'signin'` so the overlay calls `signIn()` instead of asking for a name. Register it in `storage/index.ts`, then switch prototypes over with `data-storage="notion" data-endpoint="https://…"`. Use the JSON export to migrate existing local comments.
- Editing comments, unread indicators, image attachments.
