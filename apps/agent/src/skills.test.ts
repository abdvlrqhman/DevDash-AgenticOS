import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Everything runs in a fake home and a fake /srv/devdash, set before any skills code looks.
const base = mkdtempSync(join(tmpdir(), 'dd-skills-'))
const HOME = join(base, 'home')
mkdirSync(HOME)
process.env.HOME = HOME
process.env.DEVDASH_PROJECTS_ROOT = join(base, 'srv')
const s = await import('./skills.ts')

// A tiny ZIP writer (stored, no compression) that can also write unix modes, so tests can smuggle in links.
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
function makeZip(entries: { name: string; data: Buffer | string; mode?: number; size?: number }[]) {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const data = Buffer.from(e.data)
    const nb = Buffer.from(e.name)
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(e.size ?? data.length, 22); lh.writeUInt16LE(nb.length, 26)
    const local = Buffer.concat([lh, nb, data])
    locals.push(local)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(e.mode ? (3 << 8) | 20 : 20, 4); ch.writeUInt16LE(20, 6)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(e.size ?? data.length, 24); ch.writeUInt16LE(nb.length, 28)
    if (e.mode) ch.writeUInt32LE((e.mode << 16) >>> 0, 38)
    ch.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([ch, nb]))
    offset += local.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
const md = (name: string, description = 'Does a thing. Use when testing.') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
const upload = (zip: Buffer, fileName = 'skill.zip') => s.ops.reviewUpload({ data: zip.toString('base64'), fileName })

test('skill names: lowercase words with single hyphens, up to 64', () => {
  for (const ok of ['pdf', 'pdf-tools', 'a1', 'x'.repeat(64)]) assert.equal(s.nameProblem(ok), null, ok)
  for (const bad of ['', 'PDF', 'pdf_tools', '-pdf', 'pdf-', 'pdf--tools', 'pdf tools', '../x', 'x'.repeat(65), 'café']) assert.notEqual(s.nameProblem(bad), null, bad)
})

test('descriptions: required, at most 1024, no angle brackets', () => {
  assert.equal(s.descriptionProblem('Fills PDF forms. Use when a PDF form is mentioned.'), null)
  assert.notEqual(s.descriptionProblem('   '), null)
  assert.notEqual(s.descriptionProblem('x'.repeat(1025)), null)
  assert.equal(s.descriptionProblem('x'.repeat(1024)), null)
  assert.notEqual(s.descriptionProblem('use <script>'), null)
})

test('SKILL.md frontmatter: plain, quoted, block and continued values; nested maps skipped', () => {
  assert.deepEqual(s.parseSkillMd(md('pdf')).name, 'pdf')
  const q = s.parseSkillMd('---\nname: "x"\ndescription: \'It\'\'s fine: really\'\n---\nbody')
  assert.equal(q.description, "It's fine: really")
  assert.equal(q.body, 'body')
  const block = s.parseSkillMd('---\nname: y\ndescription: >\n  First line\n  second line.\nmetadata:\n  a: b\nlicense: MIT\n---\n')
  assert.equal(block.description, 'First line second line.')
  const cont = s.parseSkillMd('---\r\nname: z\r\ndescription: one\r\n  two\r\n---\r\nhi')
  assert.equal(cont.description, 'one two')
  assert.equal(s.parseSkillMd('# no frontmatter').frontmatter, false)
  // What DevDash writes reads back the same, whatever the description holds.
  const desc = 'Says "hi": always. Use when\\ greeting #1'
  const back = s.parseSkillMd(s.buildSkillMd('greet', desc, 'Say hi.'))
  assert.equal(back.name, 'greet')
  assert.equal(back.description, desc)
  assert.equal(back.body.trim(), 'Say hi.')
})

