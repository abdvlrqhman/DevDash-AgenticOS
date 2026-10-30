import { LoaderCircle } from 'lucide-react'
import { sileo, type SileoOptions } from 'sileo'

/**
 * The app's toasts: Sileo's ink pills, behind the small API the app already used (sonner's). Sileo shows a short title in
 * the pill and anything longer in a body it opens itself, so a sentence-long message goes in the body under a short label.
 * `id` replaces the toast that id showed before (a download's "Downloading…" becomes "Downloaded").
 */
type Kind = 'success' | 'error' | 'warning' | 'info' | 'loading' | 'message'
type Action = { label: string; onClick: () => void }
export type ToastOptions = {
  id?: string
  description?: React.ReactNode
  action?: Action
  /** ms; Infinity stays until dismissed */
  duration?: number
  closeButton?: boolean
}

const LABEL: Record<Kind, string> = { success: 'Done', error: "Didn't work", warning: 'Heads up', info: 'Note', loading: 'Working', message: 'DevDash' }
/** What fits on Sileo's pill without being cut. */
const PILL = 34

const shown = new Map<string, string>() // our id → Sileo's

function show(kind: Kind, message: string, o: ToastOptions = {}): string {
  const long = message.length > PILL
  const body = long ? (o.description ? <><span className="font-medium">{message}</span><br />{o.description}</> : message) : o.description
  const opts: SileoOptions = {
    title: long ? LABEL[kind] : message,
    ...(body ? { description: body } : {}),
    duration: o.duration === Infinity || kind === 'loading' ? null : o.duration ?? (body ? 8000 : 4000),
    ...(o.action ? { button: { title: o.action.label, onClick: o.action.onClick } } : {}),
    ...(kind === 'loading' ? { icon: <LoaderCircle className="size-3.5 animate-spin" /> } : {}),
  }
  if (o.id && shown.has(o.id)) sileo.dismiss(shown.get(o.id)!)
  const id = kind === 'success' ? sileo.success(opts)
    : kind === 'error' ? sileo.error(opts)
    : kind === 'warning' ? sileo.warning(opts)
    : kind === 'info' ? sileo.info(opts)
    : kind === 'loading' ? sileo.show({ ...opts, type: 'loading' })
    : o.action ? sileo.action(opts) : sileo.info(opts)
  if (o.id) shown.set(o.id, id)
  return id
}

export const toast = Object.assign((message: string, o?: ToastOptions) => show('message', message, o), {
  success: (message: string, o?: ToastOptions) => show('success', message, o),
  error: (message: string, o?: ToastOptions) => show('error', message, o),
  warning: (message: string, o?: ToastOptions) => show('warning', message, o),
  info: (message: string, o?: ToastOptions) => show('info', message, o),
  loading: (message: string, o?: ToastOptions) => show('loading', message, o),
  dismiss: (id: string) => sileo.dismiss(shown.get(id) ?? id),
})
