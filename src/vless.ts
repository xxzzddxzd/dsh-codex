/** Parsing and fail-closed Xray configuration for DSH Web VLESS settings. */

export interface VlessRealityNode {
  server: string
  port: number
  id: string
  serverName: string
  publicKey: string
  shortId: string
  fingerprint: string
  spiderX: string
  flow?: 'xtls-rprx-vision'
  label?: string
}

export interface XrayConfig {
  log: { access: string; error: string; loglevel: string }
  inbounds: Array<Record<string, unknown>>
  outbounds: Array<Record<string, unknown>>
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:.]+\]|[0-9a-f:.]+)$/iu

function invalidNode(detail: string): never {
  throw new Error(`Invalid VLESS node: ${detail}`)
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(value)) invalidNode('invalid base64url data')
  const unpadded = value.replace(/=+$/u, '')
  const padding = '='.repeat((4 - (unpadded.length % 4)) % 4)
  return Buffer.from(unpadded.replace(/-/gu, '+').replace(/_/gu, '/') + padding, 'base64')
}

function validateServer(value: string): string {
  const server = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  if (server.length === 0 || server.length > 253 || !HOST_PATTERN.test(value) || /\.\./u.test(server)) {
    invalidNode('invalid server address')
  }
  return server
}

function parseEndpoint(value: string): { server: string; port: number } {
  let endpoint: URL
  try {
    endpoint = new URL(`http://${value}`)
  } catch {
    invalidNode('invalid server endpoint')
  }
  if (endpoint.username !== '' || endpoint.password !== '' || endpoint.pathname !== '/' || endpoint.search !== '' || endpoint.hash !== '') {
    invalidNode('invalid server endpoint')
  }
  const port = Number(endpoint.port || '443')
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalidNode('port must be between 1 and 65535')
  return { server: validateServer(endpoint.hostname), port }
}

function splitVlessUri(input: string): { authority: string; params: URLSearchParams; fragment: string } {
  const trimmed = input.trim()
  if (!trimmed.toLowerCase().startsWith('vless://')) invalidNode('link must start with vless://')
  const rest = trimmed.slice('vless://'.length)
  const queryIndex = rest.indexOf('?')
  const hashIndex = rest.indexOf('#')
  const authorityEnd = [queryIndex, hashIndex].filter(index => index >= 0).reduce((min, index) => Math.min(min, index), rest.length)
  const authority = rest.slice(0, authorityEnd)
  if (authority.length === 0) invalidNode('missing server and user')
  const queryEnd = hashIndex >= 0 ? hashIndex : rest.length
  const query = queryIndex >= 0 && queryIndex < queryEnd ? rest.slice(queryIndex + 1, queryEnd) : ''
  const fragment = hashIndex >= 0 ? decodeURIComponent(rest.slice(hashIndex + 1)) : ''
  return { authority, params: new URLSearchParams(query), fragment }
}

function parseIdentityAndEndpoint(authority: string): { id: string; server: string; port: number } {
  if (authority.includes('@')) {
    const at = authority.lastIndexOf('@')
    const id = decodeURIComponent(authority.slice(0, at))
    return { id, ...parseEndpoint(authority.slice(at + 1)) }
  }
  let decoded: string
  try {
    decoded = decodeBase64Url(authority).toString('utf8')
  } catch {
    invalidNode('legacy link payload is not valid base64url')
  }
  if (decoded.includes('\uFFFD') || !decoded.includes('@')) invalidNode('legacy link payload is malformed')
  const at = decoded.lastIndexOf('@')
  const credentials = decoded.slice(0, at)
  const separator = credentials.lastIndexOf(':')
  const id = separator >= 0 ? credentials.slice(separator + 1) : credentials
  return { id, ...parseEndpoint(decoded.slice(at + 1)) }
}