test('GitHub links: repos, folders, files; anything else is refused', () => {
  assert.deepEqual(s.parseGithubUrl('https://github.com/anthropics/skills'), { owner: 'anthropics', repo: 'skills', rest: [], blob: false })
  assert.deepEqual(s.parseGithubUrl('github.com/anthropics/skills.git/'), { owner: 'anthropics', repo: 'skills', rest: [], blob: false })
  assert.deepEqual(s.parseGithubUrl('https://github.com/anthropics/skills/tree/main/skills/pdf?x=1#y'), { owner: 'anthropics', repo: 'skills', rest: ['main', 'skills', 'pdf'], blob: false })
  assert.deepEqual(s.parseGithubUrl('https://www.github.com/o/r/blob/v1/a/SKILL.md')?.blob, true)
  for (const bad of [
    'https://gitlab.com/o/r', 'https://github.com/o', 'https://github.com.evil.io/o/r', 'https://user:pw@github.com/o/r', 'file:///etc/passwd',
    'https://github.com/o/r/issues/1', 'https://github.com/o/r/tree/main/../x', 'https://github.com/o/r/tree/main/%2e%2e/x', 'https://github.com/-o/r',
    'https://github.com/o/r/tree/--upload-pack=x', 'https://github.com/o/../tree/main', 'https://github.com:8080/o/r', 'not a url',
  ]) assert.equal(s.parseGithubUrl(bad), null, bad)
})

test('GitHub links: refs with slashes win over the first segment; a file link means its folder', () => {
  const g = s.parseGithubUrl('https://github.com/o/r/tree/feature/x/skills/pdf')!
  assert.deepEqual(s.splitRef(g, ['main', 'feature/x']), { ref: 'feature/x', path: 'skills/pdf' })
  assert.deepEqual(s.splitRef(g, ['main']), { ref: 'feature', path: 'x/skills/pdf' })
  assert.deepEqual(s.splitRef(s.parseGithubUrl('https://github.com/o/r/blob/main/skills/pdf/SKILL.md')!, ['main']), { ref: 'main', path: 'skills/pdf' })
  assert.deepEqual(s.splitRef(s.parseGithubUrl('https://github.com/o/r/tree/0123abc')!, []), { ref: '0123abc', path: '' })
  assert.deepEqual(s.splitRef(s.parseGithubUrl('https://github.com/o/r')!, []), { ref: null, path: '' })
})

test('file kinds: anything that could run is a script or a binary', () => {
  assert.equal(s.fileKind('notes.md', Buffer.from('# hi')), 'text')
  assert.equal(s.fileKind('run', Buffer.from('#!/bin/sh\necho')), 'script')
  assert.equal(s.fileKind('tool.py', Buffer.from('print(1)')), 'script')
  assert.equal(s.fileKind('x.MJS', Buffer.from('1')), 'script')
  assert.equal(s.fileKind('img.png', Buffer.from([0x89, 0x50, 0, 1])), 'binary')
})

test('zip vetting: traversal, absolute paths, links, special files and bombs are refused', () => {
  const file = (size = 1) => ({ type: '-', size })
  assert.doesNotThrow(() => s.vetZip(['a/SKILL.md'], [file()], 10))
  for (const n of ['../evil', 'a/../../evil', '/etc/passwd', 'C:/x', 'a\\..\\b', 'a/\x01']) assert.throws(() => s.vetZip([n], [file()], 10), /unsafe/, n)
  assert.throws(() => s.vetZip(['a'], [{ type: 'l', size: 3 }], 10), /links/)
  assert.throws(() => s.vetZip(['a'], [{ type: 'c', size: 0 }], 10), /special/)
  assert.throws(() => s.vetZip(['a'], [file(s.LIMITS.total + 1)], s.LIMITS.total), /more than/)
  assert.throws(() => s.vetZip(['a'], [file(50 * 1024 * 1024)], 1000), /zip bomb/)
  assert.throws(() => s.vetZip([], [], 0), /empty/)
  assert.deepEqual(s.parseZipinfo('Archive:  x\nZip file size: 1\n-rwxr-xr-x  2.0 unx        2 b- stor 80-000-00 00:00 s/SKILL.md\nlrwxrwxrwx  2.0 unx       11 b- stor 80-000-00 00:00 s/l\n-rw----     2.0 fat        1 b- stor 80-000-00 00:00 s/p\n3 files, 14 bytes'),
    [{ type: '-', size: 2 }, { type: 'l', size: 11 }, { type: '-', size: 1 }])
})

