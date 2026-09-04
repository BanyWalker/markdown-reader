import * as echarts from 'echarts';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';

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

function previewError(kind: string, message: string, source: string) {
  return `<section class="preview-error" role="status"><strong>${escapeHtml(kind)} 无法渲染</strong><span>${escapeHtml(message)}</span><details><summary>查看原始内容</summary><pre><code>${escapeHtml(source)}</code></pre></details></section>`;
}

function readSource(element: HTMLElement, attribute: string) {
  const encodedSource = element.dataset[attribute];
  if (!encodedSource) throw new Error('预览内容缺失。');
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

function renderECharts(element: HTMLElement, theme: PreviewTheme) {
  const source = readSource(element, 'echartsOption');
  const option: unknown = JSON.parse(source);
  if (!option || Array.isArray(option) || typeof option !== 'object') {
    throw new Error('配置必须是 JSON 对象。');
  }
  if (hasUnsafeChartValue(option)) {
    throw new Error('配置不能引用外部资源。');
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

async function renderMermaid(element: HTMLElement, theme: PreviewTheme) {
  const source = readSource(element, 'mermaidSource');
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

export function renderVisualPreviews(root: HTMLElement, theme: PreviewTheme) {
  const cleanups: Array<() => void> = [];

  root.querySelectorAll<HTMLElement>('.echarts-preview').forEach((element) => {
    try {
      cleanups.push(renderECharts(element, theme));
    } catch (error) {
      const source = element.dataset.echartsOption ? decodeURIComponent(element.dataset.echartsOption) : '';
      element.outerHTML = previewError('ECharts 图表', error instanceof Error ? error.message : '配置无效。', source);
    }
  });

  root.querySelectorAll<HTMLElement>('.mermaid-preview').forEach((element) => {
    void renderMermaid(element, theme).catch((error: unknown) => {
      if (!element.isConnected) return;
      const source = element.dataset.mermaidSource ? decodeURIComponent(element.dataset.mermaidSource) : '';
      element.outerHTML = previewError('Mermaid 图示', error instanceof Error ? error.message : '图示语法无效。', source);
    });
  });

  return () => cleanups.forEach((cleanup) => cleanup());
}
