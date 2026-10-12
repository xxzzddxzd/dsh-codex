/** Durable provider preferences over the current Harness storage-domain API. */
import type { Context } from '@deepseek-ai/cordis'
import type Schema from '@deepseek-ai/schemastery'
import merge from 'deepmerge'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'
import type { ZodType } from 'zod'

const mergeOptions = { arrayMerge: (_previous: unknown[], next: unknown[]) => next }

/** Import a retired namespace before or after the Host renames the legacy settings document. */
async function legacyPreferences(namespace: string): Promise<object> {
  for (const filename of ['settings.yaml', 'settings.yaml.imported']) {
    let text: string
    try {
      text = await readFile(join(resolveDshHome(), filename), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const document = yaml.load(text)
    if (document === null || typeof document !== 'object' || Array.isArray(document)) continue
    const value = (document as Record<string, unknown>)[namespace]
    if (value === undefined) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid legacy provider preferences: ${namespace}`)
    }
    return value
  }
  return {}
}

/** A validated namespace whose writes commit before notifying live consumers. */
export class ProviderPreferencesScope<T extends object> {
  private constructor(
    private readonly ctx: Context,
    private readonly name: string,
    private readonly table: KvTable<string, T>,
    private readonly schema: Schema<T>,
  ) {}

  static async open<T extends object>(ctx: Context, namespace: string, schema: Schema<T>, base: T) {
    // Schemastery resolves synchronously; zod's Awaited<T> transform type also permits async parsers.
    const valueSchema = z.unknown().transform(value => schema(value as T)) as ZodType<T>
    const spec = defineDomain({
      name: `dsh_codex_${namespace.replaceAll('-', '_')}`,
      version: 1,
      tables: { preferences: domainTable(valueSchema) },
    })
    const domain = await ctx.storage.domain.open(spec)
    ctx.effect(() => () => domain.close(), `dsh-codex: ${namespace} preferences`)
    const table = domain.table('preferences')
    if (table.get('current') === undefined) {
      await table.put('current', schema(merge<T>(base, await legacyPreferences(namespace), mergeOptions)))
    }
    return new ProviderPreferencesScope(ctx, spec.name, table, schema)
  }

  get(): T {
    const value = this.table.get('current')
    if (value === undefined) throw new Error(`Missing provider preferences: ${this.name}`)
    return value
  }

  async update(patch: Partial<T>): Promise<void> {
    await this.table.update('current', current => this.schema(merge<T>(current, patch, mergeOptions)))
  }

  watch(listener: (value: T) => void): () => void {
    return this.ctx.on('domain/changed', change => {
      if (change.domain === this.name && change.table === 'preferences' && change.key === 'current') {
        listener(this.get())
      }
    })
  }
}
