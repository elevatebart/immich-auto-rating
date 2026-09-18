import type { Rule, Scored } from './types.js'

export interface Report {
  counts: Record<string, number>
  /** How each rating was settled, so an oversized bucket can be traced to the rule that filled it. */
  rules: Record<string, number>
  poolSize: number
  poolMin: number
  total: number
  uncertain: { id: string; rating: number; uncertainty: number; raw: number; rule?: Rule; url: string }[]
  /** Representative links per rating and per rule, for judging by eye what no count can show. */
  samples: { label: string; urls: string[] }[]
}

export function assetUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/photos/${id}`
}

/** Evenly spaced picks through a bucket ordered by score, so a sample spans it instead of clumping. */
function spread<T>(items: T[], n: number): T[] {
  if (n <= 0 || items.length === 0) return []
  if (items.length <= n) return items
  const out: T[] = []
  for (let i = 0; i < n; i++) out.push(items[Math.floor((i * items.length) / n)]!)
  return out
}

export function buildReport(
  scored: Scored[],
  baseUrl: string,
  top = 30,
  poolMinRating = 4,
  sample = 0,
): Report {
  const counts: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
  const rules: Record<string, number> = {}
  let poolSize = 0
  for (const s of scored) {
    counts[String(s.rating)] = (counts[String(s.rating)] ?? 0) + 1
    if (s.rule) {
      const key = s.detail ? `${s.rule}: ${s.detail}` : s.rule
      rules[key] = (rules[key] ?? 0) + 1
    }
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

  const samples: { label: string; urls: string[] }[] = []
  if (sample > 0) {
    const byScore = [...scored].sort((a, b) => a.raw - b.raw || a.id.localeCompare(b.id))
    for (const r of ['5', '4', '3', '2', '1']) {
      const items = byScore.filter((s) => String(s.rating) === r)
      if (items.length > 0) {
        samples.push({ label: `${r} star (${items.length})`, urls: spread(items, sample).map((s) => assetUrl(baseUrl, s.id)) })
      }
    }
    for (const rule of Object.keys(rules).sort()) {
      const items = byScore.filter((s) => (s.detail ? `${s.rule}: ${s.detail}` : s.rule) === rule)
      if (items.length > 0) {
        samples.push({ label: `rule ${rule} (${items.length})`, urls: spread(items, sample).map((s) => assetUrl(baseUrl, s.id)) })
      }
    }
  }

  return { counts, rules, poolSize, poolMin: poolMinRating, total: scored.length, uncertain, samples }
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
      lines.push(`  ${rule.padEnd(38)} ${String(n).padStart(6)}  ${share(n)}%`)
    }
  }
  lines.push('')
  lines.push(`least certain ${report.uncertain.length}, correct these in Immich to train the model:`)
  for (const u of report.uncertain) {
    lines.push(`  ${u.rating} star  conf=${u.uncertainty.toFixed(3)}  ${(u.rule ?? '').padEnd(15)} ${u.url}`)
  }
  for (const s of report.samples) {
    lines.push('')
    lines.push(`sample, ${s.label}, worst score first:`)
    for (const url of s.urls) lines.push(`  ${url}`)
  }
  return lines.join('\n')
}
