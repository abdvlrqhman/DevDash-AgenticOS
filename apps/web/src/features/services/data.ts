import { queryOptions, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/lib/api'
import { useTopic } from '@/lib/live'

const fetchServices = () => unwrap(api.api.services.$get())
export const servicesQuery = queryOptions({ queryKey: ['services'], queryFn: fetchServices })

export type Service = Awaited<ReturnType<typeof fetchServices>>['services'][number]

/** Any change on the server (started, crashed, listening...) refreshes the list. */
export function useLiveServices() {
  const qc = useQueryClient()
  useTopic('services', () => void qc.invalidateQueries({ queryKey: ['services'] }), () => void qc.invalidateQueries({ queryKey: ['services'] }))
}

export function stateOf(s: Service): { light: 'live' | 'waiting' | 'error' | 'idle'; label: string } {
  switch (s.state) {
    case 'running':
      return s.listening ? { light: 'live', label: 'Running' } : { light: 'idle', label: 'Running, not listening yet' }
    case 'starting':
      return { light: 'idle', label: 'Starting' }
    case 'crashed':
      return { light: 'error', label: 'Crashed' }
    case 'stopped':
      return { light: 'idle', label: 'Stopped' }
    default:
      return { light: 'idle', label: 'Checking' }
  }
}
