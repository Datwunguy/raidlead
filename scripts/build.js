// ============================================================
//  scripts/build.js — Vercel's build step (vercel.json buildCommand).
//
//  Copies public/ to dist/ (what Vercel serves), minifies dist/app.js, and
//  stamps index.html's ?v= cache busters with each file's content hash. The
//  repo keeps the readable source, and the cache busters change exactly when
//  a file does -- no bumping them by hand. Run it locally with `npm run build`
//  to see the output; dist/ is never committed.
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { minify } = require('terser');

const ROOT = path.join(__dirname, '..');
const SRC  = path.join(ROOT, 'public');
const OUT  = path.join(ROOT, 'dist');

const contentHash = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.cpSync(SRC, OUT, { recursive: true });

  // Top-level names are left alone (terser's default for scripts): the page's
  // onclick="..." attributes, and code that picks handlers by name, call them.
  const source = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  const { code } = await minify(source, { compress: true, mangle: true, format: { comments: false } });
  if (!code) throw new Error('terser produced no output');
  fs.writeFileSync(path.join(OUT, 'app.js'), code);

  let html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  for (const file of ['app.js', 'styles.css']) {
    const pattern = new RegExp(`${file.replace('.', '\\.')}\\?v=[\\w-]+`, 'g');
    const found = (html.match(pattern) || []).length;
    if (found !== 1) throw new Error(`expected one ${file}?v= in index.html, found ${found}`);
    html = html.replace(pattern, `${file}?v=${contentHash(fs.readFileSync(path.join(OUT, file)))}`);
  }
  fs.writeFileSync(path.join(OUT, 'index.html'), html);

  console.log(`app.js: ${Math.round(source.length / 1024)}KB -> ${Math.round(code.length / 1024)}KB`);
})().catch(err => { console.error(err); process.exit(1); });
