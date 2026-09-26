import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { parseHttpDate, evaluateIfRange } from '../src/conditional.js';

const app = buildApp();

// Fixed reception instant (2026) so RFC 850 two-digit-year resolution is
// deterministic: the century is taken from the receiving UTC year and any
// result more than 50 years in the future is moved back 100 years.
const NOW = new Date('2026-09-26T12:00:00Z');

// RFC 9110 §5.6.7 example instant, written in each of the three formats.
const IMF = 'Sun, 06 Nov 1994 08:49:37 GMT';
const RFC850 = 'Sunday, 06-Nov-94 08:49:37 GMT';
const ASCTIME = 'Sun Nov  6 08:49:37 1994';
const INSTANT = Date.UTC(1994, 10, 6, 8, 49, 37);

function plan({ size = 1000, range = 'bytes=0-99', lastModified, ifRange, query, method = 'POST' }) {
  const headers = { 'content-type': 'application/json', Range: range };
  if (ifRange !== undefined) headers['If-Range'] = ifRange;
  return app.inject({
    method,
    url: query ?? '/plan',
    headers,
    payload: method === 'POST' ? JSON.stringify({ size, ...(lastModified ? { lastModified } : {}) }) : undefined,
  });
}

// ---------- parseHttpDate: the three standard formats ----------

test('all three HTTP-date formats parse to the same instant', () => {
  assert.equal(parseHttpDate(IMF, NOW), INSTANT);
  assert.equal(parseHttpDate(RFC850, NOW), INSTANT);
  assert.equal(parseHttpDate(ASCTIME, NOW), INSTANT);
});

test('asctime accepts a space-padded single-digit day and a two-digit day', () => {
  assert.equal(parseHttpDate('Sun Nov  6 08:49:37 1994', NOW), INSTANT);
  assert.equal(parseHttpDate('Wed Nov 16 08:49:37 1994', NOW), Date.UTC(1994, 10, 16, 8, 49, 37));
  assert.equal(parseHttpDate('Sun Nov 06 08:49:37 1994', NOW), INSTANT);
});

test('RFC 850 two-digit year resolves against the receiving UTC year', () => {
  const cases = [
    ['26', 'Thursday, 01-Jan-26 00:00:00 GMT', 2026],
    ['76', 'Wednesday, 01-Jan-76 00:00:00 GMT', 2076], // exactly 50 years ahead: kept
    ['94', 'Saturday, 01-Jan-94 00:00:00 GMT', 1994],
    ['00', 'Saturday, 01-Jan-00 00:00:00 GMT', 2000],
  ];
  for (const [yy, value, expectedYear] of cases) {
    const time = parseHttpDate(value, NOW);
    assert.equal(new Date(time).getUTCFullYear(), expectedYear, `year ${yy}`);
  }
});

test('RFC 850 year more than 50 years in the future is moved back 100 years', () => {
  // 2077 would be 51 years ahead of 2026, so the year 77 means 1977.
  const time = parseHttpDate('Saturday, 01-Jan-77 00:00:00 GMT', NOW);
  assert.equal(new Date(time).getUTCFullYear(), 1977);
  // At a 2040 reception time 2077 is only 37 years ahead, so 77 stays 2077.
  const time2 = parseHttpDate('Friday, 01-Jan-77 00:00:00 GMT', new Date('2040-01-01T00:00:00Z'));
  assert.equal(new Date(time2).getUTCFullYear(), 2077);
});