test('uploads: a real archive is listed for review with scripts marked, and installs only what was reviewed', async () => {
  const zip = makeZip([
    { name: 'pdf-fill/SKILL.md', data: md('pdf-fill') },
    { name: 'pdf-fill/scripts/fill.py', data: 'print(1)' },
    { name: 'pdf-fill/bin/tool', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]), mode: 0o100755 },
    { name: 'pdf-fill/README.md', data: 'read me' },
  ])
  const review = await upload(zip, 'pdf-fill.skill')
  assert.equal(review.skills.length, 1)
  const sk = review.skills[0]!
  assert.equal(sk.suggested, 'pdf-fill')
  assert.deepEqual(sk.problems, [])
  const kinds = Object.fromEntries(sk.files.map((f) => [f.path, f.kind]))
  assert.deepEqual(kinds, { 'README.md': 'text', 'SKILL.md': 'text', 'bin/tool': 'binary', 'scripts/fill.py': 'script' })
  assert.equal(sk.files.find((f) => f.path === 'bin/tool')!.executable, true)
  // Nothing is installed until the member confirms.
  assert.equal(existsSync(join(HOME, '.claude', 'skills', 'pdf-fill')), false)
  await s.ops.install({ id: review.id, path: sk.path, name: 'pdf-fill' })
  const dest = join(HOME, '.claude', 'skills', 'pdf-fill')
  assert.equal(readFileSync(join(dest, 'scripts', 'fill.py'), 'utf8'), 'print(1)')
  assert.equal(JSON.parse(readFileSync(join(dest, '.devdash-source.json'), 'utf8')).file, 'pdf-fill.skill')
  // Installing the same name again needs "replace".
  await assert.rejects(s.ops.install({ id: review.id, path: sk.path, name: 'pdf-fill' }), /already there/)
  await s.ops.install({ id: review.id, path: sk.path, name: 'pdf-fill', replace: true })
  await s.ops.reviewDiscard({ id: review.id })
  await assert.rejects(s.ops.reviewGet({ id: review.id }), /expired/)
  await s.ops.remove({ name: 'pdf-fill' })
  assert.equal(existsSync(dest), false)
})

test('uploads: traversal, links and oversize archives are refused, and nothing is left behind', async () => {
  const reviews = join(HOME, '.cache', 'devdash', 'skill-review')
  const before = existsSync(reviews) ? readdirSync(reviews).length : 0
  await assert.rejects(upload(makeZip([{ name: 'a/SKILL.md', data: md('a') }, { name: '../../escape.txt', data: 'x' }])), /unsafe paths/)
  await assert.rejects(upload(makeZip([{ name: 'a/SKILL.md', data: md('a') }, { name: 'a/passwd', data: '/etc/passwd', mode: 0o120777 }])), /links/)
  await assert.rejects(upload(makeZip([{ name: 'a/SKILL.md', data: md('a') }, { name: 'a/big', data: 'x', size: s.LIMITS.total + 10 }])), /more than/)
  await assert.rejects(s.ops.reviewUpload({ data: Buffer.alloc(s.LIMITS.archive + 1).toString('base64'), fileName: 'x.zip' }), /at most/)
  await assert.rejects(upload(makeZip([{ name: 'a/readme.md', data: 'no skill here' }])), /no SKILL.md/)
  await assert.rejects(upload(Buffer.from('not a zip')), /not a .zip/)
  await assert.rejects(upload(makeZip([{ name: 'a/SKILL.md', data: md('a') }]), 'x.tar.gz'), /\.zip or \.skill/)
  assert.equal(existsSync(join(base, 'escape.txt')) || existsSync(join(HOME, 'escape.txt')), false)
  assert.equal(existsSync(reviews) ? readdirSync(reviews).filter((n) => !n.startsWith('.')).length : 0, before)
})

