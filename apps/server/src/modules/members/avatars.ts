import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'

// Members' profile pictures. The browser crops and shrinks a photo to a small square (apps/web/src/lib/avatar.ts);
// here it must really be a JPEG, PNG or WebP — judged by its bytes, never the name or the declared type, and never SVG
// (which can carry script) — and small. Served only to signed-in members, at a versioned address browsers cache.

export const MAX_AVATAR_BYTES = 512 * 1024
export type AvatarMime = 'image/jpeg' | 'image/png' | 'image/webp'

/** What the bytes are, from their signature. */
export function sniff(b: Buffer): AvatarMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

export function avatarsService({ db, hub }: { db: Db; hub: Hub }) {
  const q = {
    versions: db.prepare('select user_id, updated_at from user_avatars'),
    get: db.prepare('select mime, data, updated_at from user_avatars where user_id = ?'),
    save: db.prepare(`insert into user_avatars (user_id, mime, data, updated_at) values (?, ?, ?, unixepoch())
      on conflict(user_id) do update set mime = excluded.mime, data = excluded.data, updated_at = max(unixepoch(), user_avatars.updated_at + 1)`),
    remove: db.prepare('delete from user_avatars where user_id = ?'),
  }
  hub.authorize('members', () => true)
  // Everyone's open pages show the new picture without a reload.
  const changed = () => hub.publish('members', { type: 'changed' })

  return {
    /** When each member's picture last changed (the version in its address); members without one aren't listed. */
    versions: () => new Map((q.versions.all() as { user_id: number; updated_at: number }[]).map((r) => [r.user_id, r.updated_at])),

    get(userId: number) {
      const r = q.get.get(userId) as { mime: AvatarMime; data: Uint8Array; updated_at: number } | undefined
      if (!r) throw new AppError(404, 'not_found', 'No picture.')
      return { mime: r.mime, data: Buffer.from(r.data), updatedAt: r.updated_at }
    },

    /** A member sets their own picture. */
    set(userId: number, data: Buffer) {
      if (data.length > MAX_AVATAR_BYTES) throw new AppError(400, 'too_big', 'That picture is too big. Choose a smaller one.')
      const mime = sniff(data)
      if (!mime) throw new AppError(400, 'bad_image', 'Use a JPEG, PNG or WebP picture.')
      q.save.run(userId, mime, data)
      changed()
      return { avatarAt: (q.get.get(userId) as { updated_at: number }).updated_at }
    },

    remove(userId: number) {
      if (q.remove.run(userId).changes) changed()
      return { avatarAt: null }
    },
  }
}

export type AvatarsService = ReturnType<typeof avatarsService>
