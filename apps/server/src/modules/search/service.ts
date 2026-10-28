import type { Db } from '../../core/db.ts'

/** Full-text index (SQLite FTS5) for task and note text. Owners keep it in step; callers check visibility. */
export function searchService({ db }: { db: Db }) {
  const q = {
    del: db.prepare('delete from search where kind = ? and ref = ?'),
    ins: db.prepare('insert into search (kind, ref, title, body) values (?, ?, ?, ?)'),
    find: db.prepare(`select kind, ref, snippet(search, 3, '', '', '…', 14) as snippet from search where search match ? order by rank limit 60`),
  }
  return {
    put(kind: 'task' | 'note', ref: number, title: string, body: string) {
      q.del.run(kind, String(ref))
      q.ins.run(kind, String(ref), title, body)
    },
    remove: (kind: 'task' | 'note', ref: number) => void q.del.run(kind, String(ref)),
    /** Every word must match, as a prefix ("depl" finds "deploy"). */
    find(text: string) {
      const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? []
      if (!words.length) return []
      return q.find.all(words.map((w) => `"${w}"*`).join(' ')) as { kind: 'task' | 'note'; ref: string; snippet: string }[]
    },
  }
}

export type SearchService = ReturnType<typeof searchService>
