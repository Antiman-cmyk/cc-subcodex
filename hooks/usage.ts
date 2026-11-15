import type { Limit } from './types'

/** Percent of a usage limit from which it counts as nearly used up. */
export const NEARLY = 90

/** A limit's window in words: `5-hour`, `weekly`. */
const windowOf = (minutes: number | undefined): string =>
  minutes === undefined
    ? ''
    : minutes === 10_080
      ? 'weekly'
      : minutes % 1440 === 0
        ? `${minutes / 1440}-day`
        : minutes % 60 === 0
          ? `${minutes / 60}-hour`
          : `${minutes}-minute`

/** A usage limit in words: which, how much is used, when it resets. */
export function limitText(limit: Limit): string {
  const which = [limit.name, windowOf(limit.minutes)].filter(Boolean).join(' ')
  const resets =
    limit.resetsAt === undefined ? '' : `, starts over ${new Date(limit.resetsAt * 1000).toLocaleString()}`
  return `${Math.round(limit.used)}% of the ${which === '' ? 'usage' : which} limit used${resets}`
}

/** A limit's key: its name and window. */
export const limitKey = (limit: Limit): string => `${limit.name ?? ''}:${limit.minutes ?? ''}`

