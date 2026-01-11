import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { applyOperators } from '../core/operators.mjs'

test('Seal: writes seal.json manifest when distDir exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xandria-seal-'))
  const dist = path.join(tmp, 'dist')
  fs.mkdirSync(dist, { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>')

  const hits = applyOperators('OP-72 Seal', { intent: 'test', distDir: dist })
  assert.ok(hits.includes(72))
  const sealPath = path.join(dist, 'seal.json')
  assert.ok(fs.existsSync(sealPath), 'seal.json should exist')
  const seal = JSON.parse(fs.readFileSync(sealPath, 'utf8'))
  assert.ok(Array.isArray(seal.manifest))
  assert.ok(seal.fileCount >= 1)
})