test('legacy formats reject wrong weekdays, impossible dates and bad times', () => {
  for (const bad of [
    'Monday, 06-Nov-94 08:49:37 GMT',   // 6 Nov 1994 was a Sunday
    'Mon Nov  6 08:49:37 1994',         // wrong weekday, asctime shape
    'Sunday, 30-Feb-94 08:49:37 GMT',   // impossible calendar date
    'Sun Feb 30 08:49:37 1994',         // impossible calendar date, asctime
    'Sunday, 06-Nov-94 24:49:37 GMT',   // hour out of range
    'Sunday, 06-Nov-94 08:49:60 GMT',   // second out of range
    'Sun Nov  6 08:49:61 1994',         // second out of range, asctime
  ]) {
    assert.equal(parseHttpDate(bad, NOW), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('near-miss legacy shapes are not accepted', () => {
  for (const bad of [
    'Sun, 06 Nov 94 08:49:37 GMT',      // IMF shape with a two-digit year
    'Sunday, 06 Nov 1994 08:49:37 GMT', // long weekday in IMF shape
    'Sun, 06-Nov-94 08:49:37 GMT',      // short weekday in RFC 850 shape
    'Sunday, 06-Nov-1994 08:49:37 GMT', // four-digit year in RFC 850 shape
    'Sun Nov 6 08:49:37 1994',          // single-digit day without the pad space
    'Sun Nov 06 08:49:37 94',           // two-digit year in asctime shape
    'sunday, 06-Nov-94 08:49:37 GMT',   // weekday/month names are case-sensitive
    'Sunday, 06-Nov-94 08:49:37',       // missing GMT
    'Sun Nov  6 08:49:37 1994 GMT',     // asctime carries no zone token
  ]) {
    assert.equal(parseHttpDate(bad, NOW), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ---------- evaluateIfRange: comparison by parsed instant ----------

test('If-Range and Last-Modified in different formats compare by instant', () => {
  const equal = evaluateIfRange({ ifRange: RFC850, lastModified: IMF, now: NOW });
  assert.deepEqual(equal, { satisfied: true, kind: 'date', reason: 'date-not-earlier' });

  const asctimeEqual = evaluateIfRange({ ifRange: ASCTIME, lastModified: IMF, now: NOW });
  assert.equal(asctimeEqual.satisfied, true);

  const earlier = evaluateIfRange({ ifRange: 'Sun Nov  6 08:49:36 1994', lastModified: IMF, now: NOW });
  assert.deepEqual(earlier, { satisfied: false, kind: 'date', reason: 'date-earlier' });

  const later = evaluateIfRange({ ifRange: 'Sunday, 06-Nov-94 08:49:38 GMT', lastModified: IMF, now: NOW });
  assert.equal(later.satisfied, true);
});

// ---------- POST/GET /plan with legacy HTTP-dates ----------

test('RFC 850 If-Range equal to Last-Modified keeps the 206 partial plan', async () => {
  const res = await plan({ lastModified: IMF, ifRange: RFC850 });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.decision, 'partial');
  assert.equal(body.condition.validatorKind, 'date');
  assert.equal(body.condition.reason, 'date-not-earlier');
});

test('asctime If-Range equal to Last-Modified keeps the 206 partial plan', async () => {
  const res = await plan({ lastModified: IMF, ifRange: ASCTIME });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().condition.reason, 'date-not-earlier');
});

test('legacy If-Range earlier than Last-Modified still downgrades to 200 full', async () => {
  const res = await plan({ lastModified: IMF, ifRange: 'Sunday, 06-Nov-94 08:49:36 GMT' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.decision, 'full');
  assert.equal(body.condition.reason, 'date-earlier');
});

test('lastModified metadata is accepted in RFC 850 and asctime formats', async () => {
  for (const lastModified of [RFC850, ASCTIME]) {
    const res = await plan({ lastModified, ifRange: IMF });
    assert.equal(res.statusCode, 206, `expected 206 for ${JSON.stringify(lastModified)}`);
    const body = res.json();
    assert.equal(body.condition.reason, 'date-not-earlier');
    assert.equal(body.resource.lastModified, lastModified);
    assert.equal(body.responseHeaders['Last-Modified'], lastModified);
  }
});

test('GET /plan accepts a legacy lastModified query parameter', async () => {
  const res = await plan({
    method: 'GET',
    query: `/plan?size=1000&lastModified=${encodeURIComponent(RFC850)}`,
    ifRange: ASCTIME,
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().decision, 'partial');
});

test('invalid legacy If-Range dates fail the precondition instead of 400', async () => {
  for (const bad of ['Monday, 06-Nov-94 08:49:37 GMT', 'Sun Nov 6 08:49:37 1994']) {
    const res = await plan({ lastModified: IMF, ifRange: bad });
    assert.equal(res.statusCode, 200, `expected 200 for ${JSON.stringify(bad)}`);
    assert.equal(res.json().condition.reason, 'invalid-validator');
  }
});

test('invalid legacy lastModified metadata is rejected with 400', async () => {
  for (const bad of ['Monday, 06-Nov-94 08:49:37 GMT', 'Sun Nov 6 08:49:37 1994']) {
    const res = await plan({ lastModified: bad });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(res.json().code, 'INVALID_LAST_MODIFIED');
  }
});
