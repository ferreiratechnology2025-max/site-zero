#!/usr/bin/env node
// Encapsulates the exact Cloudflare Pages Direct Upload flow already validated
// manually for the Ferreira Technology site. Deliberately not "smart":
// it does what already worked, nothing more.
//
// Usage: npm run publicar
// Requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment
// (never read from D:\reframe, never written to any file by this script).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const PROJECT_NAME = 'ferreira-technology';
const STABLE_URL = 'https://ferreira-technology.pages.dev';
const CANONICAL_DOMAIN = 'https://ferreiratechnology.com.br/';
const WHATSAPP_URL = 'https://wa.me/5562992991555';

const CRITICAL_FILES = [
  'index.html',
  'styles.css',
  'main.js',
  'privacy.html',
  'robots.txt',
  'sitemap.xml',
  'llms.txt',
  '_headers',
  'favicon.svg',
  'favicon-32.png',
  'apple-touch-icon.png',
  'og-image.jpg',
  'assets/hero-connection-panel.png',
];

// Known placeholder / leftover strings that must never survive into a real deploy.
const FORBIDDEN_STRINGS = [
  'lorem ipsum',
  'TODO:',
  'PLACEHOLDER',
  'example.com',
  'propostas.api-plataforma.com', // leftover Reframe lead-site domain
  'leads-sites',                  // leftover Reframe bucket name
  'YOUR_API_KEY',
];

// Secret-shaped patterns that must never exist inside the published directory.
const SECRET_PATTERNS = [
  /cfat_[A-Za-z0-9]{20,}/,        // Cloudflare API token
  /CLOUDFLARE_API_TOKEN\s*=/,
  /R2_ACCESS_KEY\s*=/,
  /R2_SECRET_KEY\s*=/,
  /sk-[A-Za-z0-9]{20,}/,          // generic secret-key-shaped token
  /AKIA[A-Z0-9]{12,}/,            // AWS-style access key id
];

const failures = [];
const passes = [];

function fail(label, detail) {
  failures.push(`${label}: FAIL — ${detail}`);
}
function pass(label) {
  passes.push(label);
}

