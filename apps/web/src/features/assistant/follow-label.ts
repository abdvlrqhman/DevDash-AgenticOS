/** How a followed session reads in the strip and the chip: its replies so far, or that it waits for the member. Pure, tested. */
export const followLabel = (f: { state: string; replies: number; maxReplies: number }) =>
  f.state === 'waiting_you' ? 'waits for you' : `${f.replies}/${f.maxReplies} replies`
/** A followed session's status as the status light shows it. */
export const followLight = (status: string) => (status === 'working' ? 'live' : status === 'waiting' ? 'waiting' : status === 'error' ? 'error' : 'idle')
