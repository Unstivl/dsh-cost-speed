/**
 * Incremental BPE across streaming deltas — ported from dsh-live-token-stats.
 *
 * Copyright (c) 2026 betterer, MIT License.
 * Upstream: https://github.com/better-er/dsh-live-token-stats (v0.4.7, src/tokenizer/incremental.ts)
 *
 * Why this exists: a step arrives as dozens of deltas and each has to be
 * counted as it lands, yet the count must equal a single pass over the whole
 * text. BPE merges never cross a pre-token boundary, and appending text can
 * only extend the last segment, so every earlier segment can be settled once
 * and only "tail + new delta" needs re-splitting.
 *
 * Added tokens complicate it: a match can span segments that were already
 * settled. The fix is to keep the region that could still grow into a match
 * out of the settled baseline (`potentialWindowStart`), which upstream's own
 * comment notes also avoids the old quadratic lock-up triggered by bare `<`
 * or a full-width bar.
 *
 * @module dsh-cost-monitor/lib/tokenizer/incremental
 */

import { bpeMergeSymbols, potentialWindowStart, splitWithAdded, tokenCount } from './bpe.js'

/** A segment's token count: an added token is exactly 1, BPE is its merge length. */
function segmentTokenCount(seg) {
  return seg.kind === 'added' ? 1 : bpeMergeSymbols(seg.codes).length
}

/** Hard cap on the unsettled tail; past it, leading segments are settled. */
const MAX_TAIL_CHARS = 4096

/**
 * @typedef {object} IncrementalState
 * @property {string} buffer tail not yet settled; re-split when text is appended
 * @property {number} counted tokens settled before the buffer
 */

/** @type {IncrementalState} */
export const EMPTY_INCREMENTAL = Object.freeze({ buffer: '', counted: 0 })

/**
 * Feed one delta, returning the new state and the number of tokens this delta
 * added. The delta is what a live rate should count; `total` is the absolute.
 *
 * @param {IncrementalState} state
 * @param {string} text
 * @returns {{state: IncrementalState, added: number}}
 */
export function incrementalFeed(state, text) {
  if (text.length === 0) return { state, added: 0 }
  const combined = state.buffer + text
  const cps = Array.from(combined)
  const winStart = potentialWindowStart(cps)
  if (winStart < cps.length) {
    // An unclosed added-token prefix is pending: hold the whole combined text
    // rather than cut through a segment that a later delta may complete.
    if (combined.length > MAX_TAIL_CHARS) {
      const r = truncateTail(combined)
      return {
        state: { buffer: r.buffer, counted: state.counted + r.dropped },
        added: r.dropped
      }
    }
    return { state: { buffer: combined, counted: state.counted }, added: 0 }
  }
  const segs = splitWithAdded(combined)
  if (segs.length === 0) return { state, added: 0 }
  const tail = segs.pop()
  let added = 0
  for (const s of segs) added += segmentTokenCount(s)
  let buffer = tail.text
  let counted = state.counted + added
  if (buffer.length > MAX_TAIL_CHARS) {
    const r = truncateTail(buffer)
    buffer = r.buffer
    counted += r.dropped
  }
  return { state: { buffer, counted }, added }
}

/**
 * Absolute token count of a state: settled plus a fresh split of the tail.
 *
 * @param {IncrementalState} state
 * @returns {number}
 */
export function incrementalTotal(state) {
  return state.counted + (state.buffer.length === 0 ? 0 : tokenCount(state.buffer))
}

/**
 * Keep only the last whole segments up to MAX_TAIL_CHARS and settle the rest.
 * Cutting a segment can lose at most one cross-boundary merge, and the official
 * usage replaces the estimate at step end anyway.
 *
 * @param {string} buffer
 * @returns {{buffer: string, dropped: number}}
 */
function truncateTail(buffer) {
  const segs = splitWithAdded(buffer)
  let keep = ''
  let keptStart = segs.length
  let acc = 0
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    const s = segs[i]
    if (keep !== '' && acc + s.text.length > MAX_TAIL_CHARS) break
    keep = s.text + keep
    keptStart = i
    acc += s.text.length
  }
  let dropped = 0
  for (let i = 0; i < keptStart; i += 1) dropped += segmentTokenCount(segs[i])
  return { buffer: keep, dropped }
}