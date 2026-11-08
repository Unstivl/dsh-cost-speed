/**
 * Streaming JSON unescape for tool-call arguments — ported from
 * dsh-live-token-stats.
 *
 * Copyright (c) 2026 betterer, MIT License.
 * Upstream: https://github.com/better-er/dsh-live-token-stats (v0.4.7, src/tokenizer/unescape.ts)
 *
 * The official usage counts the tokens the model actually generated. For a tool
 * call those are decoded characters: real newlines, real quotes. The OpenAI
 * compatible protocol, however, serialises the arguments as a JSON string, so
 * what arrives on the wire is `\\n` (two characters), `\\"`, `\\\\`, `\\uXXXX`.
 * Counting the escaped form over-states the tokens, more so as the arguments
 * grow; upstream measured a `write` with a large content argument at -53.
 *
 * Escapes can straddle deltas (`\\` then `n`, or `\\u` followed by fewer than
 * four hex digits), so the state is a small JSON-serialisable tail.
 *
 * @module dsh-cost-monitor/lib/tokenizer/unescape
 */

/**
 * @typedef {object} UnescapeState
 * @property {string} tail a dangling `\` or `\u` plus 0-3 hex digits
 */

/** @type {UnescapeState} */
export const EMPTY_UNESCAPE = Object.freeze({ tail: '' })

const RE_HEX4 = /^[0-9a-fA-F]{4}$/

/**
 * Feed one fragment, returning the text that can be counted now and the state
 * to carry forward.
 *
 * @param {UnescapeState} state
 * @param {string} fragment
 * @returns {{text: string, state: UnescapeState}}
 */
export function unescapeFeed(state, fragment) {
  const s = state.tail + fragment
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c !== '\\') {
      out += c
      i += 1
      continue
    }
    if (i === s.length - 1) {
      // Dangling backslash: could be the first half of `\\` or `\n`.
      return { text: out, state: { tail: '\\' } }
    }
    const n = s[i + 1]
    if (n === 'u') {
      const hex = s.slice(i + 2, i + 6)
      if (hex.length < 4) return { text: out, state: { tail: s.slice(i) } }
      if (!RE_HEX4.test(hex)) {
        // Invalid \u sequence: keep `\u` literally and carry on.
        out += '\\u'
        i += 2
        continue
      }
      out += String.fromCodePoint(parseInt(hex, 16))
      i += 6
      continue
    }
    switch (n) {
      case 'n': out += '\n'; break
      case 'r': out += '\r'; break
      case 't': out += '\t'; break
      case 'b': out += '\b'; break
      case 'f': out += '\f'; break
      case '\\': out += '\\'; break
      case '"': out += '"'; break
      case '/': out += '/'; break
      default:
        // Unrecognised escape: keep both characters.
        out += s.slice(i, i + 2)
    }
    i += 2
  }
  return { text: out, state: EMPTY_UNESCAPE }
}

/**
 * Unescape a whole string in one go, for tests and offline analysis.
 *
 * @param {string} text
 * @returns {string}
 */
export function unescapeAll(text) {
  const r = unescapeFeed(EMPTY_UNESCAPE, text)
  return r.state.tail.length === 0 ? r.text : r.text + r.state.tail
}