import type { Rule, Scored } from './types.js'

export interface Report {
  counts: Record<string, number>
  /** How each rating was settled, so an oversized bucket can be traced to the rule that filled it. */
  rules: Record<string, number>
  poolSize: number
  poolMin: number
  total: number
  uncertain: { id: string; rating: number; uncertainty: number; raw: number; rule?: Rule; url: string }[]
}

export function assetUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/photos/${id}`
}

export function buildReport(scored: Scored[], baseUrl: string, top = 30, poolMinRating = 4): Report {
  const counts: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
  const rules: Record<string, number> = {}
  let poolSize = 0
  for (const s of scored) {
    counts[String(s.rating)] = (counts[String(s.rating)] ?? 0) + 1
    if (s.rule) rules[s.rule] = (rules[s.rule] ?? 0) + 1
    if (s.rating >= poolMinRating) poolSize++
  }

  const uncertain = [...scored]
    .sort((a, b) => a.uncertainty - b.uncertainty || a.id.localeCompare(b.id))
    .slice(0, top)
    .map((s) => ({
      id: s.id,
      rating: s.rating,
      uncertainty: Number(s.uncertainty.toFixed(4)),
      raw: Number(s.raw.toFixed(4)),
      ...(s.rule ? { rule: s.rule } : {}),
      url: assetUrl(baseUrl, s.id),
    }))

  return { counts, rules, poolSize, poolMin: poolMinRating, total: scored.length, uncertain }
}

/** Human readable block for the terminal. The JSON log line stays the machine readable one. */
export function formatReport(report: Report, mode: string): string {
  const lines: string[] = []
  lines.push(`mode: ${mode}   rated: ${report.total}`)
  for (const r of ['5', '4', '3', '2', '1']) {
    const n = report.counts[r] ?? 0
    const share = report.total > 0 ? Math.round((n / report.total) * 100) : 0
    lines.push(`  ${r} star  ${String(n).padStart(6)}  ${'#'.repeat(Math.round(share / 2))} ${share}%`)
  }
  const share = (n: number) => (report.total > 0 ? Math.round((n / report.total) * 100) : 0)
  lines.push('')
  lines.push(`pool at >= ${report.poolMin} star: ${report.poolSize} assets, ${share(report.poolSize)}% of the library`)
  if (Object.keys(report.rules).length > 0) {
    lines.push('settled by:')
    for (const [rule, n] of Object.entries(report.rules).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${rule.padEnd(16)} ${String(n).padStart(6)}  ${share(n)}%`)
    }
  }
  lines.push('')
  lines.push(`least certain ${report.uncertain.length}, correct these in Immich to train the model:`)
  for (const u of report.uncertain) {
    lines.push(`  ${u.rating} star  conf=${u.uncertainty.toFixed(3)}  ${(u.rule ?? '').padEnd(15)} ${u.url}`)
  }
  return lines.join('\n')
}
