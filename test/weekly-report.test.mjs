// Search Readiness i9: the weekly report's verdict rules and its week split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdictOf, weeks } from '../scripts/weekly-outcome-report.mjs';

const base = { impressions: 100, prevImpressions: 100, clicks: 5, sitemapUrls: 3, indexed: 3, notIndexed: 0 };

test('verdict rules', () => {
  const cases = [
    ['a steady week is green', base, 'green'],
    ['a 60% fall is red', { ...base, impressions: 40 }, 'red'],
    ['a 25% fall is amber', { ...base, impressions: 75 }, 'amber'],
    ['nothing indexed is red', { ...base, indexed: 0, notIndexed: 3 }, 'red'],
    ['more not-indexed than indexed is amber', { ...base, indexed: 1, notIndexed: 2 }, 'amber'],
    ['a first week with no prior week is green', { ...base, prevImpressions: null }, 'green'],
    ['no data is red, never green', { ...base, missing: ['data/search-console/gsc_truth.json'] }, 'red'],
  ];
  for (const [what, input, want] of cases) {
    const { verdict, reasons } = verdictOf(input);
    assert.equal(verdict, want, what);
    assert.ok(reasons.length, what);
  }
});

test('weeks: the newest 7 days against the 7 before, and no prior week until there are 14', () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, clicks: 1, impressions: i < 7 ? 10 : 5 }));
  const { week, prev } = weeks(rows.reverse());
  assert.deepEqual([week.start, week.end, week.impressions, prev.impressions], ['2026-11-08', '2026-11-14', 35, 70]);
  assert.equal(weeks(rows.slice(0, 10)).prev, null);
});
