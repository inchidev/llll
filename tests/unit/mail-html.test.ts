import { describe, expect, it } from 'vitest'
import { mailHtmlText, mailMarkdownHtml, mailMarkdownText, sanitizeMailHtml } from '../../shared/mail-html'

const body = (markdown: string) => /<body>([\s\S]*)<\/body>/u.exec(mailMarkdownHtml(markdown))![1]

describe('formatted mail', () => {
  it('turns the toolbar formatting into HTML', () => {
    expect(body('Hello **Ann** and _Bo_,\nsecond line\n\nNew paragraph with [the quote](https://example.com/q?a=1&b=2).'))
      .toBe('<p>Hello <strong>Ann</strong> and <em>Bo</em>,<br>second line</p>\n<p>New paragraph with <a href="https://example.com/q?a=1&amp;b=2" rel="noopener noreferrer">the quote</a>.</p>')
    expect(body('- one\n- two\n\n3. three\n4. four')).toBe('<ul><li>one</li><li>two</li></ul>\n<ol start="3"><li>three</li><li>four</li></ol>')
    expect(body('> quoted **text**\n> more\n\n# Title\n```\n<b>code</b>\n```')).toBe('<blockquote><p>quoted <strong>text</strong><br>more</p></blockquote>\n<h1>Title</h1>\n<pre><code>&lt;b&gt;code&lt;/b&gt;</code></pre>')
  })

  it('escapes everything typed and keeps only web and mail links', () => {
    expect(body('<script>alert(1)</script> <img src=x onerror=alert(1)>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt;</p>')
    expect(body('[a](javascript:void0) [b](data:text/html,x) [c](/relative) [d](mailto:ann@example.net)'))
      .toBe('<p>a b c <a href="mailto:ann@example.net" rel="noopener noreferrer">d</a></p>')
    expect(body('<@00000000-0000-4000-8000-000000000001> ||hidden||')).toBe('<p>@00000000-0000-4000-8000-000000000001 hidden</p>')
  })

  it('always has a readable text alternative', () => {
    expect(mailMarkdownText('Hi **Ann**\n\n- one\n- two\n\nSee [docs](https://example.com/docs) or https://example.com\n\n> quoted'))
      .toBe('Hi Ann\n\n * one\n * two\n\nSee docs [https://example.com/docs] or https://example.com\n\n> quoted')
  })
})

describe('outbound HTML allowlist', () => {
  it.each([
    ['<p onclick="steal()" style="color:red" class="x">Hi</p>', '<p>Hi</p>'],
    ['<img src=x onerror=alert(1)>Text', 'Text'],
    ['<a href="jav&#x61;script:alert(1)">x</a>', 'x'],
    ['<a href=" java\tscript:alert(1)">x</a><a>y</a>', 'xy'],
    ['<a href=\'https://example.com/"onmouseover="x\'>x</a>', '<a href="https://example.com/&quot;onmouseover=&quot;x" rel="noopener noreferrer">x</a>'],
    ['<style>p{}</style><script>alert(1)</script><!-- note --><template><p>t</p></template>Kept', 'Kept'],
    ['<svg><script>alert(1)</script><text>words</text></svg>', 'words'],
    ['<strong><em>open', '<strong><em>open</em></strong>'],
    ['</p>a < b > c <<script>x', 'a &lt; b &gt; c &lt;'],
    ['<ol start="5" reversed><li>x</li></ol><ol start="1;x"><li>y</li></ol>', '<ol start="5"><li>x</li></ol><ol><li>y</li></ol>'],
    ['<STRONG>Caps</STRONG><iframe src="https://example.com"></iframe>', '<strong>Caps</strong>'],
  ])('%s', (html, expected) => {
    expect(sanitizeMailHtml(html)).toBe(expected)
  })

  it('renders HTML as plain text for the alternative', () => {
    expect(mailHtmlText('<p>One</p><p>Two <a href="https://example.com">site</a></p>')).toBe('One\n\nTwo site [https://example.com]')
  })
})
