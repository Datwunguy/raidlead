# RaidLead

## Deploying changes to styles.css / app.js

The site's source lives in `public/`: `index.html` (markup shell),
`styles.css`, and `app.js`, referenced with a cache-busting `?v=` query
string:

```html
<link rel="stylesheet" href="styles.css?v=20260918">
...
<script src="app.js?v=20260918"></script>
```

`vercel.json` serves both files with `Cache-Control: public, max-age=31536000,
immutable` — a returning visitor's browser will **never** re-check for a
newer version at the same URL, so the `?v=` has to change whenever a file
does.

**That's automatic now.** Vercel runs `npm run build` (`scripts/build.js`),
which copies `public/` to `dist/` (what Vercel actually serves), minifies
`dist/app.js`, and replaces both `?v=` values in `dist/index.html` with a
hash of each file's contents. So:

- Don't bump `?v=` by hand; the values in `public/index.html` are
  placeholders the build overwrites.
- Edit the readable source in `public/`, never `dist/` (it's gitignored and
  rebuilt on every deploy).
- `npm run build` locally shows exactly what will be served. The build fails,
  and the deploy with it, if `index.html` doesn't have exactly one `app.js?v=`
  and one `styles.css?v=`.
- Top-level function names survive minification on purpose: `onclick="..."`
  attributes and string-named handlers call them.
