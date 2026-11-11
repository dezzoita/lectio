// Simulatore minimo di una scheda di Google Docs: abbastanza fedele per verificare
// posizioni d'inserimento, stili di paragrafo ed elenchi puntati.
export class DocSim {
  constructor(paras) {
    // paras: [{text, named='NORMAL_TEXT', bullet=false, ts={}}]
    this.paras = paras.length ? paras.map(p => ({ named: 'NORMAL_TEXT', bullet: false, ts: {}, ...p })) : [{ text: '', named: 'NORMAL_TEXT', bullet: false, ts: {} }];
  }
  layout() {
    let i = 1;
    return this.paras.map(p => { const s = i; i += p.text.length + 1; return { p, start: s, end: i }; });
  }
  body() {
    return this.layout().map(({ p, start, end }) => ({
      startIndex: start, endIndex: end,
      paragraph: {
        paragraphStyle: { namedStyleType: p.named },
        ...(p.bullet ? { bullet: { listId: 'x' } } : {}),
        elements: [{ startIndex: start, endIndex: end, textRun: { content: p.text + '\n', textStyle: p.ts } }],
      },
    }));
  }
  tab(tabId = 't.1', title = 'Scheda') { return { tabId, title, body: this.body() }; }
  overlapping(s, e) { return this.layout().filter(({ start, end }) => start < e && end > s); }
  apply(requests) {
    for (const r of requests) {
      if (r.insertText) {
        const idx = r.insertText.location.index;
        const L = this.layout();
        const k = L.findIndex(({ start, end }) => idx >= start && idx < end);
        if (k < 0) throw new Error('indice fuori dal documento: ' + idx);
        const { p, start } = L[k];
        const off = idx - start;
        const pieces = (p.text.slice(0, off) + r.insertText.text + p.text.slice(off)).split('\n');
        const repl = pieces.map(t => ({ ...p, ts: { ...p.ts }, text: t }));
        this.paras.splice(k, 1, ...repl);
      } else if (r.updateParagraphStyle) {
        const { startIndex, endIndex } = r.updateParagraphStyle.range;
        for (const { p } of this.overlapping(startIndex, endIndex)) {
          if (r.updateParagraphStyle.paragraphStyle.namedStyleType) p.named = r.updateParagraphStyle.paragraphStyle.namedStyleType;
        }
      } else if (r.deleteParagraphBullets) {
        const { startIndex, endIndex } = r.deleteParagraphBullets.range;
        for (const { p } of this.overlapping(startIndex, endIndex)) p.bullet = false;
      } else if (r.updateTextStyle) {
        const { startIndex, endIndex } = r.updateTextStyle.range;
        const fields = r.updateTextStyle.fields.split(',');
        for (const { p, start, end } of this.overlapping(startIndex, endIndex)) {
          if (startIndex <= start && endIndex >= end - 1) {
            for (const f of fields) { if (f in r.updateTextStyle.textStyle) p.ts[f] = r.updateTextStyle.textStyle[f]; else delete p.ts[f]; }
          }
        }
      } else throw new Error('richiesta non simulata: ' + Object.keys(r)[0]);
    }
  }
  texts() { return this.paras.map(p => p.text); }
}
