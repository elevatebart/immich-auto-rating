import type { Album, ImmichClient } from './immich.js'

export interface PoolPlan {
  add: string[]
  remove: string[]
  createAlbum: boolean
}

export const POOL_MARKER = '[auto-rating] pool'

/**
 * Pure reconciliation. `eligible` is every asset at or above pool_min_rating, `current` is what
 * the album holds. Assets the run did not look at stay put, so an untouched album is not emptied.
 */
export function planPool(
  eligible: ReadonlySet<string>,
  current: ReadonlySet<string>,
  seen: ReadonlySet<string>,
  albumExists: boolean,
): PoolPlan {
  const add: string[] = []
  for (const id of eligible) if (!current.has(id)) add.push(id)

  const remove: string[] = []
  for (const id of current) if (seen.has(id) && !eligible.has(id)) remove.push(id)

  return { add, remove, createAlbum: !albumExists }
}

export function findAlbum(albums: Album[], name: string): Album | undefined {
  return albums.find((a) => a.albumName === name)
}

export async function applyPool(
  client: ImmichClient,
  albumName: string,
  plan: PoolPlan,
  albumId: string | undefined,
  chunk = 500,
): Promise<{ albumId: string; added: number; removed: number }> {
  let id = albumId
  if (!id) {
    if (plan.add.length === 0) return { albumId: '', added: 0, removed: 0 }
    const album = await client.createAlbum(albumName, POOL_MARKER)
    id = album.id
  }
  for (const batch of chunks(plan.add, chunk)) await client.addAssetsToAlbum(id, batch)
  for (const batch of chunks(plan.remove, chunk)) await client.removeAssetsFromAlbum(id, batch)
  return { albumId: id, added: plan.add.length, removed: plan.remove.length }
}

export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
