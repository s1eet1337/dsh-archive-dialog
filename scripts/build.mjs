/**
 * Offline build for dsh-archive-dialog (no bundler dependency).
 *
 *   1. Compile the HOST program (`tsconfig.json`, ESM) into `lib/` — multi-file
 *      ESM is fine because the host runs under Node.
 *   2. Compile the CLIENT program (`tsconfig.client.json`, CommonJS) into
 *      `lib/.client-stage/`.
 *   3. Concatenate the staged CJS files into one browser bundle
 *      `lib/client.js` using the DSH client-modules protocol:
 *
 *        window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports } })
 *
 *      External specifiers (`react`, `react/jsx-runtime`) resolve through the
 *      loader's `require`; relative specifiers resolve through an internal
 *      registry.
 *   4. Remove the staging directory.
 *
 * Requires: `npm install` (typescript devDependency). Run: `npm run build`.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const HOST_CFG = join(root, 'tsconfig.json')
const CLIENT_CFG = join(root, 'tsconfig.client.json')
const STAGE = join(root, 'lib', '.client-stage')
const CLIENT_OUT = join(root, 'lib', 'client.js')

// When `prepare` runs inside a consumer profile (no devDependencies installed),
// keep the committed prebuilt lib/ as-is.
let ts = null
try {
  ts = require('typescript')
} catch {
  console.log('[build] typescript not installed here — keeping prebuilt lib/ (run `npm install` to rebuild)')
  process.exit(0)
}

function compile(configPath, label) {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(d) {
      console.error(`[${label}] config:`, ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    },
  })
  if (parsed === undefined) {
    console.error(`[${label}] failed to parse ${configPath}`)
    process.exitCode = 1
    return false
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const pre = ts.getPreEmitDiagnostics(program)
  const emit = program.emit()
  const diagnostics = [...pre, ...emit.diagnostics]
  let errors = 0
  for (const d of diagnostics) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
    const where = d.file !== undefined ? `${relative(root, d.file.fileName)}:${d.start ?? ''}` : ''
    if (d.category === ts.DiagnosticCategory.Error) errors += 1
    console.log(`[${label}] ${d.category === ts.DiagnosticCategory.Error ? 'ERR ' : 'warn'} ${where} ${msg}`)
  }
  if (errors > 0) {
    console.error(`[${label}] ${errors} error(s)`)
    process.exitCode = 1
    return false
  }
  console.log(`[${label}] compiled OK → ${parsed.options.outDir}`)
  return true
}

/* ------------------------------------------------------------------ *
 * Client bundle concatenation
 * ------------------------------------------------------------------ */

function walkJs(dir, base) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...walkJs(full, base))
    else if (entry.endsWith('.js')) out.push(relative(base, full).replace(/\\/g, '/'))
  }
  return out
}

function buildClientBundle() {
  if (!existsSync(STAGE)) throw new Error(`client stage missing: ${STAGE}`)
  const files = walkJs(STAGE, STAGE).sort()
  const defs = []
  let entry = null
  for (const rel of files) {
    if (rel === 'client/index.js') entry = rel
    const raw = readFileSync(join(STAGE, rel), 'utf8')
    const code = raw.replace(/\n\/\/# sourceMappingURL=.*$/s, '')
    const key = rel.replace(/\.js$/, '')
    defs.push(`define(${JSON.stringify(key)}, function (module, exports, require) {\n${code}\n});`)
  }
  if (entry === null) throw new Error('client entry client/index.js not found in stage')

  const src = [
    `window.__ModuleLoader__.load({ id: "dsh-archive-dialog", factory: (__hostRequire) => {`,
    `var module = { exports: {} }; var exports = module.exports;`,
    ``,
    `var __registry = {};`,
    `var __loaded = {};`,
    `function define(key, fn) { __registry[key] = fn; }`,
    `function __dirOf(key) { var i = key.lastIndexOf('/'); return i < 0 ? '' : key.slice(0, i); }`,
    `function __load(key) {`,
    `  if (__loaded[key]) return __registry[key].exports;`,
    `  if (!__registry[key]) { throw new Error('dsh-archive-dialog: unknown module ' + key); }`,
    `  var m = { exports: {} };`,
    `  __registry[key].exports = m.exports;`,
    `  __loaded[key] = true;`,
    `  var r = function (spec) {`,
    `    if (typeof spec === 'string' && spec.charCodeAt(0) === 46) { return __load(resolveRelative(__dirOf(key), spec)); }`,
    `    return __hostRequire(spec);`,
    `  };`,
    `  __registry[key](m, m.exports, r);`,
    `  return __registry[key].exports;`,
    `}`,
    `function resolveRelative(fromDir, spec) {`,
    `  var parts = fromDir === '' ? [] : fromDir.split('/');`,
    `  var segs = spec.split('/');`,
    `  for (var i = 0; i < segs.length; i++) { var seg = segs[i];`,
    `    if (seg === '.' || seg === '') continue;`,
    `    if (seg === '..') parts.pop(); else parts.push(seg);`,
    `  }`,
    `  return parts.join('/');`,
    `}`,
    ...defs,
    ``,
    `return __load("client/index");`,
    `} });`,
    ``,
  ].join('\n')

  mkdirSync(dirname(CLIENT_OUT), { recursive: true })
  writeFileSync(CLIENT_OUT, src, 'utf8')
  console.log(`[bundle] lib/client.js ${src.length} bytes from ${defs.length} staged modules`)
}

/* ------------------------------------------------------------------ */

const okHost = compile(HOST_CFG, 'host')
const okClient = compile(CLIENT_CFG, 'client')
if (okHost && okClient) {
  try {
    buildClientBundle()
  } catch (err) {
    console.error('[bundle] failed:', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}
if (existsSync(STAGE)) {
  rmSync(STAGE, { recursive: true, force: true })
  console.log('[build] cleaned lib/.client-stage')
}
if (process.exitCode === undefined) console.log('[build] done')
