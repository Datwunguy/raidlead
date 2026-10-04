// ============================================================
//  scripts/build.js — Vercel's build step (vercel.json buildCommand).
//
//  Copies public/ to dist/ (what Vercel serves), minifies dist/app.js, and
//  stamps index.html's ?v= cache busters (app.js, styles.css, games.js) with
//  each file's content hash. The
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

// The site's content policy (vercel.json) runs no inline JavaScript, so an
// onclick="..." would silently do nothing in a browser. Buttons and inputs
// name their action instead (data-click="fn", or act() in app.js), and only
// actions listed in app.js's ACTIONS run. Fail the build on an inline handler,
// or on an action that isn't listed.
function checkPageActions(html, js) {
  const problems = [];
  const code = js.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n'); // not comments
  for (const [file, text] of [['index.html', html], ['app.js', code]]) {
    for (const m of text.matchAll(/(?:^|[\s'"`])(on[a-z]+)\s*=\s*["'\\]/g)) problems.push(`${file}: inline ${m[1]}= handler`);
  }
  const list = js.match(/\nconst ACTIONS = \{([\s\S]*?)\};/);
  if (!list) return [...problems, 'app.js: no ACTIONS list'];
  const listed = new Set(list[1].split(',').map(s => s.trim()).filter(Boolean));
  const named = [
    ...[html, js].flatMap(t => [...t.matchAll(/data-(?:click|change|input|blur|keydown|mousedown)="([A-Za-z_$][\w$]*)"/g)].map(m => m[1])),
    ...[...js.matchAll(/act\('[a-z]+', '([A-Za-z_$][\w$]*)'/g)].map(m => m[1]),
  ];
  for (const n of new Set(named)) if (!listed.has(n)) problems.push(`action "${n}" isn't in ACTIONS`);
  return problems;
}

(async () => {
  const problems = checkPageActions(fs.readFileSync(path.join(SRC, 'index.html'), 'utf8'), fs.readFileSync(path.join(SRC, 'app.js'), 'utf8'));
  if (problems.length) throw new Error('Page actions:\n  ' + problems.join('\n  '));

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.cpSync(SRC, OUT, { recursive: true });

  const source = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  const { code } = await minify(source, { compress: true, mangle: true, format: { comments: false } });
  if (!code) throw new Error('terser produced no output');
  fs.writeFileSync(path.join(OUT, 'app.js'), code);

  let html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  for (const file of ['app.js', 'styles.css', 'games.js']) {
    const pattern = new RegExp(`${file.replace('.', '\\.')}\\?v=[\\w-]+`, 'g');
    const found = (html.match(pattern) || []).length;
    if (found !== 1) throw new Error(`expected one ${file}?v= in index.html, found ${found}`);
    html = html.replace(pattern, `${file}?v=${contentHash(fs.readFileSync(path.join(OUT, file)))}`);
  }
  fs.writeFileSync(path.join(OUT, 'index.html'), html);

  console.log(`app.js: ${Math.round(source.length / 1024)}KB -> ${Math.round(code.length / 1024)}KB`);
})().catch(err => { console.error(err); process.exit(1); });
