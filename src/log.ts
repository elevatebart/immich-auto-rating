type Level = 'debug' | 'info' | 'warn' | 'error'

let quiet = false

export function setQuiet(v: boolean): void {
  quiet = v
}

function emit(level: Level, event: string, fields: Record<string, unknown>): void {
  if (quiet && level === 'debug') return
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

export const log = {
  debug: (event: string, fields: Record<string, unknown> = {}) => emit('debug', event, fields),
  info: (event: string, fields: Record<string, unknown> = {}) => emit('info', event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => emit('warn', event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => emit('error', event, fields),
}