test('my skills reach every Claude profile through links, and turning one off takes them away', async () => {
  mkdirSync(join(HOME, '.claude-profiles', 'work', 'skills', 'own-skill'), { recursive: true })
  writeFileSync(join(HOME, '.claude-profiles', 'work', 'skills', 'own-skill', 'SKILL.md'), md('own-skill'))
  await s.ops.write({ name: 'greet', description: 'Greets. Use when saying hi.', body: 'Say hi.' })
  const link = join(HOME, '.claude-profiles', 'work', 'skills', 'greet')
  assert.equal(lstatSync(link).isSymbolicLink(), true)
  assert.equal(readlinkSync(link), join(HOME, '.claude', 'skills', 'greet'))
  const list = await s.ops.list({})
  assert.deepEqual(list.skills.map((x) => [x.name, x.enabled]), [['greet', true]])
  assert.equal(list.skills[0]!.source?.kind, 'written')

  await s.ops.enable({ name: 'greet', enabled: false })
  assert.equal(existsSync(join(HOME, '.claude', 'skills', 'greet')), false)
  assert.equal(existsSync(join(HOME, '.local', 'share', 'devdash', 'skills-off', 'greet', 'SKILL.md')), true)
  assert.equal(existsSync(link) || (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() ?? false), false)
  assert.equal((await s.ops.list({})).skills[0]!.enabled, false)
  await assert.rejects(s.ops.write({ name: 'greet', description: 'x', body: 'y' }), /already there/)

  await s.ops.enable({ name: 'greet', enabled: true })
  assert.equal(lstatSync(link).isSymbolicLink(), true)
  await s.ops.remove({ name: 'greet' })
  assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined)
  // The profile's own skill was never touched.
  assert.equal(existsSync(join(HOME, '.claude-profiles', 'work', 'skills', 'own-skill', 'SKILL.md')), true)
  await assert.rejects(s.ops.write({ name: 'Bad_Name', description: 'x', body: 'y' }), /lowercase/)
  await assert.rejects(s.ops.remove({ name: '../etc' }), /invalid/)
})

test('a project skill is committed on its own: other changes in the checkout stay uncommitted', async () => {
  const project = join(base, 'srv', 'projects', 'demo')
  mkdirSync(project, { recursive: true })
  const git = (...a: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=T', '-c', 'user.email=t@x', ...a], { encoding: 'utf8' }).replace(/\n+$/, '')
  git('init', '-q', '-b', 'main')
  writeFileSync(join(project, 'app.js'), 'one\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  git('config', 'user.email', 't@x')
  git('config', 'user.name', 'T')
  // Someone's work in progress: one file staged, one changed, one new.
  writeFileSync(join(project, 'app.js'), 'two\n')
  writeFileSync(join(project, 'staged.js'), 'staged\n')
  git('add', 'staged.js')
  writeFileSync(join(project, 'new.txt'), 'new\n')

  const r = await s.ops.write({ scope: 'project', project, name: 'deploy-notes', description: 'How we deploy. Use when deploying.', body: 'Steps.' })
  assert.ok(r.commit?.sha)
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['.claude/skills/deploy-notes/.devdash-source.json', '.claude/skills/deploy-notes/SKILL.md'])
  assert.equal(git('log', '-1', '--format=%s'), 'Add skill deploy-notes')
  const status = git('status', '--porcelain').split('\n').sort()
  assert.deepEqual(status, [' M app.js', '?? new.txt', 'A  staged.js'])
  assert.deepEqual((await s.ops.list({ project })).skills.map((x) => x.name), ['deploy-notes'])

  await s.ops.remove({ scope: 'project', project, name: 'deploy-notes' })
  assert.equal(git('log', '-1', '--format=%s'), 'Remove skill deploy-notes')
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['.claude/skills/deploy-notes/.devdash-source.json', '.claude/skills/deploy-notes/SKILL.md'])
  assert.deepEqual(git('status', '--porcelain').split('\n').sort(), [' M app.js', '?? new.txt', 'A  staged.js'])
  // Only real project checkouts.
  await assert.rejects(s.ops.list({ project: '/etc' }), /not a DevDash project/)
  await assert.rejects(s.ops.list({ project: `${project}/../demo` }), /not a DevDash project/)
})
