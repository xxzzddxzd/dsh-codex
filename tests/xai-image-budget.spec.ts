import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {crc32, deflateSync, zstdDecompressSync} from 'node:zlib'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Context} from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import type {ImageAttachmentRef} from '@deepseek-ai/dsh-attachment'
import type {GenerateOptions, LlmAdapter, LlmError, RequestUserInput, StreamChunk} from '@deepseek-ai/dsh-llm'
import {ReasoningEffortId} from '@deepseek-ai/dsh-llm'
import {createOpenAICodexAdapter, createXaiAdapter} from '../src/adapter.ts'
import {OpenAICodexCredentialStore, XaiCredentialStore} from '../src/store.ts'
import {OPENAI_CODEX_PROVIDER, XAI_PROVIDER} from '../src/provider-ids.ts'

/** Valid deterministic RGB noise, deliberately not a compressible solid color. */
function syntheticPng(): Buffer {
  const width = 512, height = 512
  const pixels = Buffer.alloc((width * 3 + 1) * height)
  let random = 0x13579bdf
  for (let y = 0; y < height; y++) for (let x = 1; x <= width * 3; x++) {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5
    pixels[y * (width * 3 + 1) + x] = random & 255
  }
  const chunk = (type: string, bytes: Buffer): Buffer => {
    const header = Buffer.alloc(8); header.writeUInt32BE(bytes.length); header.write(type, 4)
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), bytes])))
    return Buffer.concat([header, bytes, checksum])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels, {level: 0})), chunk('IEND', Buffer.alloc(0))])
}

