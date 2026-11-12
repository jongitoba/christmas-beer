import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatScore, parseScoreInput, rank, summarize, toMilli, type Criterion } from '../src/lib/score.ts';

test('toMilli accepts 1–11 with up to 3 decimals', () => {
  assert.equal(toMilli(1), 1000);
  assert.equal(toMilli(11), 11000);
  assert.equal(toMilli(7.345), 7345);
  assert.equal(toMilli(0.1 + 0.2 + 5), 5300); // float noise is fine
});

test('toMilli rejects out of range, too many decimals and non-numbers', () => {
  for (const bad of [0.999, 11.001, 7.3456, -1, NaN, Infinity, '7', null, undefined]) {
    assert.throws(() => toMilli(bad), RangeError, String(bad));
  }
});

test('parseScoreInput accepts comma and dot, empty is null', () => {
  assert.equal(parseScoreInput('7,345'), 7.345);
  assert.equal(parseScoreInput(' 10.5 '), 10.5);
  assert.equal(parseScoreInput('11'), 11);
  assert.equal(parseScoreInput('3,'), 3);
  assert.equal(parseScoreInput(''), null);
  for (const bad of ['abc', '12', '0,5', '7,3456', '1e1', '-3', '7,3,4']) assert.throws(() => parseScoreInput(bad), RangeError, bad);
});

test('formatScore uses Norwegian decimal comma and 3 decimals', () => {
  assert.equal(formatScore(7.5), '7,500');
  assert.equal(formatScore(10.1234), '10,123');
  assert.equal(formatScore(null), '–');
});

const criteria: Criterion[] = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }];
const r = (beerId: number, participantId: number, criterion: string, score: number) => ({ beerId, participantId, criterion, milli: score * 1000 });

test('overall = mean of the per-criterion averages', () => {
  const [s] = summarize([1], [r(1, 1, 'a', 10), r(1, 2, 'a', 6), r(1, 1, 'b', 4), r(1, 2, 'b', 2)], criteria);
  assert.deepEqual(s!.criteria, { a: 8, b: 3 });
  assert.equal(s!.overall, 5.5);
  assert.equal(s!.raterCount, 2);
});

test('missing scores are left out, not counted as zero', () => {
  // Person 2 only scored criterion a.
  const [s] = summarize([1], [r(1, 1, 'a', 10), r(1, 2, 'a', 6), r(1, 1, 'b', 4)], criteria);
  assert.deepEqual(s!.criteria, { a: 8, b: 4 });
  assert.equal(s!.overall, 6);
  // A criterion nobody scored does not drag the overall down.
  const [only] = summarize([2], [r(2, 1, 'a', 9)], criteria);
  assert.deepEqual(only!.criteria, { a: 9, b: null });
  assert.equal(only!.overall, 9);
});

test('a beer without scores has no overall', () => {
  const [s] = summarize([3], [r(1, 1, 'a', 10)], criteria);
  assert.equal(s!.overall, null);
  assert.equal(s!.raterCount, 0);
});

test('rank sorts high to low, shares places on ties to 3 decimals, unscored last', () => {
  const ranked = rank([
    { id: 'c', overall: 5 },
    { id: 'none', overall: null },
    { id: 'a', overall: 9.1234 },
    { id: 'b1', overall: 7.0001 },
    { id: 'b2', overall: 7.0004 },
  ]);
  assert.deepEqual(ranked.map((x) => [x.id, x.place]), [['a', 1], ['b2', 2], ['b1', 2], ['c', 4], ['none', null]]);
});
