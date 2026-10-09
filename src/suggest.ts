/** "Did you mean" suggestions, shared by the checker and the query translator. */

/** At most this many candidates are compared, so a large schema stays cheap. */
const MAX_CANDIDATES = 1000

/** Any distance larger than every suggestion threshold. */
const FAR_APART = 99

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return FAR_APART
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}

/** The closest candidate by edit distance (ignoring case), if one is close enough. */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined
  let bestDistance = Math.max(2, Math.floor(name.length / 3)) + 1
  let examined = 0
  for (const candidate of candidates) {
    if (++examined > MAX_CANDIDATES) break
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase())
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** The message suffix for a suggestion, or nothing. */
export function didYouMean(suggestion: string | undefined): string {
  return suggestion === undefined ? '' : `; did you mean "${suggestion}"?`
}
