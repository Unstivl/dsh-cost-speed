// Dependency-free smoke checks. Run with: node smoke/check.mjs
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, apply, inject, isTrustedRequest, sanitizeRules } from '../lib/index.js'

const request = (headers, remote = '127.0.0.1') => ({ headers, socket: { remoteAddress: remote } })

assert.equal(typeof apply, 'function')
assert.ok(Array.isArray(inject) && inject.includes('timer'))

// Same-origin reads and writes reach the handler.
assert.equal(isTrustedRequest(request({ host: '127.0.0.1:63705' }), true), true)
assert.equal(isTrustedRequest(request({
  host: '127.0.0.1:63705',
  origin: 'http://127.0.0.1:63705'
}), true), true)

// A cross-site page is rejected before the body is read.
assert.equal(isTrustedRequest(request({
  host: '127.0.0.1:63705',
  origin: 'https://evil.example'
}), true), false)
assert.equal(isTrustedRequest(request({
  host: '127.0.0.1:63705',
  'sec-fetch-site': 'cross-site'
}), true), false)

// A DNS-rebinding page keeps its own Host name.
assert.equal(isTrustedRequest(request({ host: 'evil.example:63705' }), true), false)

// A non-loopback peer is rejected while the server is bound to loopback.
assert.equal(isTrustedRequest(request({ host: '127.0.0.1:63705' }, '10.0.0.2'), true), false)

// Prices are clamped, free routes keep their flag, junk entries are dropped.
const rules = sanitizeRules([
  { provider: 'example', model: 'demo', price: { input: -1, output: 2, cacheRead: 0, cacheWrite: 0 }, free: true },
  { provider: 'example', model: 'peak', price: { input: 1, output: 1 }, peak: { multiplier: 2, windows: [[9, 12]] } },
  null,
  'nope'
])
assert.equal(rules.length, 2)
assert.equal(rules[0].price.input, 0)
assert.equal(rules[0].price.output, 2)
assert.equal(rules[0].free, true)
assert.equal(rules[1].peak.multiplier, 2)

// The shipped template is DeepSeek official pricing plus a catch-all.
assert.ok(DEFAULT_CONFIG.rules.some((rule) => rule.provider === 'deepseek-official'))
assert.ok(DEFAULT_CONFIG.rules.some((rule) => rule.provider === '*' && rule.model === '*'))
assert.equal(DEFAULT_CONFIG.rules.some((rule) => rule.free === true), false)

console.log('smoke ok: transport guard, price sanitizer, default template')