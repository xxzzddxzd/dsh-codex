/** ChatGPT Codex image generation and reference-image editing. */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { createModels } from '@earendil-works/pi-ai'
import type { Models } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { OpenAICodexCredentialStore, XaiCredentialStore } from './store.ts'
import { OPENAI_CODEX_PROVIDER, XAI_PROVIDER } from './store.ts'
import { OPENAI_CODEX_BASE_URL } from './search.ts'
import { writeWorkspaceBytes } from './binary-fs.ts'
import { assertImageCapable } from './image-capability.ts'
import { imageMediaType } from './read-image-enhancement.ts'
import type { ImageToolPolicy } from './tool-policy.ts'
import type { XaiImageModel } from './xai-images.ts'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'

/** Stable Codex-compatible tool name. */
export const IMAGEGEN_TOOL_NAME = 'imagegen'
/** Image model selected by the official Codex image extension. */
export const OPENAI_CODEX_IMAGE_MODEL = 'gpt-image-2'
/** Standalone generation endpoint used by the official Codex client. */
export const OPENAI_CODEX_IMAGE_GENERATIONS_URL = `${OPENAI_CODEX_BASE_URL}/images/generations`
/** Reference-image edit endpoint used by the official Codex client. */
export const OPENAI_CODEX_IMAGE_EDITS_URL = `${OPENAI_CODEX_BASE_URL}/images/edits`
/** xAI's provider-native image endpoints, authenticated by the same xAI OAuth account. */
export const XAI_IMAGE_GENERATIONS_URL = 'https://api.x.ai/v1/images/generations'
export const XAI_IMAGE_EDITS_URL = 'https://api.x.ai/v1/images/edits'

const MAX_REFERENCE_IMAGES = 5
const MAX_XAI_REFERENCE_IMAGES = 3

function defaultOutputPath(extension: 'png' | 'jpg' | 'webp' | 'gif', now = new Date(), id = randomUUID()): string {
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/u, 'Z').replaceAll(':', '-')
  return `generated-${timestamp}-${id.slice(0, 8)}.${extension}`
}

interface ImagegenArgs {
  prompt: string
  referenced_image_paths?: string[]
  num_last_images_to_include?: number
  output_path?: string
}

interface ImagegenValue {
  prompt: string
  image: {
    attachmentId: string
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
  }
  file?: {
    path: string
    operation: 'create' | 'update'
  }
  writeError?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function accountIdFromToken(access: string): string {
  try {
    const parts = access.split('.')
    if (parts.length !== 3 || parts[1] === undefined) throw new Error('invalid JWT')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    const auth = payload['https://api.openai.com/auth']
    if (!isRecord(auth)) throw new Error('missing auth claim')
    const accountId = auth['chatgpt_account_id']
    if (typeof accountId !== 'string' || accountId.length === 0) throw new Error('missing account id')
    return accountId
  } catch (error: unknown) {
    throw new Error('OpenAI Codex image credential has no usable account id; run "dsh openai-codex login" again', { cause: error })
  }
}

function providerMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const error = value['error']
  const raw = typeof error === 'string'
    ? error
    : isRecord(error) && typeof error['message'] === 'string'
      ? error['message']
      : typeof value['message'] === 'string' ? value['message'] : undefined
  return raw?.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[REDACTED]').slice(0, 1000)
}

function imageBytes(payload: unknown, provider: string): Uint8Array {
  if (!isRecord(payload) || !Array.isArray(payload['data'])) {
    throw new Error(`${provider} returned an image response without data`)
  }
  const first = payload['data'][0]
  if (!isRecord(first) || typeof first['b64_json'] !== 'string' || first['b64_json'].length === 0) {
    throw new Error(`${provider} returned an image response without base64 image data`)
  }
  const encoded = first['b64_json'].trim()
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new Error(`${provider} returned malformed base64 image data`)
  }
  return Buffer.from(encoded, 'base64')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** OAuth-backed client for the two fixed ChatGPT Codex image endpoints. */
export class OpenAICodexImageClient {
  private readonly models: Models

  /** @param credentials - shared refreshable OAuth store. */
  constructor(credentials: OpenAICodexCredentialStore) {
    const models = createModels({ credentials })
    models.setProvider(openaiCodexProvider())
    this.models = models
  }