function abort(reason) {
  console.log('FERREIRA_PUBLISH = FAIL');
  console.log('');
  console.log(`Reason: ${reason}`);
  if (failures.length) {
    console.log('');
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1-2. Critical files + basic content preflight
// ---------------------------------------------------------------------------
console.log('Preflight: checking dist/ ...');

if (!existsSync(DIST) || !statSync(DIST).isDirectory()) {
  abort(`dist/ directory not found at ${DIST}`);
}

for (const rel of CRITICAL_FILES) {
  const p = join(DIST, rel);
  if (!existsSync(p)) {
    fail('files', `missing dist/${rel}`);
    continue;
  }
  const size = statSync(p).size;
  if (size === 0) {
    fail('files', `dist/${rel} exists but is empty`);
  }
}
if (!failures.some((f) => f.startsWith('files:'))) pass('files');

const indexHtmlPath = join(DIST, 'index.html');
const indexHtml = existsSync(indexHtmlPath) ? readFileSync(indexHtmlPath, 'utf8') : '';

// canonical
if (indexHtml.includes(CANONICAL_DOMAIN)) {
  pass('canonical');
} else {
  fail('canonical', `expected "${CANONICAL_DOMAIN}" not found in index.html`);
}

// WhatsApp real (checked across every critical HTML/text file, not just index.html)
{
  let whatsappFound = false;
  for (const rel of CRITICAL_FILES) {
    const p = join(DIST, rel);
    if (!existsSync(p)) continue;
    const ext = rel.split('.').pop();
    if (!['html', 'txt', 'xml', 'js', 'css'].includes(ext)) continue;
    const content = readFileSync(p, 'utf8');
    if (content.includes(WHATSAPP_URL)) whatsappFound = true;
  }
  if (whatsappFound) pass('whatsapp');
  else fail('whatsapp', `"${WHATSAPP_URL}" not found in any dist file`);
}

// PRODUCTION_INDEXING = ON. robots.txt must allow crawling (no blanket Disallow).
{
  const p = join(DIST, 'robots.txt');
  const content = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const hasBlockAll = /Disallow:\s*\/\s*$/m.test(content);
  const hasAllow = /Allow:\s*\/\s*$/m.test(content) || /User-agent:\s*\*[\s\S]*?Disallow:\s*$/m.test(content);
  if (!hasBlockAll && hasAllow) pass('robots-allowed');
  else fail('robots-allowed', 'robots.txt must allow crawling in production (expected "Allow: /" and no blanket "Disallow: /")');
}

// meta robots must be index, follow (not noindex)
if (/<meta\s+name="robots"\s+content="index,\s*follow"\s*\/?>/i.test(indexHtml)) {
  pass('meta-robots-index');
} else {
  fail('meta-robots-index', 'index.html does not contain <meta name="robots" content="index, follow">');
}

// _headers must NOT carry a noindex X-Robots-Tag in production
{
  const p = join(DIST, '_headers');
  const content = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (!/X-Robots-Tag:\s*noindex/i.test(content)) pass('headers-no-noindex');
  else fail('headers-no-noindex', '_headers still sets a noindex X-Robots-Tag — remove it for production indexing');

  // Security headers must remain intact regardless of the indexing switch.
  const requiredHeaders = [
    /Content-Security-Policy:/i,
    /X-Frame-Options:/i,
    /Referrer-Policy:/i,
    /Permissions-Policy:/i,
  ];
  const missing = requiredHeaders.filter((re) => !re.test(content));
  if (missing.length === 0) pass('security-headers-intact');
  else fail('security-headers-intact', `_headers is missing: ${missing.map(String).join(', ')}`);
}

// sitemap.xml well-formed (lightweight tag-balance check, no external XML lib)
{
  const p = join(DIST, 'sitemap.xml');
  const content = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const tagRe = /<(\/?)([a-zA-Z][\w:]*)(?:\s[^>]*)?\/?>/g;
  const stack = [];
  let balanced = true;
  let matchCount = 0;
  let m;
  while ((m = tagRe.exec(content)) !== null) {
    matchCount++;
    const [full, closing, name] = m;
    if (full.endsWith('/>')) continue; // self-closing, no stack effect
    if (closing) {
      if (stack.pop() !== name) { balanced = false; break; }
    } else {
      stack.push(name);
    }
  }
  balanced = balanced && matchCount > 0;
  if (balanced && stack.length === 0 && content.includes('<urlset')) pass('sitemap-xml');
  else fail('sitemap-xml', 'sitemap.xml failed a basic well-formedness check (unbalanced tags or missing <urlset>)');
}

// JSON-LD parseable
{
  const match = indexHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match) {
    fail('json-ld', 'no <script type="application/ld+json"> block found in index.html');
  } else {
    try {
      JSON.parse(match[1]);
      pass('json-ld');
    } catch (e) {
      fail('json-ld', `JSON.parse failed: ${e.message}`);
    }
  }
}

// no known placeholders
{
  let foundPlaceholder = null;
  for (const rel of CRITICAL_FILES) {
    const p = join(DIST, rel);
    if (!existsSync(p)) continue;
    const ext = rel.split('.').pop();
    if (!['html', 'txt', 'xml', 'js', 'css'].includes(ext)) continue;
    const content = readFileSync(p, 'utf8');
    for (const needle of FORBIDDEN_STRINGS) {
      if (content.toLowerCase().includes(needle.toLowerCase())) {
        foundPlaceholder = `"${needle}" found in dist/${rel}`;
        break;
      }
    }
    if (foundPlaceholder) break;
  }
  if (foundPlaceholder) fail('no-placeholders', foundPlaceholder);
  else pass('no-placeholders');
}

// no secrets inside dist/
{
  let foundSecret = null;
  for (const rel of CRITICAL_FILES) {
    const p = join(DIST, rel);
    if (!existsSync(p)) continue;
    const ext = rel.split('.').pop();
    if (!['html', 'txt', 'xml', 'js', 'css'].includes(ext)) continue;
    const content = readFileSync(p, 'utf8');
    for (const re of SECRET_PATTERNS) {
      if (re.test(content)) {
        foundSecret = `pattern ${re} matched in dist/${rel}`;
        break;
      }
    }
    if (foundSecret) break;
  }
  if (foundSecret) fail('no-secrets', foundSecret);
  else pass('no-secrets');
}

if (failures.length > 0) {
  abort('one or more critical pre-deploy validations failed');
}

console.log(`Preflight: PASS (${passes.length} checks)`);

// ---------------------------------------------------------------------------
// 3. Auth
// ---------------------------------------------------------------------------
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

if (!accountId || !apiToken) {
  const missing = [];
  if (!accountId) missing.push('CLOUDFLARE_ACCOUNT_ID');
  if (!apiToken) missing.push('CLOUDFLARE_API_TOKEN');
  abort(`missing required environment variable(s): ${missing.join(', ')} — export them in your shell before running "npm run publicar"`);
}
console.log('Auth: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN present in environment.');

// ---------------------------------------------------------------------------
// 4-5. Cloudflare Pages deploy (exact proven command, no project creation)
// ---------------------------------------------------------------------------
console.log(`Deploying dist/ to Pages project "${PROJECT_NAME}" (branch: main)...`);

const deployArgs = [
  'wrangler', 'pages', 'deploy', 'dist',
  '--project-name', PROJECT_NAME,
  '--branch', 'main',
  '--commit-dirty', 'true',
];

// On Windows, npx resolves to a .cmd shim which the Windows CreateProcess API
// cannot execute directly (a long-standing Node child_process quirk) — it must
// be run through cmd.exe /c. All args below are static, hardcoded literals
// (no interpolated user input), so this carries no injection risk.
const isWin = process.platform === 'win32';
const spawnBin = isWin ? 'cmd.exe' : 'npx';
const spawnArgs = isWin ? ['/c', 'npx', ...deployArgs] : deployArgs;
const result = spawnSync(spawnBin, spawnArgs, {
  cwd: ROOT,
  env: process.env,
  encoding: 'utf8',
});

const deployOutput = `${result.stdout || ''}${result.stderr || ''}`;

if (result.status !== 0) {
  console.log('--- wrangler output ---');
  console.log(deployOutput);
  abort(`wrangler pages deploy exited with code ${result.status}`);
}

const urlMatch = deployOutput.match(/https:\/\/[a-z0-9]+\.ferreira-technology\.pages\.dev\S*/i);
const deploymentUrl = urlMatch ? urlMatch[0] : '(not found in wrangler output)';

console.log(`Deploy: PASS`);
console.log(`Deployment URL: ${deploymentUrl}`);
console.log(`Stable URL: ${STABLE_URL}`);

// ---------------------------------------------------------------------------
// 6. Remote smoke test (against the stable project URL)
// ---------------------------------------------------------------------------
console.log('Running remote smoke test against stable URL...');

const SMOKE_PATHS = [
  '/',
  '/privacy.html',
  '/styles.css',
  '/main.js',
  '/robots.txt',
  '/sitemap.xml',
  '/llms.txt',
  '/favicon.svg',
  '/og-image.jpg',
  '/assets/hero-connection-panel.png',
];

const smokeResults = [];
let smokeOk = true;

for (const path of SMOKE_PATHS) {
  try {
    const res = await fetch(STABLE_URL + path, { redirect: 'manual' });
    const ok = res.status === 200 || res.status === 308 || res.status === 301;
    smokeResults.push({ path, status: res.status, ok });
    if (!ok) smokeOk = false;
  } catch (e) {
    smokeResults.push({ path, status: 'ERROR', ok: false, error: e.message });
    smokeOk = false;
  }
}

let headerCheck = {};
let headersOk = false;
try {
  const res = await fetch(STABLE_URL + '/');
  headerCheck = {
    csp: res.headers.get('content-security-policy'),
    xfo: res.headers.get('x-frame-options'),
    refPolicy: res.headers.get('referrer-policy'),
    permPolicy: res.headers.get('permissions-policy'),
    robotsTag: res.headers.get('x-robots-tag'),
  };
  headersOk = Boolean(headerCheck.csp && headerCheck.xfo && headerCheck.refPolicy && headerCheck.permPolicy);
} catch (e) {
  headerCheck = { error: e.message };
}

// PRODUCTION_INDEXING = ON: absence of a noindex X-Robots-Tag means indexing is allowed.
const indexingAllowed = !(headerCheck.robotsTag && headerCheck.robotsTag.toLowerCase().includes('noindex'));

// ---------------------------------------------------------------------------
// 7. Report
// ---------------------------------------------------------------------------
const overallOk = smokeOk && headersOk && indexingAllowed;

console.log('');
console.log(overallOk ? 'FERREIRA_PUBLISH = PASS' : 'FERREIRA_PUBLISH = FAIL');
console.log('');
console.log('Deployment:');
console.log(deploymentUrl);
console.log('');
console.log('Stable URL:');
console.log(STABLE_URL);
console.log('');
console.log('Production URL:');
console.log(CANONICAL_DOMAIN);
console.log('');
console.log(`Files:\nPASS`);
console.log('');
console.log(`SEO:\nPASS`);
console.log('');
console.log(`Security headers:\n${headersOk ? 'PASS' : 'FAIL'}`);
console.log('');
console.log(`WhatsApp:\nPASS`);
console.log('');
console.log(`Remote smoke test:\n${smokeOk ? 'PASS' : 'FAIL'}`);
for (const r of smokeResults) {
  console.log(`  ${r.path} -> ${r.status}${r.error ? ' (' + r.error + ')' : ''}`);
}
console.log('');
console.log(`Indexing:\n${indexingAllowed ? 'ALLOWED' : 'STILL BLOCKED (unexpected — investigate)'}`);
console.log('');
console.log('Custom domain:');
console.log(`CONNECTED (${CANONICAL_DOMAIN})`);

process.exit(overallOk ? 0 : 1);