/** Parse the standard VLESS URI and Shadowrocket's legacy base64-authority form. */
export function parseVlessRealityUri(input: string): VlessRealityNode {
  const { authority, params, fragment } = splitVlessUri(input)
  const { id, server, port } = parseIdentityAndEndpoint(authority)
  if (!UUID_PATTERN.test(id)) invalidNode('user id must be a UUID')

  const publicKey = params.get('pbk') ?? params.get('password') ?? params.get('publicKey') ?? ''
  if (publicKey === '' || decodeBase64Url(publicKey).byteLength !== 32) invalidNode('Reality public key is invalid')
  const shortId = params.get('sid') ?? params.get('shortId') ?? ''
  if (shortId.length > 16 || shortId.length % 2 !== 0 || !/^[0-9a-f]*$/iu.test(shortId)) {
    invalidNode('Reality short id must be even-length hexadecimal (up to 16 characters)')
  }
  const serverName = validateServer(params.get('sni') ?? params.get('peer') ?? params.get('serverName') ?? '')
  const security = params.get('security') ?? (publicKey === '' ? (params.get('tls') === '1' ? 'tls' : 'none') : 'reality')
  if (security !== 'reality') invalidNode('only VLESS Reality nodes are supported')

  const network = params.get('type') ?? params.get('network') ?? params.get('obfs') ?? 'raw'
  if (!['raw', 'tcp', 'none'].includes(network)) invalidNode('only RAW/TCP transport is supported')
  const requestedFlow = params.get('flow') ?? (params.get('xtls') === '2' ? 'xtls-rprx-vision' : '')
  if (requestedFlow !== '' && requestedFlow !== 'xtls-rprx-vision') invalidNode('unsupported VLESS flow')
  const fingerprint = params.get('fp') ?? params.get('fingerprint') ?? 'chrome'
  if (!/^[A-Za-z0-9._-]{1,32}$/u.test(fingerprint)) invalidNode('invalid Reality fingerprint')
  const spiderX = params.get('spx') ?? params.get('spiderX') ?? '/'
  if (!spiderX.startsWith('/') || spiderX.length > 512) invalidNode('invalid Reality spider path')
  const rawLabel = params.get('remarks') ?? fragment
  const label = rawLabel.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 128)

  return {
    server,
    port,
    id: id.toLowerCase(),
    serverName,
    publicKey,
    shortId: shortId.toLowerCase(),
    fingerprint,
    spiderX,
    ...(requestedFlow === '' ? {} : { flow: 'xtls-rprx-vision' as const }),
    ...(label === '' ? {} : { label }),
  }
}

/** Build a single-inbound, single-outbound Xray config with no direct fallback. */
export function createXrayConfig(node: VlessRealityNode, proxyPort = 18080): XrayConfig {
  return {
    log: {
      access: '/var/root/dsh-vless-access.log',
      error: '/var/root/dsh-vless-error.log',
      loglevel: 'warning',
    },
    inbounds: [{
      tag: 'dsh-http',
      listen: '127.0.0.1',
      port: proxyPort,
      protocol: 'http',
      settings: {},
    }],
    outbounds: [{
      tag: 'vless-out',
      protocol: 'vless',
      settings: {
        vnext: [{
          address: node.server,
          port: node.port,
          users: [{
            id: node.id,
            encryption: 'none',
            ...(node.flow === undefined ? {} : { flow: node.flow }),
          }],
        }],
      },
      streamSettings: {
        network: 'raw',
        security: 'reality',
        realitySettings: {
          serverName: node.serverName,
          fingerprint: node.fingerprint,
          password: node.publicKey,
          shortId: node.shortId,
          spiderX: node.spiderX,
        },
      },
    }],
  }
}

/** Secret-free label persisted separately from Xray's credential-bearing config. */
export function publicNodeSummary(node: VlessRealityNode): string {
  return node.label ?? `Reality · ${node.server}:${node.port}`
}

/** Known-safe fallback used if a first-time configuration must be rolled back. */
export function createFailClosedXrayConfig(proxyPort = 18080): XrayConfig {
  const config = createXrayConfig({
    server: 'invalid.invalid',
    port: 443,
    id: '00000000-0000-4000-8000-000000000000',
    serverName: 'invalid.invalid',
    publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    shortId: '',
    fingerprint: 'chrome',
    spiderX: '/',
  }, proxyPort)
  config.outbounds = [{ tag: 'blocked', protocol: 'blackhole', settings: {} }]
  return config
}
