/**
 * How a followed session reads in the strip and the chip. "needs you": the session itself asks something, waits for a
 * permission or failed. "Hamasa told you": Hamasa reported it and waits for their word. Otherwise its replies so far.
 * `status`: the session's live status. Pure, tested.
 */
export const followLabel = (f: { state: string; replies: number; maxReplies: number }, status: string) =>
  status === 'waiting' || status === 'error' ? 'needs you' : f.state === 'waiting_you' ? 'Hamasa told you' : `${f.replies}/${f.maxReplies} replies`
/** Whether the label asks for the member's attention (the amber tone). */
export const followNeedsYou = (status: string) => status === 'waiting' || status === 'error'
/** A followed session's status as the status light shows it. */
export const followLight = (status: string) => (status === 'working' ? 'live' : status === 'waiting' ? 'waiting' : status === 'error' ? 'error' : 'idle')
