# RaidLead

## Deploying changes to styles.css / app.js

`public/index.html` used to be one file with inline `<style>`/`<script>`
blocks. It's now split into `public/index.html` (markup shell),
`public/styles.css`, and `public/app.js`, referenced with a cache-busting
`?v=` query string:

```html
<link rel="stylesheet" href="styles.css?v=20260918">
...
<script src="app.js?v=20260918"></script>
```

`vercel.json` serves both files with `Cache-Control: public, max-age=31536000,
immutable` — a returning visitor's browser will **never** re-check for a
newer version at the same URL. That's the whole point (repeat visits skip
re-downloading ~98KB of CSS/JS), but it means:

**Any time you edit `styles.css`, bump the `?v=` on its `<link>` tag.**
**Any time you edit `app.js`, bump the `?v=` on its `<script>` tag.**

Any different value works (today's date, e.g. `20260919`, is the convention
already in use) — it just has to change, or every browser with a warm cache
will keep serving the old file forever, silently. They're independent, so
bump only the one that actually changed. There's no build step here to
automate this, so it's a manual habit until one exists.
