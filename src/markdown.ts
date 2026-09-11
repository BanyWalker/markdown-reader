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
import { translations, type Language } from './i18n';
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

const trailingLinkPunctuation = new Set([
  '.', ',', ';', ':', '!', '?',
  '\u3002', '\uff0c', '\uff1b', '\uff1a', '\uff01', '\uff1f', '\u3001',
  '\u300d', '\u3009', '\u300b', '\u300f', '\u3011', '\uff09', '\uff3d', '\uff5d',
  '\u201d', '\u2019', '"', "'"
]);

// linkify-it correctly permits Unicode URL paths, but Chinese prose often follows a
// URL without whitespace (for example: "https://example.com（说明）"). Treat common
// CJK sentence punctuation and opening delimiters as an auto-link boundary.
const autoLinkTextBoundary = /[\u3000\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\uff08\uff3b\uff5b\u3008\u300a\u300c\u300e\u3010\u3014\u2018\u201c]/u;

function countCharacter(value: string, character: string) {
  return [...value].filter((item) => item === character).length;
}

/** Removes sentence punctuation accidentally included at the end of an HTTP URL. */
export function trimLinkPunctuation(value: string) {
  let url = value.trim();
  let suffix = '';

  while (url) {
    const character = url.at(-1);
    if (!character) break;

    const pairedClosing = character === ')' && countCharacter(url, ')') > countCharacter(url, '(')
      || character === ']' && countCharacter(url, ']') > countCharacter(url, '[')
      || character === '}' && countCharacter(url, '}') > countCharacter(url, '{')
      || character === '\uff09' && countCharacter(url, '\uff09') > countCharacter(url, '\uff08')
      || character === '\u3011' && countCharacter(url, '\u3011') > countCharacter(url, '\u3010');

    if (!pairedClosing && !trailingLinkPunctuation.has(character)) break;
    url = url.slice(0, -1);
    suffix = character + suffix;
  }

  return { url, suffix };
}

export function splitAutoLinkText(value: string) {
  const boundaryIndex = value.search(autoLinkTextBoundary);
  return boundaryIndex < 0
    ? { url: value, suffix: '' }
    : { url: value.slice(0, boundaryIndex), suffix: value.slice(boundaryIndex) };
}

function normalizeAutoLinks(document: Document) {
  document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href')?.trim();
    if (!href || !/^https?:\/\//i.test(href)) return;

    const textNode = anchor.firstChild;
    const isPlainAutoLink = anchor.hasAttribute('data-auto-link')
      && anchor.childNodes.length === 1
      && textNode?.nodeType === Node.TEXT_NODE
      && /^https?:\/\//i.test(textNode.textContent ?? '');
    const autoLink = isPlainAutoLink ? splitAutoLinkText(textNode!.textContent!) : { url: href, suffix: '' };
    const trimmed = trimLinkPunctuation(autoLink.url);
    const url = trimmed.url;
    const suffix = trimmed.suffix + autoLink.suffix;
    if (!suffix || !url) return;
    anchor.setAttribute('href', url);

    if (anchor.childNodes.length === 1 && textNode?.nodeType === Node.TEXT_NODE) {
      textNode.textContent = isPlainAutoLink
        ? url
        : textNode.textContent?.endsWith(suffix)
          ? textNode.textContent.slice(0, -suffix.length)
          : textNode.textContent;
      anchor.after(document.createTextNode(suffix));
    }
  });
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

function renderPreviewError(kind: string, message: string, source: string, language: Language) {
  const t = translations[language];
  return `<section class="preview-error" role="status"><strong>${escapeHtml(kind)} ${escapeHtml(t.cannotRender)}</strong><span>${escapeHtml(message)}</span><details><summary>${escapeHtml(t.viewSource)}</summary><pre><code>${escapeHtml(source)}</code></pre></details></section>`;
}

function renderEChartsBlock(source: string, language: Language) {
  const t = translations[language];
  try {
    const option = JSON.parse(source);
    if (!option || Array.isArray(option) || typeof option !== 'object') {
      return renderPreviewError(t.echartsChart, t.chartConfigurationMustBeObject, source, language);
    }
    return `<div class="echarts-preview" data-echarts-option="${encodeURIComponent(source)}" aria-label="${escapeHtml(t.echartsChart)}"></div>`;
  } catch {
    return renderPreviewError(t.echartsChart, t.chartConfigurationInvalid, source, language);
  }
}

function renderMermaidBlock(source: string, language: Language) {
  const t = translations[language];
  return `<div class="mermaid-preview" data-mermaid-source="${encodeURIComponent(source)}" aria-label="${escapeHtml(t.mermaidDiagram)}"><span>${escapeHtml(t.renderingDiagram)}</span></div>`;
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
  const fenceLanguage = token.info.trim();
  const language = (environment as { language?: Language }).language === 'en' ? 'en' : 'zh-CN';

  if (fenceLanguage === 'echarts') return renderEChartsBlock(token.content, language);
  if (fenceLanguage === 'mermaid') return renderMermaidBlock(token.content, language);

  return defaultFenceRenderer
    ? defaultFenceRenderer(tokens, index, options, environment, self)
    : self.renderToken(tokens, index, options);
};

const defaultLinkOpenRenderer = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, environment, self) => {
  const token = tokens[index];
  if (token.info === 'auto') token.attrSet('data-auto-link', 'true');
  return defaultLinkOpenRenderer
    ? defaultLinkOpenRenderer(tokens, index, options, environment, self)
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

export function renderMarkdown(source: string, baseDirectory: string, language: Language): RenderedMarkdown {
  const unsafeHtml = markdown.render(source, { baseDirectory, language });
  const sanitizedHtml = DOMPurify.sanitize(unsafeHtml, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: /^(?:(?:https?|asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  });

  const documentFragment = new DOMParser().parseFromString(sanitizedHtml, 'text/html');
  normalizeAutoLinks(documentFragment);
  const html = documentFragment.body.innerHTML;
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