  /** Send one generation or edit request and return the first PNG payload. */
  async generate(
    prompt: string,
    images: readonly string[],
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    throwIfAborted(signal)
    const auth = await abortable(this.models.getAuth(OPENAI_CODEX_PROVIDER), signal)
    const access = auth?.auth.apiKey
    if (access === undefined || access.length === 0) {
      throw new Error('OpenAI Codex image generation is signed out; run "dsh openai-codex login"')
    }
    const endpoint = images.length === 0
      ? OPENAI_CODEX_IMAGE_GENERATIONS_URL
      : OPENAI_CODEX_IMAGE_EDITS_URL
    const body = {
      ...images.length === 0 ? {} : { images: images.map(image_url => ({ image_url })) },
      prompt,
      background: 'auto',
      model: OPENAI_CODEX_IMAGE_MODEL,
      quality: 'auto',
      size: 'auto',
    }
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${access}`,
          'chatgpt-account-id': accountIdFromToken(access),
          'content-type': 'application/json',
          accept: 'application/json',
          originator: 'deepseek-harness',
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error: unknown) {
      throwIfAborted(signal)
      throw new Error('OpenAI Codex image request failed', { cause: error })
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error: unknown) {
      throw new Error(`OpenAI Codex returned an unprocessable image response (HTTP ${response.status})`, { cause: error })
    }
    if (!response.ok) {
      const detail = providerMessage(payload)
      const message = detail === undefined
        ? `OpenAI Codex image request failed (HTTP ${response.status})`
        : `OpenAI Codex image request failed (HTTP ${response.status}): ${detail}`
      throw new Error(response.status === 401 || response.status === 403
        ? `${message}; run "dsh openai-codex login" again`
        : message)
    }
    return imageBytes(payload, 'OpenAI Codex')
  }
}

/** OAuth-backed xAI Imagine client using the image models pinned by pi-ai. */
export class XaiImageClient {
  private readonly models: Models

  constructor(
    credentials: XaiCredentialStore,
    private readonly selectedModel: () => XaiImageModel,
  ) {
    const models = createModels({ credentials })
    models.setProvider(xaiProvider())
    this.models = models
  }

  async generate(prompt: string, images: readonly string[], signal: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal)
    if (images.length > MAX_XAI_REFERENCE_IMAGES) {
      throw new Error(`xAI image editing accepts at most ${MAX_XAI_REFERENCE_IMAGES} reference images`)
    }
    const auth = await abortable(this.models.getAuth(XAI_PROVIDER), signal)
    const access = auth?.auth.apiKey
    if (access === undefined || access.length === 0) {
      throw new Error('xAI image generation is signed out; sign in under Settings → Provider → xAI')
    }
    const endpoint = images.length === 0 ? XAI_IMAGE_GENERATIONS_URL : XAI_IMAGE_EDITS_URL
    const references = images.length === 0
      ? {}
      : images.length === 1
        ? { image: { type: 'image_url', url: images[0] } }
        : { images: images.map(url => ({ type: 'image_url', url })) }
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${access}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model: this.selectedModel(),
          prompt,
          ...references,
          response_format: 'b64_json',
        }),
        signal,
      })
    } catch (error: unknown) {
      throwIfAborted(signal)
      throw new Error('xAI image request failed', { cause: error })
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error: unknown) {
      throw new Error(`xAI returned an unprocessable image response (HTTP ${response.status})`, { cause: error })
    }
    if (!response.ok) {
      const detail = providerMessage(payload)
      const message = detail === undefined
        ? `xAI image request failed (HTTP ${response.status})`
        : `xAI image request failed (HTTP ${response.status}): ${detail}`
      throw new Error(response.status === 401 || response.status === 403
        ? `${message}; sign in again under Settings → Provider → xAI`
        : message)
    }
    return imageBytes(payload, 'xAI')
  }
}

function fileExtension(mediaType: ImageMediaType): 'png' | 'jpg' | 'webp' | 'gif' {
  switch (mediaType) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
  }
}

function attachmentRef(value: ImagegenValue['image']): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(value.attachmentId),
    mediaType: value.mediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    ...value.name === undefined ? {} : { name: value.name },
  }
}

function contentOf(value: ImagegenValue): ContentBlock[] {
  const file = value.file === undefined
    ? value.writeError === undefined ? '' : `\n<output_error>${value.writeError}</output_error>`
    : `\n<output_path operation="${value.file.operation}">${value.file.path}</output_path>`
  return [
    {
      type: 'text',
      text: `<image>${value.image.mediaType}, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes</image>${file}`,
    },
    { type: 'image', attachment: attachmentRef(value.image) },
  ]
}

function collectImageRefs(content: readonly ContentBlock[], output: ImageAttachmentRef[]): void {
  for (const block of content) {
    if (block.type === 'image') output.push(block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, output)
  }
}

function recentImageRefs(messages: readonly Message[], count: number): ImageAttachmentRef[] {
  const refs: ImageAttachmentRef[] = []
  for (const message of messages) collectImageRefs(message.content, refs)
  return refs.slice(-count)
}

async function conversationImages(ctx: Context, exec: ToolExecution, count: number): Promise<string[]> {
  const session = exec.agent?.session
  if (session === undefined) throw new Error('conversation image references are unavailable outside an agent session')
  const refs = recentImageRefs(session.deriveMessages(), count)
  if (refs.length !== count) {
    throw new Error(`requested the last ${count} conversation images, but only ${refs.length} were available`)
  }
  return Promise.all(refs.map(async ref => {
    const stored = await ctx.attachments.readImage(ref, exec.signal)
    return `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
  }))
}

