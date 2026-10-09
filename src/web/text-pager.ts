// Measure only the current text screen, on navigation or a size change. Text is
// never deleted, and grapheme boundaries preserve emoji and combining marks.
export class TextPager {
  private boundaries: number[];
  private starts = [0];
  private index = 0;
  end = 0;
  private cache = new Map<string, number>();
  constructor(readonly text: string, readonly area: HTMLElement,readonly preferParagraphs=false) {
    this.boundaries = [0];
    if (typeof Intl.Segmenter === 'function') {
      for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text))
        this.boundaries.push(part.index + part.segment.length);
    } else {
      let end = 0;
      for (const char of text) { end += char.length; this.boundaries.push(end); }
    }
  }
  get start() { return this.starts[this.index]!; }
  get number() { return this.index + 1; }
  get more() { return this.end < this.text.length; }
  get back() { return this.index > 0; }
  next() { if (this.more) { this.starts.splice(this.index + 1); this.starts.push(this.end); this.index++; } }
  previous() { if (this.back) this.index--; }
  show() {
    const { width, height } = this.area.getBoundingClientRect();
    const key = `${this.start}/${width}/${height}`;
    let end = this.cache.get(key);
    if (end === undefined) {
      const probe = this.area.cloneNode(false) as HTMLElement;
      probe.removeAttribute('id'); probe.removeAttribute('tabindex'); probe.setAttribute('aria-hidden', 'true');
      Object.assign(probe.style, { position: 'fixed', left: '0', top: '0', width: `${width}px`, height: `${height}px`,
        visibility: 'hidden', pointerEvents: 'none', contain: 'strict' });
      document.body.append(probe);
      const first = this.boundaries.indexOf(this.start);
      let low = first, high = this.boundaries.length - 1;
      try {
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          probe.textContent = this.text.slice(this.start, this.boundaries[mid]);
          if (probe.scrollHeight <= probe.clientHeight && probe.scrollWidth <= probe.clientWidth) low = mid;
          else high = mid - 1;
        }
        // Too little space is reported to the caller instead of clipping a glyph.
        end = this.boundaries[low]!;
        // Consent keeps paragraphs together when at least half a screen can be
        // used. Oversized paragraphs still split at a safe grapheme boundary.
        if(this.preferParagraphs&&end<this.text.length){const boundary=this.text.lastIndexOf('\n\n',end-2)+2;if(boundary>this.start&&boundary-this.start>=(end-this.start)/2)end=boundary;}
      } finally { probe.remove(); }
      if (this.cache.size >= 64) this.cache.clear();
      this.cache.set(key, end);
    }
    this.end = end;
    this.area.textContent = this.text.slice(this.start, end);
    return end > this.start || this.text.length === 0;
  }
}
