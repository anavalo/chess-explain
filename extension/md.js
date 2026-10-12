// Minimal markdown for the model's answers: paragraphs, - / 1. lists, # headings, **bold**, *italic*, `code`.
// HTML is escaped first, so the only tags in the output are the ones added here.
export function md(text) {
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const html = [];
  let para = [], list = null;
  const flush = () => {
    if (para.length) html.push(`<p>${para.map(inline).join('<br>')}</p>`);
    if (list) html.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    para = [];
    list = null;
  };
  for (const line of text.split('\n')) {
    const item = line.match(/^\s*(?:([-*•])|\d+[.)])\s+(.*)$/);
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (!line.trim()) flush();
    else if (heading) { flush(); html.push(`<h3>${inline(heading[1])}</h3>`); }
    else if (item) {
      const tag = item[1] ? 'ul' : 'ol';
      if (para.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(item[2]);
    } else if (list) list.items[list.items.length - 1] += ' ' + line.trim();  // wrapped list item
    else para.push(line);
  }
  flush();
  return html.join('');
}