async function workspaceImages(ctx: Context, exec: ToolExecution, paths: readonly string[]): Promise<string[]> {
  const cwd = exec.agent?.session.header.cwd
  const maxBytes = Math.min(ctx.attachments.imageLimits.maxImageBytes, ctx.attachments.imageLimits.maxMessageImageBytes)
  const images: string[] = []
  for (const path of paths) {
    if (path.trim().length === 0) throw new Error('referenced_image_paths must not contain an empty path')
    const target = await ctx.fs.resolve(path, { ...cwd === undefined ? {} : { cwd }, signal: exec.signal })
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined) throw new Error(`referenced image does not exist: ${path}`)
    if (info.type !== 'file') throw new Error(`referenced image is not a regular file: ${path}`)
    const data = await ctx.fs.readBytes(target, exec.signal, maxBytes)
    const mediaType = imageMediaType(data)
    if (mediaType === undefined) throw new Error(`referenced image is not PNG, JPEG, WebP, or GIF: ${path}`)
    await ctx.attachments.validateImage({ data, mediaType, name: basename(target.displayPath) })
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    images.push(`data:${mediaType};base64,${Buffer.from(data).toString('base64')}`)
  }
  return images
}

function parseArgs(args: ImagegenArgs): Required<Pick<ImagegenArgs, 'prompt'>> & Omit<ImagegenArgs, 'prompt'> {
  const prompt = args.prompt.trim()
  if (prompt.length === 0) throw new Error('imagegen prompt must not be empty')
  const paths = args.referenced_image_paths ?? []
  if (paths.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`referenced_image_paths must contain at most ${MAX_REFERENCE_IMAGES} paths`)
  }
  const count = args.num_last_images_to_include
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > MAX_REFERENCE_IMAGES)) {
    throw new Error(`num_last_images_to_include must be an integer between 1 and ${MAX_REFERENCE_IMAGES}`)
  }
  if (paths.length > 0 && count !== undefined) {
    throw new Error('provide only one of referenced_image_paths or num_last_images_to_include')
  }
  if (args.output_path !== undefined && args.output_path.trim().length === 0) {
    throw new Error('output_path must not be empty')
  }
  return {
    prompt,
    ...paths.length === 0 ? {} : { referenced_image_paths: paths },
    ...count === undefined ? {} : { num_last_images_to_include: count },
    ...args.output_path === undefined ? {} : { output_path: args.output_path },
  }
}

