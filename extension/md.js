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

const NO = String.raw`\d+\.(?:\.\.)?`; // '15.' or '14...'
const SAN = String.raw`(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?|O-O(?:-O)?)[+#]?`;
const RUN = new RegExp(String.raw`(?<![\w.])${NO}${SAN}(?:\s+(?:${NO})?${SAN})*(?![\w-])`, 'g');
const TOKEN = new RegExp(`(${NO})?(${SAN})`, 'g');

/** Marks the numbered variations in md() output ("14...Rfe8 15.Nbd2 Ne7"): each move becomes a link whose data-line
    holds the SAN moves from the explained position through it. `lines` are line_with_evals strings from that position.
    A move is linked only when the lines give it one history. */
export function linkMoves(html, lines) {
  // every line as [{no, san}]; a "Why X fails:" line branches off its main line at its first move
  const vars = lines.filter(Boolean).flatMap(text => {
    const [main, ...whys] = text.split('\n')
      .map(l => [...l.matchAll(/(\d+\.(?:\.\.)?) (?:you|opp) (\S+)/g)].map(m => ({ no: m[1], san: m[2].replace(/[+#]/g, '') })));
    return [main, ...whys.map(w => [...main.slice(0, main.findIndex(m => m.no === w[0]?.no)), ...w])];
  });
  return html.replace(RUN, run => {
    let at = []; // [line, index] pairs the previous move of this run can be
    return run.replace(TOKEN, (tok, no, san) => {
      const fits = (v, i) => v[i] && v[i].san === san.replace(/[+#]/g, '') && (!no || v[i].no === no);
      const next = at.map(([v, i]) => [v, i + 1]).filter(([v, i]) => fits(v, i));
      at = next.length || !no ? next : vars.flatMap(v => v.map((_, i) => [v, i])).filter(([v, i]) => fits(v, i));
      const found = new Set(at.map(([v, i]) => v.slice(0, i + 1).map(m => m.san).join(' ')));
      return found.size === 1 ? `<a href="#" data-line="${[...found][0]}">${tok}</a>` : tok;
    });
  });
}
