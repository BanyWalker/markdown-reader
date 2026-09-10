import * as echarts from 'echarts';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import { translations, type Language } from './i18n';

type PreviewTheme = 'light' | 'dark' | 'wood' | 'white';

let mermaidSequence = 0;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character] ?? character);
}

function previewError(kind: string, message: string, source: string, language: Language) {
  const t = translations[language];
  return `<section class="preview-error" role="status"><strong>${escapeHtml(kind)} ${escapeHtml(t.cannotRender)}</strong><span>${escapeHtml(message)}</span><details><summary>${escapeHtml(t.viewSource)}</summary><pre><code>${escapeHtml(source)}</code></pre></details></section>`;
}

function readSource(element: HTMLElement, attribute: string, language: Language) {
  const encodedSource = element.dataset[attribute];
  if (!encodedSource) throw new Error(translations[language].previewContentMissing);
  return decodeURIComponent(encodedSource);
}

function hasUnsafeChartValue(value: unknown, key = ''): boolean {
  if (typeof value === 'string') {
    return ['src', 'image', 'symbol'].includes(key)
      && /^(?:https?:|data:|javascript:|image:\/\/)/i.test(value.trim());
  }
  if (Array.isArray(value)) return value.some((item) => hasUnsafeChartValue(item, key));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([childKey, childValue]) => hasUnsafeChartValue(childValue, childKey));
  }
  return false;
}

function renderECharts(element: HTMLElement, theme: PreviewTheme, language: Language) {
  const t = translations[language];
  const source = readSource(element, 'echartsOption', language);
  const option: unknown = JSON.parse(source);
  if (!option || Array.isArray(option) || typeof option !== 'object') {
    throw new Error(t.chartConfigurationMustBeObject);
  }
  if (hasUnsafeChartValue(option)) {
    throw new Error(t.chartConfigurationCannotUseExternalResources);
  }

  const chart = echarts.init(element, theme === 'dark' ? 'dark' : undefined, { renderer: 'canvas' });
  chart.setOption(option as echarts.EChartsCoreOption, { notMerge: true, lazyUpdate: false });
  const resizeObserver = new ResizeObserver(() => chart.resize());
  resizeObserver.observe(element);

  return () => {
    resizeObserver.disconnect();
    chart.dispose();
  };
}

async function renderMermaid(element: HTMLElement, theme: PreviewTheme, language: Language) {
  const source = readSource(element, 'mermaidSource', language);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'dark' ? 'dark' : 'default'
  });
  const id = `md-reader-mermaid-${++mermaidSequence}`;
  const { svg } = await mermaid.render(id, source);
  if (element.isConnected) {
    element.innerHTML = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true }
    });
  }
}

export function renderVisualPreviews(root: HTMLElement, theme: PreviewTheme, language: Language) {
  const t = translations[language];
  const cleanups: Array<() => void> = [];

  root.querySelectorAll<HTMLElement>('.echarts-preview').forEach((element) => {
    try {
      cleanups.push(renderECharts(element, theme, language));
    } catch (error) {
      const source = element.dataset.echartsOption ? decodeURIComponent(element.dataset.echartsOption) : '';
      element.outerHTML = previewError(t.echartsChart, error instanceof Error ? error.message : t.chartConfigurationInvalidShort, source, language);
    }
  });

  root.querySelectorAll<HTMLElement>('.mermaid-preview').forEach((element) => {
    void renderMermaid(element, theme, language).catch((error: unknown) => {
      if (!element.isConnected) return;
      const source = element.dataset.mermaidSource ? decodeURIComponent(element.dataset.mermaidSource) : '';
      element.outerHTML = previewError(t.mermaidDiagram, error instanceof Error ? error.message : t.diagramSyntaxInvalid, source, language);
    });
  });

  return () => cleanups.forEach((cleanup) => cleanup());
}
