import fs from 'node:fs';

function renderPanelPage() {
  const runtime = ['locale.mjs', 'locale-state.mjs'].map((name) => {
    const source = fs.readFileSync(new URL(`../../lib/${name}`, import.meta.url), 'utf8');
    const script = source
      .replace(/^import\s*\{[^}]*\}\s*from\s*'\.\/locale\.mjs';?\s*$/m, '')
      .replace(/^export\s*\{[^}]*\};?\s*$/m, '');
    if (/^\s*(import|export)\b/m.test(script)) {
      throw new Error(`Unsupported panel locale runtime syntax: ${name}`);
    }
    return script;
  });
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const marker = '/* AGYCTL_LOCALE_RUNTIME */';
  if (!html.includes(marker)) throw new Error('Panel locale initialization marker is missing');
  return html.replace(marker, () => runtime.join('\n').replace(/<\/script/gi, '<\\/script'));
}

export { renderPanelPage };
