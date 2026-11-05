// When roles work on their own: weekly time slots (core/schedule.ts) and what else starts a shift.
export * from '../../core/schedule.ts'

export const TRIGGERS = ['work', 'task_done', 'task_created'] as const
export type Trigger = (typeof TRIGGERS)[number]
