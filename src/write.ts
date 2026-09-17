import type { ImmichClient } from './immich.js'
import type { Scored } from './types.js'
import { chunks } from './pool.js'
import { log } from './log.js'

export interface WriteResult {
  written: number
  failed: { ids: string[]; rating: number; error: string }[]
}

/** Groups by rating so each bulk PUT /assets carries one value, then runs the groups with a cap. */
export async function writeRatings(
  client: ImmichClient,
  scored: Scored[],
  opts: { batchSize: number; concurrency: number },
  onWritten: (ids: string[], rating: number) => void,
): Promise<WriteResult> {
  const byRating = new Map<number, string[]>()
  for (const s of scored) {
    const list = byRating.get(s.rating) ?? []
    list.push(s.id)
    byRating.set(s.rating, list)
  }

  const jobs: { rating: number; ids: string[] }[] = []
  for (const [rating, ids] of byRating) {
    for (const batch of chunks(ids, opts.batchSize)) jobs.push({ rating, ids: batch })
  }

  const result: WriteResult = { written: 0, failed: [] }
  let next = 0
  const workers = Array.from({ length: Math.min(opts.concurrency, jobs.length) }, async () => {
    for (;;) {
      const i = next++
      const job = jobs[i]
      if (!job) return
      try {
        await client.updateRatings(job.ids, job.rating)
        onWritten(job.ids, job.rating)
        result.written += job.ids.length
        log.debug('write.batch', { rating: job.rating, count: job.ids.length })
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        result.failed.push({ ids: job.ids, rating: job.rating, error })
        log.error('write.batch_failed', { rating: job.rating, count: job.ids.length, error })
      }
    }
  })
  await Promise.all(workers)
  return result
}
