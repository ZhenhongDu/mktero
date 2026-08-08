import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';
import { createLocalization } from '../src/i18n/localization.js';

test('renders selectable block translations without changing Markdown', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = '# Paper\n\nOriginal English paragraph.';
    const editor = createInlineMarkdownEditor({
        parent: document.getElementById('editor'),
        initialMarkdown: markdown,
    });

    editor.setDocument({
        markdown,
        annotationOverlay: null,
        sourceMap: [],
        translationOverlay: {
            visible: true,
            targetLanguage: 'zh-CN',
            segments: [{
                id: 'segment-000001',
                from: markdown.indexOf('Original'),
                to: markdown.length,
                anchor: markdown.length,
                kind: 'paragraph',
                text: '原始英文段落包含公式 $x^2$。',
            }],
        },
    });

    const widget = document.querySelector('.cm-mktero-translation');
    assert.ok(widget);
    assert.match(widget.textContent, /原始英文段落包含公式/u);
    assert.ok(widget.querySelector('.math-inline'));
    assert.ok(widget.querySelector('math'));
    assert.equal(widget.getAttribute('lang'), 'zh-CN');
    assert.equal(widget.getAttribute('dir'), 'auto');
    assert.equal(editor.getMarkdown(), markdown);
    assert.equal(
        document.querySelector('.cm-content').getAttribute('contenteditable'),
        'false'
    );

    editor.setDocument({
        markdown,
        annotationOverlay: null,
        sourceMap: [],
        translationOverlay: {
            visible: false,
            targetLanguage: 'zh-CN',
            segments: [{
                id: 'segment-000001',
                anchor: markdown.length,
                kind: 'paragraph',
                text: '原始英文段落。',
            }],
        },
    });
    assert.equal(document.querySelector('.cm-mktero-translation'), null);
    assert.equal(editor.getMarkdown(), markdown);

    editor.setMarkdown('# Replacement');
    assert.equal(document.querySelector('.cm-mktero-translation'), null);
    assert.equal(editor.getMarkdown(), '# Replacement');

    editor.destroy();
    dom.window.close();
});

test('sanitizes adversarial HTML while still rendering translated math', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = '# Paper\n\nOriginal English paragraph.';
    const editor = createInlineMarkdownEditor({
        parent: document.getElementById('editor'),
        initialMarkdown: markdown,
    });

    editor.setDocument({
        markdown,
        annotationOverlay: null,
        sourceMap: [],
        translationOverlay: {
            visible: true,
            targetLanguage: 'zh-CN',
            segments: [{
                id: 'segment-000001',
                from: markdown.indexOf('Original'),
                to: markdown.length,
                anchor: markdown.length,
                kind: 'paragraph',
                text: '原始公式 $E=mc^2$ <script>alert(1)</script>'
                    + '<img src=x onerror=alert(1)> 继续。',
            }],
        },
    });

    const widget = document.querySelector('.cm-mktero-translation');
    assert.ok(widget);
    assert.ok(widget.querySelector('.math-inline'));
    assert.ok(widget.querySelector('math'));
    assert.equal(widget.querySelectorAll('script').length, 0);
    assert.equal(widget.querySelectorAll('img').length, 0);
    assert.ok(!widget.querySelector('[onerror]'));
    assert.doesNotMatch(widget.innerHTML, /<(?:script|img)\b/i);
    assert.match(widget.innerHTML, /&lt;script&gt;/);
    assert.match(widget.innerHTML, /&lt;img /);
    assert.match(widget.textContent, /原始公式/);
    assert.match(widget.textContent, /继续/);

    editor.destroy();
    dom.window.close();
});

test('routes translated Markdown links through the injected openLink path', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const opened = [];
    const markdown = '# Paper\n\nOriginal English paragraph.';
    const editor = createInlineMarkdownEditor({
        parent: document.getElementById('editor'),
        initialMarkdown: markdown,
        openLink: href => opened.push(href),
    });

    editor.setDocument({
        markdown,
        annotationOverlay: null,
        sourceMap: [],
        translationOverlay: {
            visible: true,
            targetLanguage: 'zh-CN',
            segments: [{
                id: 'segment-000001',
                from: markdown.indexOf('Original'),
                to: markdown.length,
                anchor: markdown.length,
                kind: 'paragraph',
                text: '参见 [示例](https://example.test/paper) 与 [片段](#methods)。'
                    + ' [脚本](javascript:alert(1)) [数据](data:text/plain,bad)',
            }],
        },
    });

    const widget = document.querySelector('.cm-mktero-translation');
    assert.ok(widget);
    const links = [...widget.querySelectorAll('a[href]')];
    assert.equal(links.length, 2);

    for (const link of links) {
        const openedBefore = opened.length;
        const event = new dom.window.MouseEvent('mousedown', {
            button: 0,
            bubbles: true,
            cancelable: true,
        });
        link.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        assert.equal(opened.length, openedBefore + 1);
    }

    assert.deepEqual(opened, [
        'https://example.test/paper',
        '#methods',
    ]);

    const rightClick = new dom.window.MouseEvent('mousedown', {
        button: 2,
        bubbles: true,
        cancelable: true,
    });
    links[0].dispatchEvent(rightClick);
    assert.equal(rightClick.defaultPrevented, false);
    assert.equal(opened.length, 2);

    assert.equal(
        [...widget.querySelectorAll('a')].some(link => (
            /^(?:javascript|data):/iu.test(link.getAttribute('href') || '')
        )),
        false
    );

    editor.destroy();
    dom.window.close();
});

test('localizes generated Markdown copy inside translation widgets', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = '# Paper\n\nOriginal English paragraph.';
    const editor = createInlineMarkdownEditor({
        parent: document.getElementById('editor'),
        initialMarkdown: markdown,
        localization: createLocalization({ zoteroLocale: 'zh-CN' }),
    });

    editor.setDocument({
        markdown,
        annotationOverlay: null,
        sourceMap: [],
        translationOverlay: {
            visible: true,
            targetLanguage: 'zh-CN',
            segments: [{
                id: 'segment-000001',
                anchor: markdown.length,
                kind: 'paragraph',
                text: '<!-- zotero-page: 2 -->',
            }],
        },
    });

    const marker = document.querySelector(
        '.cm-mktero-translation .page-marker'
    );
    assert.ok(marker);
    assert.match(marker.textContent, /第 2 页/u);
    assert.doesNotMatch(marker.textContent, /Page 2/u);

    editor.destroy();
    dom.window.close();
});
