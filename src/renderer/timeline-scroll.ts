/** Every `[data-timeline-key]` element under `root`, in document order. Paging
 * calls this several times per stage, so it walks only the row structure: keyed
 * rows own their content and never nest another keyed row, while an activity
 * disclosure (`.tool-group`) and unkeyed wrappers (image galleries) contain them.
 * A selector-engine scan of every resident node dominated each stage's cost. */
export function timelineKeyedRows(root: Element): HTMLElement[] {
  const rows: HTMLElement[] = [];
  let node = root.firstElementChild;
  while (node) {
    const keyed = node.hasAttribute('data-timeline-key');
    if (keyed) rows.push(node as HTMLElement);
    if (node.firstElementChild && (!keyed || node.classList.contains('tool-group'))) { node = node.firstElementChild; continue; }
    while (node && node !== root && !node.nextElementSibling) node = node.parentElement;
    node = node && node !== root ? node.nextElementSibling : null;
  }
  return rows;
}

/** Capture the visible logical row for one synchronous reconciliation. No retained
 * state: selection changes and user scrolling naturally get a fresh anchor. */
export function preserveTimelineViewport(pane: HTMLElement, timeline: HTMLElement, followBottom = true): () => void {
  const previous = pane.scrollTop;
  const following = followBottom && previous + pane.clientHeight >= pane.scrollHeight - 40;
  const previousReserve = Number.parseFloat(timeline.style.getPropertyValue('--timeline-scroll-reserve')) || 0;
  const previousContentHeight = timeline.getBoundingClientRect().height - previousReserve;
  const edge = pane.getBoundingClientRect().top;
  const rows = () => timelineKeyedRows(timeline)
    .filter(row => !(row.classList.contains('tool-group') && row.hasAttribute('open')));
  const anchors: Array<{ key: string | undefined; offset: number }> = [];
  if (!following) for (const row of rows()) {
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.top >= edge + pane.clientHeight) break;
    if (rect.bottom > edge) anchors.push({ key: row.dataset.timelineKey, offset: rect.top - edge });
  }
  return () => {
    timeline.style.removeProperty('--timeline-scroll-reserve');
    if (following) {
      const growth = Math.max(0, timeline.getBoundingClientRect().height - previousContentHeight);
      const reserve = Math.max(0, previousReserve - growth);
      if (reserve > 0) timeline.style.setProperty('--timeline-scroll-reserve', `${reserve}px`);
      pane.scrollTop = pane.scrollHeight;
      return;
    }
    const currentRows = new Map(rows().map(row => [row.dataset.timelineKey, row]));
    for (const anchor of anchors) {
      const rect = currentRows.get(anchor.key)?.getBoundingClientRect();
      if (!rect || rect.height <= 0) continue;
      const top = pane.scrollTop + rect.top - pane.getBoundingClientRect().top - anchor.offset;
      // An underfilled tail has real blank space below its last row. Prepending
      // must preserve that space too, otherwise Chromium clamps the restored
      // anchor to the new bottom and moves every visible message. Recompute the
      // reserve on each paint so later content naturally consumes it.
      let reserve = Math.ceil(top - Math.max(0, pane.scrollHeight - pane.clientHeight));
      if (reserve > 0) {
        // scrollHeight is floored at clientHeight. When eviction leaves less than
        // one viewport of content, it hides the additional blank-space deficit.
        // Measure with one viewport of temporary padding, then remove the excess;
        // both writes happen before paint and leave only the required reserve.
        reserve += pane.clientHeight;
        timeline.style.setProperty('--timeline-scroll-reserve', `${reserve}px`);
        reserve = Math.max(0, reserve - (pane.scrollHeight - pane.clientHeight - top));
        timeline.style.setProperty('--timeline-scroll-reserve', `${Math.ceil(reserve)}px`);
      }
      pane.scrollTop = top;
      return;
    }
    pane.scrollTop = previous;
  };
}
