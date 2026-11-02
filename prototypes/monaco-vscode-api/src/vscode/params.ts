const params = new URLSearchParams(window.location.search)

/** `?remoteAuthority=host:port` connects to a Code OSS `reh` server (not built in this prototype). */
export const remoteAuthority = params.get('remoteAuthority') ?? undefined

/** Startup marks, read by the measurement scripts through `window.__axisMarks`. */
export function startMark(name: string): void {
  performance.mark(name)
  const marks = (window.__axisMarks ??= {})
  marks[name] = Math.round(performance.now())
}
