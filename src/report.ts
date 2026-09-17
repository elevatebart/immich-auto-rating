import type { Scored } from './types.js'

export interface Report {
  counts: Record<string, number>
  total: number
  uncertain: { id: string; rating: number; uncertainty: number; raw: number; url: string }[]
}

export function assetUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/photos/${id}`
}

export function buildReport(scored: Scored[], baseUrl: string, top = 30): Report {
  const counts: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
  for (const s of scored) counts[String(s.rating)] = (counts[String(s.rating)] ?? 0) + 1

  const uncertain = [...scored]
    .sort((a, b) => a.uncertainty - b.uncertainty || a.id.localeCompare(b.id))
    .slice(0, top)
    .map((s) => ({
      id: s.id,
      rating: s.rating,
      uncertainty: Number(s.uncertainty.toFixed(4)),
      raw: Number(s.raw.toFixed(4)),
      url: assetUrl(baseUrl, s.id),
    }))

  return { counts, total: scored.length, uncertain }
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
  lines.push('')
  lines.push(`least certain ${report.uncertain.length}, correct these in Immich to train the model:`)
  for (const u of report.uncertain) {
    lines.push(`  ${u.rating} star  d=${u.uncertainty.toFixed(3)}  ${u.url}`)
  }
  return lines.join('\n')
}
