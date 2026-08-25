/** Device-local Xray lifecycle and private VLESS configuration management. */

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { connect } from 'node:net'
import { ProxyAgent, request } from 'undici'
import {
  createFailClosedXrayConfig,
  createXrayConfig,
  parseVlessRealityUri,
  publicNodeSummary,
} from './vless.ts'

export interface VlessControllerOptions {
  xrayPath?: string
  configPath?: string
  summaryPath?: string
  launchdPlistPath?: string
  launchdService?: string
  proxyUrl?: string
  proxyPort?: number
}

export interface VlessStatus {
  configured: boolean
  running: boolean
  reachable: boolean
  pid?: number
  node?: string
  message?: string
}

interface ResolvedOptions {
  xrayPath: string
  configPath: string
  summaryPath: string
  launchdPlistPath: string
  launchdService: string
  proxyUrl: string
  proxyPort: number
}

const DEFAULTS: ResolvedOptions = {
  xrayPath: '/var/jb/usr/local/lib/dsh-vless/xray',
  configPath: '/var/root/.config/dsh-vless/config.json',
  summaryPath: '/var/root/.config/dsh-vless/node-summary.json',
  launchdPlistPath: '/var/jb/Library/LaunchDaemons/ai.deepseek.dsh-vless.plist',
  launchdService: 'user/foreground/ai.deepseek.dsh-vless',
  proxyUrl: 'http://127.0.0.1:18080',
  proxyPort: 18080,
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function run(file: string, args: string[], timeout = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 1024 * 1024 }, error => {
      if (error === null) resolve()
      else reject(error)
    })
  })
}

function runCapture(file: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error === null) resolve(stdout)
      else reject(error)
    })
  })
}

/** Extract the live process id from launchctl's stable service description. */
export function parseLaunchdPid(output: string): number | undefined {
  const match = /(?:^|\s)pid\s*=\s*(\d+)(?:\s|$)/mu.exec(output)
  if (match?.[1] === undefined) return undefined
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function removeOptional(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error: unknown) {
    if (!isMissing(error)) throw error
  }
}

