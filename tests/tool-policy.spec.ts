import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { preferenceContext } from './preference-context.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImageToolPolicy } from '../src/tool-policy.ts'
import { OPENAI_CODEX_PROVIDER, XAI_PROVIDER } from '../src/provider-ids.ts'


let context: Context | undefined
let directory: string | undefined
async function setup() {
  directory = await mkdtemp(join(tmpdir(), 'dsh-tool-preferences-'))
  vi.stubEnv('DSH_HOME', directory)
  context = await preferenceContext(directory)
  return context
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
  vi.unstubAllEnvs()
})

describe('ImageToolPolicy', () => {
  it('persists independent live toggles through the dsh settings seam', async () => {
    const ctx = await setup()
    const policy = new ImageToolPolicy()
    await policy.attach(ctx)

    expect(policy.snapshot()).toEqual({
      modifyReadImage: true,
      shareImagegenWithOtherModels: true,
    })
    expect(policy.responseApiSnapshot()).toEqual({
      useWebSocketContextReuse: false,
      useNativeCompaction: false,
    })
    expect(policy.vlessSnapshot()).toEqual({ useVless: false })
    expect(policy.xaiImageSnapshot()).toEqual({ model: 'grok-imagine-image-2.0' })

    await policy.update({ shareImagegenWithOtherModels: false })
    await policy.updateResponseApi({ useNativeCompaction: true })
    await policy.updateVless(true)
    await policy.updateXaiImageModel('grok-imagine-image-quality')

    expect(policy.snapshot()).toEqual({
      modifyReadImage: true,
      shareImagegenWithOtherModels: false,
    })
    expect(policy.responseApiSnapshot()).toEqual({
      useWebSocketContextReuse: false,
      useNativeCompaction: true,
    })
    expect(policy.vlessSnapshot()).toEqual({ useVless: true })
    expect(policy.xaiImageSnapshot()).toEqual({ model: 'grok-imagine-image-quality' })
  })

  it('notifies the read_image enhancer when its live setting changes', async () => {
    const ctx = await setup()
    const policy = new ImageToolPolicy({
      modifyReadImage: true,
      shareImagegenWithOtherModels: false,
    })
    await policy.attach(ctx)
    let changes = 0
    policy.watchImagePreferences(() => { changes++ })

    await policy.update({ modifyReadImage: false })

    expect(policy.snapshot().modifyReadImage).toBe(false)
    expect(changes).toBe(1)
  })

  it('migrates the retired store:true preference to WebSocket context reuse', () => {
    const policy = new ImageToolPolicy({ useStatefulResponses: true })

    expect(policy.responseApiSnapshot()).toEqual({
      useWebSocketContextReuse: true,
      useNativeCompaction: false,
    })
  })

  it('keeps Codex imagegen access while applying its toggle to another provider', () => {
    const policy = new ImageToolPolicy({ shareImagegenWithOtherModels: false })
    const execution = (provider: string) => ({
      agent: {
        options: {},
        session: { requestHeader: () => ({ config: { provider, model: 'vision-model' } }) },
      },
    }) as never

    expect(() => policy.assertAllowed(execution(OPENAI_CODEX_PROVIDER), 'imagegen')).not.toThrow()
    expect(() => policy.assertAllowed(execution(XAI_PROVIDER), 'imagegen')).not.toThrow()
    expect(() => policy.assertAllowed(execution('another-provider'), 'imagegen')).toThrow('disabled for models outside')
  })
})
