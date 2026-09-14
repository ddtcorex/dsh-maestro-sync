import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// iOS WebKit magnifies the visual viewport when a focused field computes below 16px, so
// dsh-maestro-mobile holds every text field at a 16px floor under
// html[data-mobile-nav-ios]. An earlier revision of this panel opted its own fields back
// out to `inherit` for a compact 13px scale — and every tap on those fields zoomed the
// page on iPhone (user report). Function beats pixels: this panel holds its fields at
// the same 16px on iOS. Android and desktop never carry the marker, so the compact
// scale they were designed with is untouched.
const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/client/index.tsx'),
  'utf8',
)

const css = source.match(/(?:export )?const SYNC_CSS = `([\s\S]*?)`\s*;?\s*\n/)?.[1] ?? ''

/** Declarations only — comments cannot cascade, so they must not match. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Predicate the mobile plugin's field floor is published inside. */
const FLOOR_QUERY = '@media (max-width: 1023px) and (pointer: coarse)'

/** Contents of the media block that follows `query`, by brace matching. */
function blockAt(query: string): string {
  const start = rules.indexOf(query)
  if (start < 0) return ''
  const open = rules.indexOf('{', start)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < rules.length; i++) {
    if (rules[i] === '{') depth++
    else if (rules[i] === '}') {
      depth--
      if (depth === 0) return rules.slice(open + 1, i)
    }
  }
  return ''
}

describe('Maestro Sync settings panel holds the iOS 16px field floor', () => {
  it('never mentions the iOS marker outside the floor predicate', () => {
    const before = rules.slice(0, rules.indexOf(FLOOR_QUERY))
    expect(before).not.toContain('data-mobile-nav-ios')
  })

  it('holds the panel fields at 16px on iOS (opting out re-enables focus zoom)', () => {
    const block = blockAt(FLOOR_QUERY)
    expect(block).toContain('html[data-mobile-nav-ios] [data-sync-root] input')
    expect(block).toContain('[data-sync-root] textarea')
    expect(block).toContain('[data-sync-root] select')
    expect(block).toMatch(/font-size:\s*16px\s*!important/)
    expect(block).not.toMatch(/font-size:\s*inherit\s*!important/)
  })

  it('out-ranks the floor selector, which carries ten :not([type=…]) clauses', () => {
    // id-level specificity keeps this declaration winning over the floor; without it a
    // later equal-specificity rule could silently shrink the fields back below 16px
    expect(blockAt(FLOOR_QUERY)).toMatch(/:not\(#dsh-field-floor-opt-out\)/)
  })

  it('writes a well-formed declaration block (a stray brace silently voids the rule)', () => {
    // Found the hard way: `{{ font-size:16px !important; }}` keeps every string
    // assertion above happy, yet the CSS parser drops the declaration and the fields
    // fall back below the floor. Pin the block's exact shape.
    const block = blockAt(FLOOR_QUERY)
    expect(block).not.toContain('{{')
    expect(block).toMatch(/\{\s*font-size:\s*16px\s*!important;\s*\}/)
  })
})
