import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import container from 'markdown-it-container';
import { full as emoji } from 'markdown-it-emoji';
import footnote from 'markdown-it-footnote';
import katex from 'markdown-it-katex';
import mark from 'markdown-it-mark';
import sub from 'markdown-it-sub';
import sup from 'markdown-it-sup';
import taskLists from 'markdown-it-task-lists';
import { convertFileSrc } from '@tauri-apps/api/core';
import 'katex/dist/katex.min.css';

export interface TableOfContentsItem {
  id: string;
  level: number;
  text: string;
}

export interface RenderedMarkdown {
  html: string;
  headings: TableOfContentsItem[];
}

function highlightCode(code: string, language: string) {
  if (language && hljs.getLanguage(language)) {
    try {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } catch {
    }
  }
  return MarkdownIt().utils.escapeHtml(code);
}

function escapeHtml(value: string) {
  return MarkdownIt().utils.escapeHtml(value);
}

function renderPreviewError(kind: string, message: string, source: string) {
  return `<section class="preview-error" role="status"><strong>${escapeHtml(kind)} 无法渲染</strong><span>${escapeHtml(message)}</span><details><summary>查看原始内容</summary><pre><code>${escapeHtml(source)}</code></pre></details></section>`;
}

function renderEChartsBlock(source: string) {
  try {
    const option = JSON.parse(source);
    if (!option || Array.isArray(option) || typeof option !== 'object') {
      return renderPreviewError('ECharts 图表', '配置必须是 JSON 对象。', source);
    }
    return `<div class="echarts-preview" data-echarts-option="${encodeURIComponent(source)}" aria-label="ECharts 图表"></div>`;
  } catch {
    return renderPreviewError('ECharts 图表', '配置不是有效的 JSON。', source);
  }
}

function renderMermaidBlock(source: string) {
  return `<div class="mermaid-preview" data-mermaid-source="${encodeURIComponent(source)}" aria-label="Mermaid 图示"><span>正在渲染图示…</span></div>`;
}

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight: highlightCode
})
  .use(anchor, { permalink: false })
  .use(taskLists, { enabled: true, label: true, labelAfter: true })
  .use(katex)
  .use(footnote)
  .use(emoji)
  .use(mark)
  .use(sub)
  .use(sup)
  .use(container, 'tip')
  .use(container, 'info')
  .use(container, 'warning')
  .use(container, 'danger');

const defaultFenceRenderer = markdown.renderer.rules.fence;
markdown.renderer.rules.fence = (tokens, index, options, environment, self) => {
  const token = tokens[index];
  const language = token.info.trim();

  if (language === 'echarts') return renderEChartsBlock(token.content);
  if (language === 'mermaid') return renderMermaidBlock(token.content);

  return defaultFenceRenderer
    ? defaultFenceRenderer(tokens, index, options, environment, self)
    : self.renderToken(tokens, index, options);
};

const defaultImageRenderer = markdown.renderer.rules.image;
markdown.renderer.rules.image = (tokens, index, options, environment, self) => {
  const source = tokens[index].attrGet('src');
  const baseDirectory = (environment as { baseDirectory?: string }).baseDirectory;

  if (source && baseDirectory && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(source)) {
    try {
      const fileBaseUrl = `file:///${baseDirectory.replace(/\\/g, '/')}/`;
      const fileUrl = new URL(source, fileBaseUrl);
      const pathName = decodeURIComponent(fileUrl.pathname).replace(/^\/([a-z]:\/)/i, '$1');
      tokens[index].attrSet('src', convertFileSrc(pathName));
    } catch {
    }
  }

  return defaultImageRenderer
    ? defaultImageRenderer(tokens, index, options, environment, self)
    : self.renderToken(tokens, index, options);
};

export function renderMarkdown(source: string, baseDirectory: string): RenderedMarkdown {
  const unsafeHtml = markdown.render(source, { baseDirectory });
  const html = DOMPurify.sanitize(unsafeHtml, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: /^(?:(?:https?|asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  });

  const documentFragment = new DOMParser().parseFromString(html, 'text/html');
  const headings = Array.from(
    documentFragment.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')
  ).flatMap((heading) => {
    const id = heading.id;
    const text = heading.textContent?.trim() ?? '';

    return id && text
      ? [{ id, level: Number(heading.tagName.slice(1)), text }]
      : [];
  });

  return { html, headings };
}

export function renderPlainText(source: string): RenderedMarkdown {
  const escapedText = source.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return entities[character];
  });

  return {
    html: `<pre class="plain-text-document">${escapedText}</pre>`,
    headings: []
  };
}
