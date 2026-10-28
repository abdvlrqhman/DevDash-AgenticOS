import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { busy, DISK_SPARE, MAX_BYTES, ops, roomFor } from './project.ts'

// A tiny, dependency-free ZIP writer (stored, no compression) so tests make real archives without a `zip` binary.
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function makeZip(entries: { name: string; data: Buffer }[]) {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const { name, data } of entries) {
    const nb = Buffer.from(name)
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x21, 12)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26)
    const local = Buffer.concat([lh, nb, data])
    locals.push(local)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x21, 14)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28)
    ch.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([ch, nb]))
    offset += local.length
  }
  const localsBuf = Buffer.concat(locals)
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(localsBuf.length, 16)
  return Buffer.concat([localsBuf, cd, eocd])
}

const newRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'dd-zip-'))
  process.env.DEVDASH_PROJECTS_ROOT = root
  return root
}
async function importZip(root: string, slug: string, zip: Buffer, id = 'abc12345') {
  await ops.zipChunk({ id, offset: 0, data: zip.toString('base64') })
  return ops.fromZip({ id, dest: `${root}/projects/${slug}` })
}

test('from-zip populates the project folder and makes it a git repo, then cleans up the temp zip', async () => {
  const root = newRoot()
  const zip = makeZip([{ name: 'index.js', data: Buffer.from('console.log(1)\n') }, { name: 'src/app.ts', data: Buffer.from('export {}\n') }])
  const r = await importZip(root, 'app', zip)
  assert.equal(r.defaultBranch, 'main')
  const dest = `${root}/projects/app`
  assert.ok(existsSync(join(dest, 'index.js')))
  assert.ok(existsSync(join(dest, 'src/app.ts')))
  assert.ok(existsSync(join(dest, '.git')), 'a git repo was initialised')
  assert.match(execFileSync('git', ['-C', dest, 'log', '--oneline'], { encoding: 'utf8' }), /Import project/)
  assert.ok(!existsSync(`${root}/projects/.dd-uploads/abc12345.zip`), 'the uploaded zip is cleaned up')
})

test('a zip with a ../escape entry is rejected and leaves no project behind', async () => {
  const root = newRoot()
  const zip = makeZip([{ name: '../escape.txt', data: Buffer.from('pwned') }, { name: 'ok.txt', data: Buffer.from('y') }])
  await assert.rejects(importZip(root, 'bad', zip), /unsafe/)
  assert.ok(!existsSync(`${root}/projects/bad`), 'no dangling project folder')
})

test('a single top-level folder is flattened so the files sit directly in the project', async () => {
  const root = newRoot()
  const zip = makeZip([{ name: 'myapp/a.txt', data: Buffer.from('a') }, { name: 'myapp/sub/b.txt', data: Buffer.from('b') }])
  await importZip(root, 'flat', zip)
  const dest = `${root}/projects/flat`
  assert.ok(existsSync(join(dest, 'a.txt')))
  assert.ok(existsSync(join(dest, 'sub/b.txt')))
  assert.ok(!existsSync(join(dest, 'myapp')), 'the lone top folder was flattened away')
})

test('finalizing refuses to overwrite a folder that already has files', async () => {
  const root = newRoot()
  const dest = `${root}/projects/taken`
  execFileSync('mkdir', ['-p', dest])
  execFileSync('touch', [join(dest, 'keep.me')])
  const zip = makeZip([{ name: 'x.txt', data: Buffer.from('x') }])
  await assert.rejects(importZip(root, 'taken', zip), /already exists/)
  assert.ok(existsSync(join(dest, 'keep.me')), 'the existing folder is untouched')
})

test('a .zip over 20 GB is refused before it uploads; the disk keeps room for everyone else', async () => {
  newRoot()
  await assert.rejects(ops.zipChunk({ id: 'b1612345', offset: 0, total: MAX_BYTES + 1, data: '' }), /over 20 GB/)
  await assert.rejects(ops.zipChunk({ id: 'b1612345', offset: MAX_BYTES, data: Buffer.from('x').toString('base64') }), /over 20 GB/)
  const GB = 1024 ** 3
  assert.equal(roomFor(100 * GB, 20 * GB, 'upload this .zip'), null)
  assert.equal(roomFor(25 * GB, 20 * GB, 'upload this .zip'), null) // exactly the spare left
  assert.match(roomFor(24 * GB, 20 * GB, 'unpack this .zip')!, /Not enough free space on the server to unpack this \.zip \(needs about 25 GB, 24 GB free\)/)
  assert.equal(DISK_SPARE, 5 * GB)
})

test("a deploy's restart waits for an upload in progress, and asking again for an import never imports twice", async () => {
  const root = newRoot()
  const zip = makeZip([{ name: 'README.md', data: Buffer.from('# hi\n') }])
  assert.equal(busy(), false)
  await ops.zipChunk({ id: 'a1b2c3d4', offset: 0, data: zip.toString('base64') })
  assert.equal(busy(), true) // a piece just arrived
  assert.equal(busy(Date.now() + 3 * 60_000), false) // two quiet minutes: the page gave up
  await ops.zipChunk({ id: 'a1b2c3d4', offset: 0, data: zip.toString('base64') })

  // The server restarted mid-import and asks again: both calls get the one import, which runs once.
  const dest = `${root}/projects/twice`
  const [a, b] = await Promise.all([ops.fromZip({ id: 'a1b2c3d4', dest }), ops.fromZip({ id: 'a1b2c3d4', dest })])
  assert.deepEqual([a, b], [{ defaultBranch: 'main' }, { defaultBranch: 'main' }])
  // Asked again after it finished (the answer was lost): it's done, not "the folder already exists".
  assert.deepEqual(await ops.fromZip({ id: 'a1b2c3d4', dest }), { defaultBranch: 'main' })
  assert.equal(execFileSync('git', ['-C', dest, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(), '1')
  assert.equal(busy(), false)
  // A different upload into that folder is still refused.
  await ops.zipChunk({ id: 'e5f6a7b8', offset: 0, data: zip.toString('base64') })
  await assert.rejects(ops.fromZip({ id: 'e5f6a7b8', dest }), /already exists/)
})
