import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

// Runtime import keeps the server-only TypeScript project independent of JSX;
// the browser project checks the component itself with JSX enabled.
const { OpenAICodexSettings } = await import('../src/client/' + 'OpenAICodexSettings.tsx')

describe('Codex image model settings', () => {
  it.each([en, zh])('keeps the unverified upstream-model warning visible while loading', dictionary => {
    const html = renderToStaticMarkup(createElement(OpenAICodexSettings, { t: (key: keyof typeof en) => dictionary[key] }))
    expect(html).toContain(dictionary.codexImageModel)
    expect(html).toContain(dictionary.codexImageModelHint)
    expect(html).toMatch(/<select[^>]*id="codex-image-request-model"[^>]*disabled/)
    expect(html).toContain('aria-describedby="codex-image-request-model-hint"')
  })
})
