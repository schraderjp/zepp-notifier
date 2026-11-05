// Catches the class of bug that cost ~10 builds: a call to a function that does
// not exist. Rollup bundles it happily, `node --check` sees valid syntax, and the
// failure only appears at runtime inside a 600 ms App Service wake - where the
// symptom is "the alarm fired and nothing happened".
//
// 0.4.12 deleted `quit()` and `bleStatus()` from app-service/notifier.js with a
// find/slice edit between two section markers. Every wake then died on a
// ReferenceError *after* arming the next alarm, so the watch looked silent while
// the server saw nothing at all.
//
// This is not a full scope analysis. It answers one question: for every call of a
// bare identifier (`foo(...)`, not `obj.foo(...)`), is that name declared
// anywhere in the file, imported, or a known runtime global?

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from 'acorn'

const ROOT = new URL('..', import.meta.url).pathname
const SKIP = new Set(['node_modules', 'dist', '.git'])

// Runtime globals provided by Zepp OS / the build, plus JS builtins we use.
const GLOBALS = new Set([
  'AppService', 'AppSideService', 'App', 'Page', 'AppSettingsPage', 'View', 'Text', 'TextInput',
  'exit', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'fetch', 'console', 'JSON', 'Math', 'Date', 'String', 'Number', 'Boolean', 'Object', 'Array',
  'Error', 'Promise', 'Buffer', 'ArrayBuffer', 'Uint8Array', 'isNaN', 'isFinite', 'parseInt',
  'parseFloat', 'decodeURIComponent', 'encodeURIComponent', 'settings', 'messaging', 'Logger',
  'require', '__API_LEVEL__', '__ZEPPOS__', 'globalThis', 'undefined', 'NaN', 'Infinity',
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else if (name.endsWith('.js')) out.push(path)
  }
  return out
}

function collectDeclared(ast) {
  const names = new Set()
  const addPattern = (node) => {
    if (!node) return
    if (node.type === 'Identifier') names.add(node.name)
    else if (node.type === 'ObjectPattern') for (const p of node.properties) addPattern(p.value || p.argument)
    else if (node.type === 'ArrayPattern') for (const el of node.elements) addPattern(el)
    else if (node.type === 'AssignmentPattern') addPattern(node.left)
    else if (node.type === 'RestElement') addPattern(node.argument)
  }
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return
    switch (node.type) {
      case 'FunctionDeclaration':
        if (node.id) names.add(node.id.name)
        for (const p of node.params) addPattern(p)
        break
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        for (const p of node.params) addPattern(p)
        break
      case 'VariableDeclarator':
        addPattern(node.id)
        break
      case 'ImportDeclaration':
        for (const spec of node.specifiers) names.add(spec.local.name)
        break
      case 'ClassDeclaration':
        if (node.id) names.add(node.id.name)
        break
      case 'CatchClause':
        addPattern(node.param)
        break
      default:
        break
    }
    for (const key of Object.keys(node)) {
      const value = node[key]
      if (Array.isArray(value)) for (const child of value) visit(child)
      else if (value && typeof value.type === 'string') visit(value)
    }
  }
  visit(ast)
  return names
}

function collectBareCalls(ast) {
  const calls = []
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier') {
      calls.push({ name: node.callee.name, line: node.loc ? node.loc.start.line : 0 })
    }
    for (const key of Object.keys(node)) {
      const value = node[key]
      if (Array.isArray(value)) for (const child of value) visit(child)
      else if (value && typeof value.type === 'string') visit(value)
    }
  }
  visit(ast)
  return calls
}

// `this.foo()` inside a Page/App/AppService options object is a method of that
// object, not a free identifier - so the check above cannot see it. Two buttons
// shipped dead that way (this.disarm(), this.startTick()): the tap threw
// "is not a function" and the UI simply did nothing. Collect both sides.
function collectThisCalls(ast) {
  const calls = []
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'MemberExpression' &&
      !node.callee.computed &&
      node.callee.object.type === 'ThisExpression' &&
      node.callee.property.type === 'Identifier'
    ) {
      calls.push({ name: node.callee.property.name, line: node.loc ? node.loc.start.line : 0 })
    }
    for (const key of Object.keys(node)) {
      const value = node[key]
      if (Array.isArray(value)) for (const child of value) visit(child)
      else if (value && typeof value.type === 'string') visit(value)
    }
  }
  visit(ast)
  return calls
}

function collectMembers(ast) {
  const names = new Set()
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'Property' && !node.computed) {
      if (node.key.type === 'Identifier') names.add(node.key.name)
      else if (node.key.type === 'Literal') names.add(String(node.key.value))
    }
    if (node.type === 'MethodDefinition' && node.key && node.key.type === 'Identifier') {
      names.add(node.key.name)
    }
    if (
      node.type === 'AssignmentExpression' &&
      node.left &&
      node.left.type === 'MemberExpression' &&
      node.left.object.type === 'ThisExpression' &&
      node.left.property.type === 'Identifier'
    ) {
      names.add(node.left.property.name)
    }
    for (const key of Object.keys(node)) {
      const value = node[key]
      if (Array.isArray(value)) for (const child of value) visit(child)
      else if (value && typeof value.type === 'string') visit(value)
    }
  }
  visit(ast)
  return names
}

let failures = 0
for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8')
  let ast
  try {
    ast = parse(src, { ecmaVersion: 2020, sourceType: 'module', locations: true })
  } catch (e) {
    console.error(`${relative(ROOT, file)}: PARSE ERROR ${e.message}`)
    failures++
    continue
  }
  const declared = collectDeclared(ast)
  const missing = new Map()
  for (const call of collectBareCalls(ast)) {
    if (declared.has(call.name) || GLOBALS.has(call.name)) continue
    if (!missing.has(call.name)) missing.set(call.name, [])
    missing.get(call.name).push(call.line)
  }
  if (missing.size) {
    failures++
    console.error(`${relative(ROOT, file)} -> UNDEFINED CALLS:`)
    for (const [name, lines] of missing) console.error(`  ${name}()  lines ${lines.join(', ')}`)
  }

  const isClassBased = /\bclass\s+[A-Za-z_$]/.test(src)
  const members = collectMembers(ast)
  const missingThis = new Map()
  for (const call of isClassBased ? [] : collectThisCalls(ast)) {
    if (members.has(call.name)) continue
    if (!missingThis.has(call.name)) missingThis.set(call.name, [])
    missingThis.get(call.name).push(call.line)
  }
  if (missingThis.size) {
    failures++
    console.error(`${relative(ROOT, file)} -> this.<method>() WITHOUT A DEFINITION:`)
    for (const [name, lines] of missingThis) console.error(`  this.${name}()  lines ${lines.join(', ')}`)
  }
}

if (failures) {
  console.error(`\n${failures} file(s) reference undefined functions.`)
  process.exit(1)
}
console.log('undef-check: no undefined calls, no undefined this.<method>() calls')
