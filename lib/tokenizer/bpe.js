/**
 * DeepSeek V4 byte-level BPE — ported from dsh-live-token-stats.
 *
 * Copyright (c) 2026 betterer, MIT License.
 * Upstream: https://github.com/better-er/dsh-live-token-stats (v0.4.7, src/tokenizer/)
 * Ported into dsh-cost-monitor so live throughput can be counted with the real
 * tokenizer instead of a character-density guess. Statistics and flow are
 * unchanged from upstream except where noted inline:
 *   - ESM + JSDoc types instead of TypeScript (this package ships plain JS).
 *   - Vocabulary and merges live in ./bpe-data.json, loaded on demand, so the
 *     module itself stays small; upstream inlines the same data as a literal.
 *   - The lazy caches are per-module singletons as upstream, but `release()`
 *     lets the host drop them again (see below).
 *
 * The encoding is byte-identical to HF transformers' encode(add_special_tokens
 * = false); upstream verified this per token id, and the tables here are the
 * same ones its build embeds.
 *
 * @module dsh-cost-monitor/lib/tokenizer/bpe
 */

import { readFileSync } from 'node:fs'

/**
 * Split `text` keeping every match and every gap as its own segment, matching
 * HF's pre-tokenizer Split behavior "Isolated": no adjacent segments merge.
 *
 * @param {string} text
 * @param {RegExp} re global regex, lastIndex is reset on entry
 * @returns {string[]}
 */
