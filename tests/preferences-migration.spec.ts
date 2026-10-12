import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImageToolPolicy } from '../src/tool-policy.ts'
import { preferenceContext } from './preference-context.ts'

let root: string | undefined
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('provider preferences migration', () => {
  it.each(['settings.yaml', 'settings.yaml.imported'])('imports %s once and preserves committed edits across restart', async filename => {
    root = await mkdtemp(join(tmpdir(), 'dsh-preferences-migration-'))
    vi.stubEnv('DSH_HOME', root)
    const original = 'openai-codex:\n  useVless: true\n  modifyReadImage: false\nunrelated:\n  keep: true\n'
    await writeFile(join(root, filename), original)
    ctx = await preferenceContext(root)
    const policy = new ImageToolPolicy()
    await policy.attach(ctx)
    expect(policy.vlessSnapshot()).toEqual({ useVless: true })
    expect(policy.snapshot().modifyReadImage).toBe(false)
    await Promise.all([policy.update({ modifyReadImage: true }), policy.updateResponseApi({ useNativeCompaction: true })])
    expect(await readFile(join(root, filename), 'utf8')).toBe(original)
    await ctx.fiber.dispose()
    ctx = await preferenceContext(root)
    const restored = new ImageToolPolicy()
    await restored.attach(ctx)
    expect(restored.snapshot().modifyReadImage).toBe(true)
    expect(restored.responseApiSnapshot().useNativeCompaction).toBe(true)
    expect(restored.vlessSnapshot().useVless).toBe(true)
  })

  it('refuses invalid legacy values while leaving the original settings untouched', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-preferences-invalid-'))
    vi.stubEnv('DSH_HOME', root)
    const original = 'openai-codex:\n  useVless: invalid\n'
    await writeFile(join(root, 'settings.yaml'), original)
    ctx = await preferenceContext(root)
    await expect(new ImageToolPolicy().attach(ctx)).rejects.toThrow()
    expect(await readFile(join(root, 'settings.yaml'), 'utf8')).toBe(original)
  })
})
