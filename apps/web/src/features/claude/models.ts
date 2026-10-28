// Claude Code's model list, organised for people: the default (and what it really is), then one entry per family
// (Opus, Sonnet, ...) holding its versions, newest first. Built from whatever Claude Code reports, so new models and
// new families show up on their own.

export type ModelInfo = {
  value: string
  displayName: string
  description?: string
  /** The model ID a row stands for ('opus' → 'claude-opus-5-5'); 'default' resolves too. */
  resolvedModel?: string
  supportedEffortLevels?: string[]
}
export type ModelRow = ModelInfo & { version: number[]; newest: boolean }
export type ModelFamily = { name: string; rows: ModelRow[] }

export const isDefaultModel = (v: string | null | undefined) => !v || v === 'default'

/** "claude-opus-4-8" → opus, [4, 8]; dates like 20251001 aren't versions. Falls back to the display name. */
function parse(m: ModelInfo) {
  const id = m.resolvedModel ?? (m.value.startsWith('claude-') ? m.value : '')
  const parts = id.replace(/^claude-/, '').split('-')
  const family = parts[0] && /^[a-z]+$/.test(parts[0]) ? parts[0] : (m.displayName.split(/[\s(]/)[0] ?? m.value).toLowerCase()
  const version = parts.slice(1).filter((p) => /^\d{1,3}$/.test(p)).map(Number)
  if (!version.length) version.push(...(m.displayName.match(/\d+(?:\.\d+)*/)?.[0].split('.').map(Number) ?? []))
  return { family, version }
}

const newerFirst = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0)
    if (d) return d
  }
  return 0
}

export function groupModels(models: ModelInfo[]) {
  const def = models.find((m) => isDefaultModel(m.value))
  const families: ModelFamily[] = []
  for (const m of models) {
    if (m === def) continue
    const { family, version } = parse(m)
    const name = family.charAt(0).toUpperCase() + family.slice(1)
    let f = families.find((x) => x.name === name)
    if (!f) families.push((f = { name, rows: [] }))
    // An alias ('opus') always means the family's newest model; a full ID ('claude-opus-4-8') stays put.
    f.rows.push({ ...m, version, newest: !m.value.startsWith('claude-') })
  }
  for (const f of families) f.rows.sort((a, b) => Number(b.newest) - Number(a.newest) || newerFirst(a.version, b.version))
  const defName = def
    ? models.find((m) => m !== def && def.resolvedModel && m.resolvedModel === def.resolvedModel)?.displayName
      ?? def.description?.split('·')[0]?.trim()
    : undefined
  return { def, defName: defName || undefined, families }
}

/** What a picker shows: "Default · Opus 5.5", a model's name, or the raw ID for one typed in by hand. */
export function modelLabel(models: ModelInfo[], value: string | null | undefined) {
  if (isDefaultModel(value)) {
    const { defName } = groupModels(models)
    return defName ? `Default · ${defName}` : 'Default'
  }
  return models.find((m) => m.value === value)?.displayName ?? value!
}

/** The effort levels the chosen model supports; every level when Claude Code doesn't say. */
export function effortLevels(models: ModelInfo[], value: string | null | undefined, all: readonly string[]) {
  const m = isDefaultModel(value) ? groupModels(models).def : models.find((x) => x.value === value)
  return m?.supportedEffortLevels?.length ? all.filter((e) => m.supportedEffortLevels!.includes(e)) : [...all]
}