function completedResponse(model: string): Response {
  const item = {type: 'message', id: 'msg_image_fixture', status: 'completed', role: 'assistant',
    content: [{type: 'output_text', text: 'OK', annotations: []}]}
  const events = [
    {type: 'response.created', response: {id: 'resp_image_fixture', status: 'in_progress'}},
    {type: 'response.output_item.added', output_index: 0, item: {...item, status: 'in_progress', content: []}},
    {type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK'},
    {type: 'response.output_item.done', output_index: 0, item},
    {type: 'response.completed', response: {id: 'resp_image_fixture', status: 'completed', model, output: [item],
      usage: {input_tokens: 1, output_tokens: 1, input_tokens_details: {cached_tokens: 0}, output_tokens_details: {reasoning_tokens: 0}}}},
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {headers: {'content-type': 'text/event-stream'}})
}

function imageUrls(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return out
  if ('type' in value && value.type === 'input_image' && 'image_url' in value && typeof value.image_url === 'string') out.push(value.image_url)
  for (const child of Object.values(value)) imageUrls(child, out)
  return out
}

let root: string
let ctx: Context
let ref: ImageAttachmentRef
let png: Buffer
let messages: RequestUserInput[]
const payloads: Record<string, unknown>[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-xai-image-budget-'))
  vi.stubEnv('DSH_HOME', root)
  ctx = new Context(); await ctx.plugin(LocalAttachmentStore, {dshHome: root})
  png = syntheticPng()
  ref = await ctx.attachments.saveImage({data: png, mediaType: 'image/png', name: 'synthetic-noise.png'})
  messages = Array.from({length: 14}, (_, index) => ({role: 'user', content: [
    {type: 'text', text: `Synthetic image occurrence ${index}`}, {type: 'image', attachment: ref},
  ]}))
  payloads.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (!['api.x.ai', 'chatgpt.com'].includes(new URL(request.url).hostname)) throw new Error('Unexpected fixture target')
    const encoded = Buffer.from(await request.arrayBuffer())
    const text = request.headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(encoded).toString('utf8') : encoded.toString('utf8')
    const payload = JSON.parse(text) as Record<string, unknown>; payloads.push(payload)
    return completedResponse(String(payload.model))
  }))
})
afterEach(async () => {
  await ctx?.fiber.dispose(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
  if (root) await rm(root, {recursive: true, force: true})
})

async function consume(adapter: LlmAdapter, provider: string, model: string, history: RequestUserInput[]): Promise<StreamChunk[]> {
  const options: GenerateOptions = {provider, model, messages: history, tools: [], reasoningEffort: ReasoningEffortId('low'),
    maxTokens: 32, signal: AbortSignal.timeout(5000)}
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

describe('xAI request image budget through the real adapter and local attachment store', () => {
  it('signals oldest-image offload before transport, then streams the projected history without changing originals', async () => {
    const credentials = new XaiCredentialStore(join(root, '.xai-auth.json'))
    await credentials.modify(XAI_PROVIDER, async () => ({type: 'oauth', access: 'fixture-xai-access',
      refresh: 'fixture-xai-refresh', expires: Date.now() + 3_600_000}))
    const adapter = createXaiAdapter(credentials, () => ctx.attachments)
    const version = await ctx.attachments.readImageRequest(ref, {width: 512, height: 512, maxBytes: 1024 * 1024})
    const represented = Math.ceil(version.bytes / 3) * 4 * 14
    expect(represented).toBeGreaterThan(8 * 1024 * 1024)
    expect(represented).toBeLessThan(20 * 1024 * 1024)
    let failure: LlmError | undefined
    try { await consume(adapter, XAI_PROVIDER, 'grok-4.6', messages) } catch (error) { failure = error as LlmError }
    expect(failure).toMatchObject({code: 'IMAGE_OFFLOAD_REQUIRED', failure: {offloadImages: 7}})
    expect(fetch).not.toHaveBeenCalled()
    const count = failure!.failure.offloadImages!
    const projected: RequestUserInput[] = messages.map((message, index) => index >= count ? message : {
      ...message, content: message.content.map(block => block.type === 'image' ? {...block, offloaded: true} : block),
    })
    const chunks = await consume(adapter, XAI_PROVIDER, 'grok-4.6', projected)
    expect(chunks.at(-1)).toMatchObject({type: 'finish', reason: {kind: 'stop'}})
    expect(payloads).toHaveLength(1)
    expect(imageUrls(payloads[0])).toHaveLength(7)
    expect(imageUrls(payloads[0]).reduce((sum, url) => sum + url.split(',')[1]!.length, 0)).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(JSON.stringify(payloads[0]).match(/image omitted to fit request image limits/gu)).toHaveLength(7)
    expect(messages.every(message => message.content.every(block => block.type !== 'image' || block.offloaded === undefined))).toBe(true)
    expect(projected.every(message => message.content.every(block => block.type !== 'image' || block.attachment === ref))).toBe(true)
    expect(Buffer.from((await ctx.attachments.readImage(ref)).data)).toEqual(png)
  })

  it('keeps the Codex 20 MiB budget and transmits all fourteen same-sized image occurrences', async () => {
    const credentials = new OpenAICodexCredentialStore(join(root, '.openai-codex-auth.json'))
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const access = `${encode({alg: 'none'})}.${encode({'https://api.openai.com/auth': {chatgpt_account_id: 'fixture-account'}})}.signature`
    await credentials.modify(OPENAI_CODEX_PROVIDER, async () => ({type: 'oauth', access, refresh: 'fixture-codex-refresh',
      expires: Date.now() + 3_600_000, accountId: 'fixture-account'}))
    const adapter = createOpenAICodexAdapter(credentials, () => ctx.attachments,
      () => ({useNativeCompaction: false, useWebSocketContextReuse: false}))
    const chunks = await consume(adapter, OPENAI_CODEX_PROVIDER, 'gpt-6.1-sol', messages)
    expect(chunks.at(-1)).toMatchObject({type: 'finish', reason: {kind: 'stop'}})
    expect(payloads).toHaveLength(1)
    expect(imageUrls(payloads[0])).toHaveLength(14)
    expect(Buffer.from((await ctx.attachments.readImage(ref)).data)).toEqual(png)
  })
})