/** Build the plugin-owned Codex image generation and editing tool. */
export function imagegenTool(
  ctx: Context,
  credentials: OpenAICodexCredentialStore,
  xaiCredentials: XaiCredentialStore,
  policy: ImageToolPolicy,
): ToolDefinition {
  const openaiClient = new OpenAICodexImageClient(credentials)
  const xaiClient = new XaiImageClient(xaiCredentials, () => policy.xaiImageSnapshot().model)
  return defineTool({
    name: IMAGEGEN_TOOL_NAME,
    description: 'Generate or edit an image with the active provider: gpt-image-2 for OpenAI Codex, or the selected Grok Imagine model for xAI. Omit both reference fields for a new image. Use referenced_image_paths for workspace files, or num_last_images_to_include for attached, viewed, or previously generated conversation images. Never provide both. Multiple images keep chronological/path-array order; identify them as Image 1, Image 2, and so on in the prompt. The generated image is always saved in the active local or Remote SSH workspace; output_path chooses its location, otherwise a unique generated-<timestamp>-<id> name is used.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Complete generation or edit instruction. For multiple references, name each input by its Image N order.' },
      referenced_image_paths: { type: 'array', items: { type: 'string' }, description: 'Local or active-workspace image paths in Image 1..N order; up to five for Codex or three for xAI.' },
      num_last_images_to_include: { type: 'integer', description: 'Use recent conversation images in chronological order; 1–5 for Codex or 1–3 for xAI.' },
      output_path: { type: 'string', description: 'Optional active-workspace path for the generated image. Omit it to use a unique generated-<timestamp>-<id> name with the detected image extension. Existing files remain subject to filesystem write-intent policy.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true },
          image: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true, enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
          file: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              operation: { type: 'string', required: true, enum: ['create', 'update'] },
            },
          },
          writeError: { type: 'string' },
        },
      },
      render: (_args, value) => contentOf(value),
    },
    isConcurrencySafe: args => args.output_path === undefined,
    async execute(rawArgs, exec) {
      const args = parseArgs(rawArgs)
      policy.assertAllowed(exec, 'imagegen')
      await assertImageCapable(ctx, exec, 'generate an image')
      const configured = exec.agent?.session.requestHeader()?.config
      const provider = configured?.provider ?? exec.agent?.options.provider
      const useXai = provider === XAI_PROVIDER
      const referenceCount = args.referenced_image_paths?.length ?? args.num_last_images_to_include ?? 0
      if (useXai && referenceCount > MAX_XAI_REFERENCE_IMAGES) {
        throw new Error(`xAI image editing accepts at most ${MAX_XAI_REFERENCE_IMAGES} reference images`)
      }
      const images = args.referenced_image_paths !== undefined
        ? await workspaceImages(ctx, exec, args.referenced_image_paths)
        : args.num_last_images_to_include !== undefined
          ? await conversationImages(ctx, exec, args.num_last_images_to_include)
          : []
      const data = await (useXai ? xaiClient : openaiClient).generate(args.prompt, images, exec.signal)
      const mediaType = imageMediaType(data)
      if (mediaType === undefined) throw new Error(`${useXai ? 'xAI' : 'OpenAI Codex'} image response was not PNG, JPEG, WebP, or GIF`)
      const extension = fileExtension(mediaType)
      const ref = await ctx.attachments.saveImage({ data, mediaType, name: `generated.${extension}` })
      const value: ImagegenValue = {
        prompt: args.prompt,
        image: {
          attachmentId: ref.attachmentId,
          mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name === undefined ? {} : { name: ref.name },
        },
      }
      const outputPath = args.output_path ?? defaultOutputPath(extension)
      try {
        const cwd = exec.agent?.session.header.cwd
        const target = await ctx.fs.resolve(outputPath, { ...cwd === undefined ? {} : { cwd }, signal: exec.signal })
        const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
        const outcome = await writeWorkspaceBytes(ctx, exec, target, data, intent)
        ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        value.file = { path: target.displayPath, operation: outcome.operation }
      } catch (error: unknown) {
        throwIfAborted(exec.signal)
        const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1000)
        value.writeError = `generated image was not written to ${JSON.stringify(outputPath)}: ${detail}`
      }
      if (exec.parent !== undefined) {
        exec.deferContext(createUserMessage({
          content: contentOf(value),
          source: { kind: 'plugin', plugin: 'dsh-openai-codex' },
        }))
      }
      return value
    },
    presentCall: args => ({
      card: 'generic',
      title: args.output_path === undefined ? 'Generate image' : `Generate image ${args.output_path}`,
      kind: args.output_path === undefined ? 'execute' : 'edit',
      ...args.output_path === undefined ? {} : { locations: [{ path: args.output_path }] },
    }),
    presentResult: (args, result) => ({
      card: 'generic',
      title: args.output_path === undefined ? 'Generated image' : `Generated image ${args.output_path}`,
      content: result.content,
    }),
  })
}
