'use strict';

// Result retention bound for the online report, independent of finding count.
const MAX_REPORT_WINDOW = 10_000;

/** Keep the earliest capacity findings in stable order using a max heap. */
class BoundedFindingPage {
  constructor(capacity, compare) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_REPORT_WINDOW) {
      throw new RangeError('Invalid reconciliation page capacity');
    }
    this.capacity = capacity;
    this.compare = compare;
    this.total = 0;
    this.entries = [];
  }

  compareEntries(a, b) {
    // Match stable Array.sort when different records have the same sort key.
    return this.compare(a.finding, b.finding) || a.ordinal - b.ordinal;
  }

  push(finding) {
    const entry = { finding, ordinal: this.total++ };
    const heap = this.entries;
    if (heap.length < this.capacity) {
      let index = heap.length;
      heap.push(entry);
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (this.compareEntries(heap[parent], entry) >= 0) break;
        heap[index] = heap[parent];
        index = parent;
      }
      heap[index] = entry;
      return;
    }
    if (this.compareEntries(entry, heap[0]) >= 0) return;

    // Replace the latest retained finding, keeping the largest at the root.
    let index = 0;
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < heap.length && this.compareEntries(heap[child + 1], heap[child]) > 0) {
        child += 1;
      }
      if (this.compareEntries(entry, heap[child]) >= 0) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = entry;
  }

  page(offset, limit) {
    return this.entries.slice()
      .sort((a, b) => this.compareEntries(a, b))
      .slice(offset, offset + limit)
      .map((entry) => entry.finding);
  }
}

module.exports = { BoundedFindingPage, MAX_REPORT_WINDOW };
