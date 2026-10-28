import { hc, type ClientResponse } from 'hono/client'
import { queryOptions } from '@tanstack/react-query'
import type { AppType } from '../../../server/src/app.ts'

export const api = hc<AppType>('/', { init: { credentials: 'same-origin' } })

export class ApiError extends Error {
  status: number
  code: string
  constructor(message: string, status: number, code: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Resolves to the typed success body, or throws ApiError with the server's message. */
export async function unwrap<T>(p: Promise<ClientResponse<T, any, any>>): Promise<T> {
  const res = await p
  if (res.ok) return (await res.json()) as T
  const body = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null
  throw new ApiError(body?.error?.message ?? `Request failed (${res.status})`, res.status, body?.error?.code ?? 'http_error')
}

export type User = Awaited<ReturnType<typeof fetchMe>>

async function fetchMe() {
  const res = await api.api.auth.me.$get()
  if (res.status === 401) return null
  return (await unwrap(Promise.resolve(res))).user
}

export const meQuery = queryOptions({ queryKey: ['me'], queryFn: fetchMe, staleTime: 60_000 })

export const spaceQuery = queryOptions({
  queryKey: ['space'],
  queryFn: async () => (await fetch('/.well-known/devdash.json')).json() as Promise<{ app: 'devdash'; name: string; version: string; api: number }>,
  staleTime: Infinity,
})