async function atomicPrivateWrite(path: string, data: string | Buffer): Promise<void> {
  const temporary = join(dirname(path), `.${path.split('/').at(-1) ?? 'file'}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(temporary, data, { mode: 0o600 })
  await chmod(temporary, 0o600)
  try {
    await rename(temporary, path)
  } catch (error: unknown) {
    await removeOptional(temporary)
    throw error
  }
}

function tcpReachable(port: number, timeout = 1_000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (value: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => { finish(true) })
    socket.once('timeout', () => { finish(false) })
    socket.once('error', () => { finish(false) })
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, milliseconds) })
}

/** Own the local client without ever exposing its credential-bearing config. */
export class VlessController {
  private readonly options: ResolvedOptions
  private configuring = false

  constructor(options: VlessControllerOptions = {}) {
    this.options = { ...DEFAULTS, ...options }
  }

  /** Read a secret-free status snapshot for the Web UI. */
  async status(): Promise<VlessStatus> {
    const configured = await this.isConfigured()
    const pid = await this.servicePid()
    const running = pid !== undefined
    const reachable = await tcpReachable(this.options.proxyPort)
    const node = configured ? await this.readSummary() : undefined
    return {
      configured,
      running,
      reachable,
      ...(pid === undefined ? {} : { pid }),
      ...(node === undefined ? {} : { node }),
      ...(!configured
        ? { message: 'No VLESS node is configured.' }
        : !reachable ? { message: 'The local VLESS client is not reachable.' } : {}),
    }
  }

  /** Validate, install, restart, and live-test a node; restore the old node on failure. */
  async configure(uri: string): Promise<VlessStatus> {
    if (this.configuring) throw new Error('A VLESS configuration update is already in progress')
    this.configuring = true
    try {
      const node = parseVlessRealityUri(uri)
      const config = createXrayConfig(node, this.options.proxyPort)
      await access(this.options.xrayPath, constants.X_OK)
      await mkdir(dirname(this.options.configPath), { recursive: true, mode: 0o700 })
      await chmod(dirname(this.options.configPath), 0o700)

      const candidate = join(dirname(this.options.configPath), `.config.${process.pid}.${Date.now()}.json`)
      await writeFile(candidate, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
      try {
        await run(this.options.xrayPath, ['run', '-test', '-config', candidate])
      } finally {
        await removeOptional(candidate)
      }

      const oldConfig = await readOptional(this.options.configPath)
      const oldSummary = await readOptional(this.options.summaryPath)
      await atomicPrivateWrite(this.options.configPath, `${JSON.stringify(config, null, 2)}\n`)
      await atomicPrivateWrite(this.options.summaryPath, `${JSON.stringify({ node: publicNodeSummary(node) })}\n`)
      try {
        await this.restart()
        await this.waitForProxy()
        await this.probeExit()
      } catch {
        await atomicPrivateWrite(
          this.options.configPath,
          oldConfig ?? `${JSON.stringify(createFailClosedXrayConfig(this.options.proxyPort), null, 2)}\n`,
        )
        if (oldSummary === undefined) await removeOptional(this.options.summaryPath)
        else await atomicPrivateWrite(this.options.summaryPath, oldSummary)
        await this.restart().catch(() => undefined)
        throw new Error('VLESS node connectivity test failed; the previous configuration was restored')
      }
      return this.status()
    } finally {
      this.configuring = false
    }
  }

  /** Require a configured client and prove a generic HTTPS tunnel before enabling. */
  async ensureReady(): Promise<void> {
    if (!await this.isConfigured()) throw new Error('Save and test a VLESS node before enabling it')
    if (!await tcpReachable(this.options.proxyPort)) {
      await this.restart()
      await this.waitForProxy()
    }
    await this.probeExit()
  }

  private async isConfigured(): Promise<boolean> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.configPath, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || !('outbounds' in parsed) || !Array.isArray(parsed.outbounds)) return false
      const first = parsed.outbounds[0]
      return typeof first === 'object' && first !== null && 'protocol' in first && first.protocol === 'vless'
    } catch {
      return false
    }
  }

  private async readSummary(): Promise<string | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.summaryPath, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || !('node' in parsed) || typeof parsed.node !== 'string') return undefined
      return parsed.node.slice(0, 160)
    } catch {
      return undefined
    }
  }

  private async servicePid(): Promise<number | undefined> {
    try {
      return parseLaunchdPid(await runCapture('/var/jb/bin/launchctl', ['print', this.options.launchdService], 3_000))
    } catch {
      return undefined
    }
  }

  private async restart(): Promise<void> {
    try {
      await run('/var/jb/bin/launchctl', ['kickstart', '-k', this.options.launchdService], 10_000)
    } catch {
      await run('/var/jb/bin/launchctl', ['bootstrap', 'system', this.options.launchdPlistPath], 10_000).catch(() => undefined)
      await run('/var/jb/bin/launchctl', ['kickstart', '-k', this.options.launchdService], 10_000)
    }
  }

  private async waitForProxy(): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await tcpReachable(this.options.proxyPort, 250)) return
      await delay(200)
    }
    throw new Error('The local VLESS client did not start')
  }

  private async probeExit(): Promise<number> {
    const proxy = new ProxyAgent(this.options.proxyUrl)
    const startedAt = performance.now()
    try {
      const response = await request('https://www.gstatic.com/generate_204', {
        method: 'GET',
        dispatcher: proxy,
        signal: AbortSignal.timeout(15_000),
        headers: { 'user-agent': 'dsh-provider-vless-check' },
      })
      await response.body.dump()
      return Math.max(1, Math.round(performance.now() - startedAt))
    } finally {
      await proxy.close().catch(() => undefined)
    }
  }
}
