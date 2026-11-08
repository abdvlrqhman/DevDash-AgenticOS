import { queryOptions } from '@tanstack/react-query'
import { api, ApiError, unwrap } from '@/lib/api'
import type { Changed, Review, SkillFile, SkillSource } from '../../../../server/src/modules/skills/routes.ts'

export type { BuiltInSkill, Review, ReviewSkill, SkillDetail, SkillFile, SkillSource, SkillSummary } from '../../../../server/src/modules/skills/routes.ts'

export const skillsQuery = queryOptions({ queryKey: ['skills', 'mine'], queryFn: () => unwrap(api.api.skills.$get()) })
export const projectSkillsQuery = (slug: string) =>
  queryOptions({ queryKey: ['skills', 'project', slug], queryFn: () => unwrap(api.api.skills.projects[':slug'].$get({ param: { slug } })) })
export const skillQuery = (name: string, project?: string) => queryOptions({
  queryKey: ['skills', 'skill', project ?? '', name],
  queryFn: () => project
    ? unwrap(api.api.skills.projects[':slug'].skill[':name'].$get({ param: { slug: project, name } }))
    : unwrap(api.api.skills.mine[':name'].$get({ param: { name } })),
})
export const reviewQuery = (id: string, project?: string) => queryOptions({
  queryKey: ['skills', 'review', id, project ?? ''],
  queryFn: () => unwrap(api.api.skills.review[':id'].$get({ param: { id }, query: project ? { project } : {} })),
  staleTime: Infinity,
  retry: false,
})

/** The same rules the agent checks (apps/agent/src/skills.ts), so the form says what's wrong before sending. */
export const NAME_MAX = 64
export const DESCRIPTION_MAX = 1024
export function nameProblem(name: string) {
  if (!name) return null // not yet typed: no complaint
  if (name.length > NAME_MAX) return `At most ${NAME_MAX} characters.`
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return 'Lowercase letters, digits and single hyphens, like pdf-tools.'
  return null
}
export function descriptionProblem(d: string) {
  if (d.length > DESCRIPTION_MAX) return `At most ${DESCRIPTION_MAX} characters.`
  if (/[<>]/.test(d)) return 'No < or >.'
  return null
}

export async function writeSkill(input: { name: string; description: string; body: string; replace?: boolean }, project?: string): Promise<Changed> {
  const json = { replace: false, ...input }
  return project ? unwrap(api.api.skills.projects[':slug'].$post({ param: { slug: project }, json })) : unwrap(api.api.skills.mine.$post({ json }))
}

export async function reviewGithub(url: string, project?: string) {
  return (await unwrap(api.api.skills.review.github.$post({ json: { url, ...(project ? { project } : {}) } }))).review as Review
}

/** A .zip or .skill (at most 10 MB) goes up as it is; the agent unpacks it into a new empty folder for review. */
export async function reviewUpload(file: File, project?: string) {
  const q = new URLSearchParams({ fileName: file.name, ...(project ? { project } : {}) })
  const res = await fetch(`/api/skills/review/upload?${q}`, { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' }, credentials: 'same-origin' })
  const body = (await res.json().catch(() => null)) as { review?: Review; error?: { message?: string; code?: string } } | null
  if (!res.ok || !body?.review) throw new ApiError(body?.error?.message ?? `Upload failed (${res.status})`, res.status, body?.error?.code ?? 'http_error')
  return body.review
}

export const installReviewed = (id: string, input: { path: string; name: string; project?: string; replace?: boolean }) =>
  unwrap(api.api.skills.review[':id'].install.$post({ param: { id }, json: { replace: false, ...input } }))
export const discardReview = (id: string) => unwrap(api.api.skills.review[':id'].$delete({ param: { id } })).catch(() => {})

export const removeSkill = (name: string, project?: string) => project
  ? unwrap(api.api.skills.projects[':slug'].skill[':name'].$delete({ param: { slug: project, name } }))
  : unwrap(api.api.skills.mine[':name'].$delete({ param: { name } }))
export const setEnabled = (name: string, enabled: boolean) => unwrap(api.api.skills.mine[':name'].enabled.$put({ param: { name }, json: { enabled } }))
export const pushProject = (slug: string) => unwrap(api.api.skills.projects[':slug'].push.$post({ param: { slug } }))

/** What in a skill could run: scripts, binaries, anything executable. */
export const runnable = (files: SkillFile[]) => files.filter((f) => f.kind !== 'text' || f.executable)

export function sourceLabel(s: SkillSource | null | undefined) {
  if (!s) return 'Added outside DevDash'
  if (s.kind === 'written') return 'Written in DevDash'
  if (s.kind === 'upload') return `Uploaded as ${s.file}`
  return `${s.repo}${s.path ? `, ${s.path}` : ''}`
}
export const shortSha = (sha: string) => sha.slice(0, 7)
export const commitUrl = (s: { repo: string; sha: string; path: string }) => `https://github.com/${s.repo}/tree/${s.sha}${s.path ? `/${s.path}` : ''}`
