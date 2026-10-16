import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../shared/markdown'
import { activeTrigger, extractMentionIds, applyMentionTokens, humanizeMentions } from '../../shared/mentions'

describe('markdown', () => {
  it('escapes html', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('rejects javascript urls', () => {
    const html = renderMarkdown('[x](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('renders bold and code', () => {
    const html = renderMarkdown('**hi** and `code`')
    expect(html).toContain('<strong>hi</strong>')
    expect(html).toContain('<code>code</code>')
  })
})

describe('mentions', () => {
  it('extracts ids', () => {
    const id = '01900000-0000-7000-8000-000000000001'
    expect(extractMentionIds(`hello <@${id}>`)).toEqual([id])
  })

  it('tokenizes @name', () => {
    const id = '01900000-0000-7000-8000-000000000001'
    const out = applyMentionTokens('hey @Ada', [{ id, displayName: 'Ada' }])
    expect(out).toBe(`hey <@${id}>`)
  })

  it('tokenizes names with spaces, preferring the longest match', () => {
    const ada = '01900000-0000-7000-8000-000000000001'
    const lovelace = '01900000-0000-7000-8000-000000000002'
    const members = [{ id: ada, displayName: 'Ada' }, { id: lovelace, displayName: 'Ada Lovelace' }]
    expect(applyMentionTokens('@Ada Lovelace, and @ada.', members)).toBe(`<@${lovelace}>, and <@${ada}>.`)
    expect(applyMentionTokens('email@Ada', members)).toBe('email@Ada')
  })

  it('turns tokens back into names for editing', () => {
    const id = '01900000-0000-7000-8000-000000000001'
    expect(humanizeMentions(`hi <@${id}> and <@01900000-0000-7000-8000-000000000009>`, { [id]: 'Ada Lovelace' }))
      .toBe('hi @Ada Lovelace and <@01900000-0000-7000-8000-000000000009>')
  })

  it('finds the mention or emoji being typed at the caret', () => {
    expect(activeTrigger('hi @ad', 6, '@')).toEqual({ start: 3, query: 'ad' })
    expect(activeTrigger('hi @Ada Lo', 10, '@')).toEqual({ start: 3, query: 'Ada Lo' })
    expect(activeTrigger('mail@ad', 7, '@')).toBeNull()
    expect(activeTrigger('nice :th', 8, ':')).toEqual({ start: 5, query: 'th' })
    expect(activeTrigger('time 10:3', 9, ':')).toBeNull()
    expect(activeTrigger('nice :t', 7, ':')).toBeNull()
  })
})

describe('lists', () => {
  it('renders bulleted and numbered lists', () => {
    expect(renderMarkdown('- one\n- **two**')).toBe('<ul><li>one</li><li><strong>two</strong></li></ul>')
    expect(renderMarkdown('* a\n* b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(renderMarkdown('1. first\n2) second')).toBe('<ol><li>first</li><li>second</li></ol>')
  })

  it('keeps a numbered list starting point and separates mixed lists', () => {
    expect(renderMarkdown('3. three\n4. four')).toBe('<ol start="3"><li>three</li><li>four</li></ol>')
    expect(renderMarkdown('- bullet\n1. number')).toBe('<ul><li>bullet</li></ul><ol><li>number</li></ol>')
  })

  it('leaves emphasis and plain text alone', () => {
    expect(renderMarkdown('*not a list*')).toBe('<p><em>not a list</em></p>')
    expect(renderMarkdown('-no space')).toBe('<p>-no space</p>')
    expect(renderMarkdown('- <b>x</b>')).toBe('<ul><li>&lt;b&gt;x&lt;/b&gt;</li></ul>')
  })
})

describe('discord formatting', () => {
  it('keeps masked links whole and escapes their urls once', () => {
    expect(renderMarkdown('[docs](https://a.test/?a=1&b=2)')).toBe(
      '<p><a href="https://a.test/?a=1&amp;b=2" rel="noopener noreferrer" target="_blank">docs</a></p>',
    )
  })

  it('leaves trailing punctuation out of bare links', () => {
    expect(renderMarkdown('see https://a.test/x).')).toBe(
      '<p>see <a href="https://a.test/x" rel="noopener noreferrer" target="_blank">https://a.test/x</a>).</p>',
    )
  })

  it('does not format inside code or snake_case words', () => {
    expect(renderMarkdown('`**raw** https://a.test` snake_case_name')).toBe(
      '<p><code>**raw** https://a.test</code> snake_case_name</p>',
    )
  })

  it('renders strikethrough, underline, spoilers, and bold italics', () => {
    const html = renderMarkdown('~~gone~~ __under__ ||secret|| ***both***')
    expect(html).toContain('<s>gone</s>')
    expect(html).toContain('<u>under</u>')
    expect(html).toContain('<span class="spoiler" role="button" tabindex="0" aria-label="Spoiler">secret</span>')
    expect(html).toContain('<strong><em>both</em></strong>')
  })

  it('renders headings and subtext', () => {
    expect(renderMarkdown('# Big\n### Small\n-# fine print')).toBe('<h1>Big</h1><h3>Small</h3><p class="subtext">fine print</p>')
    expect(renderMarkdown('#general')).toBe('<p>#general</p>')
  })

  it('labels fenced code with its language and quotes the rest after >>>', () => {
    expect(renderMarkdown('```ts\nconst a = 1\n```')).toBe('<pre><code class="language-ts">const a = 1</code></pre>')
    expect(renderMarkdown('intro\n>>> one\ntwo')).toBe('<p>intro</p><blockquote>one<br>two</blockquote>')
  })

  it('does not treat multiplication as emphasis', () => {
    expect(renderMarkdown('2 * 3 * 4')).toBe('<p>2 * 3 * 4</p>')
  })
})