function splitKeep(text, re) {
  const out = []
  let last = 0
  re.lastIndex = 0
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(m[0])
    last = m.index + m[0].length
    // A zero-length match would spin forever; every pattern here requires at
    // least one character, but guard anyway.
    if (m[0].length === 0) { re.lastIndex += 1 }
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// --- ByteLevel byte<->unicode map, built once ---------------------------------

function buildByteMaps() {
  const byteToUnicode = new Map()
  const unicodeToByte = new Map()
  const ranges = [[0x21, 0x7e], [0xa1, 0xac], [0xae, 0xff]]
  const native = new Set()
  for (const [lo, hi] of ranges) {
    for (let b = lo; b <= hi; b += 1) {
      native.add(b)
      byteToUnicode.set(b, b)
      unicodeToByte.set(b, b)
    }
  }
  let n = 0
  for (let b = 0; b < 256; b += 1) {
    if (native.has(b)) continue
    const u = 256 + n
    n += 1
    byteToUnicode.set(b, u)
    unicodeToByte.set(u, b)
  }
  return { byteToUnicode, unicodeToByte }
}

let byteMaps = null
function getByteMaps() {
  if (byteMaps === null) byteMaps = buildByteMaps()
  return byteMaps
}

const textEncoder = new TextEncoder()

/**
 * UTF-8 encode then map each byte to its ByteLevel code point (1 byte = 1 cp).
 *
 * @param {string} text
 * @returns {number[]}
 */
export function charToCodes(text) {
  const { byteToUnicode } = getByteMaps()
  const bytes = textEncoder.encode(text)
  const out = new Array(bytes.length)
  for (let i = 0; i < bytes.length; i += 1) out[i] = byteToUnicode.get(bytes[i])
  return out
}

// --- pre-tokenizer regexes ----------------------------------------------------

// Verbatim from the upstream module, which reads them out of tokenizer.json.
// `\p{N}{1,3}` needs the u flag for \p{} and g to match all of them.
const RE_DIGITS = new RegExp('\\p{N}{1,3}', 'gu')
// Redundant ranges such as [一-龥...] parse an extra literal '-' in JS engines
// but not in the Rust regex crate, so the equivalent redundant-free form is used.
const RE_CJK = /[\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff]+/gu
const RE_WORDS = new RegExp(
  "[!\"#$%&'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~][A-Za-z]+|[^\\r\\n\\p{L}\\p{P}\\p{S}]?[\\p{L}\\p{M}]+| ?[\\p{P}\\p{S}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+",
  'gu'
)

/**
 * Apply the three Isolated splits then ByteLevel to every resulting segment.
 *
 * @param {string} text
 * @returns {{text: string, codes: number[]}[]}
 */
export function preTokenize(text) {
  const segs = splitKeep(text, RE_DIGITS)
    .flatMap((s) => splitKeep(s, RE_CJK))
    .flatMap((s) => splitKeep(s, RE_WORDS))
  return segs.map((s) => ({ text: s, codes: charToCodes(s) }))
}

// --- vocabulary tables, loaded on demand -------------------------------------

let vocab = null
let rank = null
let addedTrie = null
let addedFirstCodes = null
let mergedIdBySymbol = null

/** Longest ADDED_TOKENS entry in code points; also bounds the window scan. */
const MAX_ADDED_CODES = 36

function loadTables() {
  if (vocab !== null) return
  // Read once; the file is a few megabytes and the host keeps this module
  // resident, so this cost is paid one time at first use.
  const url = new URL('./bpe-data.json', import.meta.url)
  const data = JSON.parse(readFileSync(url, 'utf8'))
  const bytes = Buffer.from(data.vocabB64, 'base64')
  vocab = new Map()
  let off = 0
  for (let id = 0; id < data.vocabSize; id += 1) {
    const n = bytes[off]
    off += 1
    let s = ''
    for (let j = 0; j < n; j += 1) {
      s += String.fromCodePoint(bytes.readUInt32LE(off))
      off += 4
    }
    vocab.set(s, id)
  }
  rank = new Map()
  for (let i = 0; i < data.mergePairs.length; i += 1) {
    rank.set(data.mergePairs[i][0] + ',' + data.mergePairs[i][1], i)
  }
  // A merge product's id is VOCAB_SIZE_BASE + rank, not 256 + rank. After the
  // merges table is in hand, precompute those ids so bpeMerge does not have to
  // probe the vocab map for every result.
  mergedIdBySymbol = new Map()
  for (let i = 0; i < data.mergePairs.length; i += 1) {
    const [a, b] = data.mergePairs[i]
    const id = vocab.get(a + b)
    if (id !== undefined) mergedIdBySymbol.set(a + b, id)
  }
  // Added-token trie, longest prefix match, walked by code point.
  const root = { next: new Map(), id: undefined, special: false }
  for (const t of data.addedTokens) {
    if (t.content.length === 0) continue
    let node = root
    for (const ch of t.content) {
      let nxt = node.next.get(ch)
      if (nxt === undefined) {
        nxt = { next: new Map(), id: undefined, special: false }
        node.next.set(ch, nxt)
      }
      node = nxt
    }
    node.id = t.id
    node.special = t.special
  }
  addedTrie = root
  addedFirstCodes = new Set()
  for (const t of data.addedTokens) {
    const a = Array.from(t.content)
    if (a.length > 0) addedFirstCodes.add(a[0])
  }
}

/**
 * Drop the loaded tables so a reload of this module does not pin several
 * megabytes forever. The next encode() reads them again.
 */
export function release() {
  vocab = null
  rank = null
  addedTrie = null
  addedFirstCodes = null
  mergedIdBySymbol = null
  byteMaps = null
}

/**
 * Earliest position at or after the end-window that could still grow into an
 * added-token match. Everything before it can be settled as ordinary text.
 *
 * @param {string[]} cps
 * @returns {number} code point index, or cps.length when nothing is pending
 */
export function potentialWindowStart(cps) {
  // Callers reach this before any split has run, so the tables may not be in
  // memory yet; loadTables() is idempotent.
  loadTables()
  const trie = addedTrie
  const lo = Math.max(0, cps.length - MAX_ADDED_CODES)
  for (let i = lo; i < cps.length; i += 1) {
    if (!addedFirstCodes.has(cps[i])) continue
    let node = trie
    let reachedEnd = true
    for (let j = i; j < cps.length; j += 1) {
      const nxt = node.next.get(cps[j])
      if (nxt === undefined) { reachedEnd = false; break }
      node = nxt
    }
    if (reachedEnd) return i
  }
  return cps.length
}

/**
 * Longest added-token prefix at `pos`.
 *
 * @param {string[]} cps
 * @param {number} pos
 * @returns {{len: number, id: number, special: boolean}|null}
 */
function matchAddedAt(cps, pos) {
  let node = addedTrie
  let best = null
  let len = 0
  for (let i = pos; i < cps.length; i += 1) {
    const nxt = node.next.get(cps[i])
    if (nxt === undefined) break
    node = nxt
    len += 1
    if (node.id !== undefined) best = { len, id: node.id, special: node.special }
  }
  return best
}

/**
 * Segment `text` into added-token matches (special only) and BPE runs.
 *
 * @param {string} text
 * @returns {({kind: 'bpe', text: string, codes: number[]} | {kind: 'added', text: string, id: number})[]}
 */
export function splitWithAdded(text) {
  loadTables()
  const out = []
  if (text.length === 0) return out
  const cps = Array.from(text)
  let i = 0
  let segStart = 0
  const flushBpe = (from, to) => {
    if (to <= from) return
    for (const pt of preTokenize(cps.slice(from, to).join(''))) {
      out.push({ kind: 'bpe', text: pt.text, codes: pt.codes })
    }
  }
  while (i < cps.length) {
    const m = matchAddedAt(cps, i)
    if (m !== null && m.special) {
      flushBpe(segStart, i)
      out.push({ kind: 'added', text: cps.slice(i, i + m.len).join(''), id: m.id })
      i += m.len
      segStart = i
    } else {
      i += 1
    }
  }
  flushBpe(segStart, cps.length)
  return out
}

/**
 * BPE-merge a run of byte-mapped code points, returning symbol strings.
 *
 * O(n log n): a binary heap keyed by (rank, leftIndex) plus a doubly linked
 * list of live nodes and lazy deletion. Same merge order as the naive O(n^2)
 * rescan, because every rank is unique and the tie-break is the left index.
 *
 * @param {number[]} codes
 * @returns {string[]}
 */
export function bpeMergeSymbols(codes) {
  const n = codes.length
  if (n === 0) return []
  const nodes = []
  for (let i = 0; i < n; i += 1) {
    nodes.push({
      str: String.fromCodePoint(codes[i]),
      prev: i > 0 ? i - 1 : -1,
      next: i + 1 < n ? i + 1 : -1,
      dead: false
    })
  }
  const pairRank = (l) => {
    const r = nodes[l].next
    if (r === -1) return Number.POSITIVE_INFINITY
    const v = rank.get(nodes[l].str + ',' + nodes[r].str)
    return v === undefined ? Number.POSITIVE_INFINITY : v
  }
  const heap = []
  const cmp = (a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.left - b.left)
  const push = (r, l) => {
    heap.push({ rank: r, left: l })
    let c = heap.length - 1
    while (c > 0) {
      const p = (c - 1) >> 1
      if (cmp(heap[p], heap[c]) <= 0) break
      const t = heap[p]; heap[p] = heap[c]; heap[c] = t
      c = p
    }
  }
  const pop = () => {
    if (heap.length === 0) return undefined
    const top = heap[0]
    const last = heap.pop()
    if (heap.length > 0) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < heap.length && cmp(heap[l], heap[m]) < 0) m = l
        if (r < heap.length && cmp(heap[r], heap[m]) < 0) m = r
        if (m === i) break
        const t = heap[i]; heap[i] = heap[m]; heap[m] = t
        i = m
      }
    }
    return top
  }
  for (let i = 0; i < n - 1; i += 1) {
    const r = pairRank(i)
    if (Number.isFinite(r)) push(r, i)
  }
  while (heap.length > 0) {
    const e = pop()
    const l = e.left
    const r = nodes[l].next
    if (r === -1 || nodes[l].dead || nodes[r].dead) continue
    if (pairRank(l) !== e.rank) continue
    const prev = nodes[l].prev
    const next = nodes[r].next
    const newIdx = nodes.length
    nodes.push({ str: nodes[l].str + nodes[r].str, prev, next, dead: false })
    nodes[l].dead = true
    nodes[r].dead = true
    if (prev !== -1) {
      nodes[prev].next = newIdx
      const pr = pairRank(prev)
      if (Number.isFinite(pr)) push(pr, prev)
    }
    if (next !== -1) {
      nodes[next].prev = newIdx
      const nr = pairRank(newIdx)
      if (Number.isFinite(nr)) push(nr, newIdx)
    }
  }
  const out = []
  let head = nodes.findIndex((nd) => !nd.dead && nd.prev === -1)
  while (head !== -1) {
    out.push(nodes[head].str)
    head = nodes[head].next
  }
  return out
}

/**
 * Encode text to token ids, byte-identical to the upstream implementation.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function encodeText(text) {
  loadTables()
  const ids = []
  for (const seg of splitWithAdded(text)) {
    if (seg.kind === 'added') {
      ids.push(seg.id)
    } else {
      for (const sym of bpeMergeSymbols(seg.codes)) {
        const id = vocab.get(sym)
        if (id === undefined) throw new Error('tokenizer: symbol absent from vocab')
        ids.push(id)
      }
    }
  }
  return ids
}

/**
 * Number of tokens `text` encodes to.
 *
 * @param {string} text
 * @returns {number}
 */
export function tokenCount(text) {
  return encodeText(text).length
}