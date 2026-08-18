import { describe, expect, it } from 'vitest'
import { createXrayConfig, parseVlessRealityUri, publicNodeSummary } from '../src/vless.ts'
import { parseLaunchdPid } from '../src/vless-controller.ts'

const ID = '123e4567-e89b-42d3-a456-426614174000'
const PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64url')

describe('VLESS Reality configuration', () => {
  it('extracts the live Xray process id from launchctl status', () => {
    expect(parseLaunchdPid('state = running\n\tpid = 15426\n')).toBe(15426)
    expect(parseLaunchdPid('state = waiting\n\tlast exit code = 1\n')).toBeUndefined()
  })

  it('parses Shadowrocket legacy base64-authority links without leaking their input', () => {
    const authority = Buffer.from(`none:${ID}@203.0.113.8:23249`).toString('base64url')
    const node = parseVlessRealityUri(
      `vless://${authority}?remarks=private-node&obfs=none&tls=1&peer=example.com&xtls=2&pbk=${PUBLIC_KEY}&sid=abcdef0123456789`,
    )

    expect(node).toEqual({
      server: '203.0.113.8',
      port: 23249,
      id: ID,
      serverName: 'example.com',
      publicKey: PUBLIC_KEY,
      shortId: 'abcdef0123456789',
      fingerprint: 'chrome',
      spiderX: '/',
      flow: 'xtls-rprx-vision',
      label: 'private-node',
    })
    expect(publicNodeSummary(node)).toBe('private-node')
  })

  it('builds a loopback-only config with no direct fallback', () => {
    const node = parseVlessRealityUri(
      `vless://${ID}@reality.example:443?security=reality&type=tcp&sni=www.example.com&fp=chrome&pbk=${PUBLIC_KEY}&sid=12ab#home`,
    )
    const config = createXrayConfig(node)

    expect(config.inbounds[0]).toMatchObject({ listen: '127.0.0.1', port: 18080, protocol: 'http' })
    expect(config.outbounds).toHaveLength(1)
    expect(config.outbounds[0]).toMatchObject({
      protocol: 'vless',
      streamSettings: {
        network: 'raw',
        security: 'reality',
        realitySettings: {
          serverName: 'www.example.com',
          password: PUBLIC_KEY,
          shortId: '12ab',
        },
      },
    })
    expect(JSON.stringify(config)).not.toContain('freedom')
  })

  it('rejects unsupported transports and malformed Reality credentials', () => {
    expect(() => parseVlessRealityUri(
      `vless://${ID}@reality.example:443?security=reality&type=ws&sni=example.com&pbk=${PUBLIC_KEY}&sid=12ab`,
    )).toThrow('only RAW/TCP')
    expect(() => parseVlessRealityUri(
      `vless://${ID}@reality.example:443?security=reality&type=tcp&sni=example.com&pbk=short&sid=12ab`,
    )).toThrow('public key')
  })
})
