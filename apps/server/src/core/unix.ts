import { connect } from 'node:net'

/** One JSON request line → one JSON reply line over a Unix socket (root helper, agents). */
export function requestLine<T>(path: string, msg: unknown, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = connect(path)
    let buf = ''
    const fail = (err: Error) => {
      clearTimeout(timer)
      sock.destroy()
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error(`timed out talking to ${path}`)), timeoutMs)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'))
    sock.on('data', (d) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      clearTimeout(timer)
      sock.end()
      try {
        resolve(JSON.parse(buf.slice(0, i)) as T)
      } catch (err) {
        reject(err as Error)
      }
    })
    sock.on('error', fail)
    sock.on('end', () => !buf.includes('\n') && fail(new Error(`${path} closed without a reply`)))
  })
}
