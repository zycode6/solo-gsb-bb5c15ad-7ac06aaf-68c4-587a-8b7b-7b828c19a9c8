// RFC 9110 §13.1.3 If-Range precondition handling.
//
// An If-Range validator is either a single entity-tag or one HTTP-date.
// Range processing continues only when:
//   - the validator is a *strong* entity-tag verbatim-equal to the current
//     strong ETag of the representation (If-Match-style strong comparison),
//     or
//   - the validator is an HTTP-date that is not earlier than the current
//     Last-Modified instant (earlier-than comparison per RFC 9110 §13.1.3).
// Anything else (mismatch, missing resource metadata, weak validator,
// unparseable validator) makes the precondition fail: the recipient then
// ignores Range and sends the full representation.

// RFC 9110 §8.8.3:
//   entity-tag = [ weak ] opaque-tag
//   weak       = %x57.2F   ; "W/", case-sensitive
//   opaque-tag = DQUOTE *etagc DQUOTE
//   etagc      = %x21 / %x23-7E / obs-text
// CR, LF, other controls, DEL and a bare DQUOTE can therefore never occur
// inside a well-formed entity-tag.
const ETAGC_SOURCE = '\\x21\\x23-\\x7e\\x80-\\xff';
export const ENTITY_TAG_RE = new RegExp(`^(?:W/)?"(?:[${ETAGC_SOURCE}])*"$`);
export const STRONG_ENTITY_TAG_RE = new RegExp(`^"(?:[${ETAGC_SOURCE}])*"$`);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_INDEX = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

// HTTP-date (RFC 9110 §5.6.7) = IMF-fixdate / obs-date. Recipients MUST accept
// all three standard formats, even though senders only generate IMF-fixdate:
//
//   IMF-fixdate: Sun, 06 Nov 1994 08:49:37 GMT
//   RFC 850:     Sunday, 06-Nov-94 08:49:37 GMT
//   asctime:     Sun Nov  6 08:49:37 1994
const SHORT_WEEKDAY = '(Sun|Mon|Tue|Wed|Thu|Fri|Sat)';
const LONG_WEEKDAY = '(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)';
const MONTH_NAME = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const TIME_OF_DAY = '(\\d{2}):(\\d{2}):(\\d{2})';

const IMF_FIXDATE_RE = new RegExp(
  `^${SHORT_WEEKDAY}, (\\d{2}) ${MONTH_NAME} (\\d{4}) ${TIME_OF_DAY} GMT$`,
);
const RFC850_DATE_RE = new RegExp(
  `^${LONG_WEEKDAY}, (\\d{2})-${MONTH_NAME}-(\\d{2}) ${TIME_OF_DAY} GMT$`,
);
// date3 = month SP ( 2DIGIT / SP 1DIGIT ): a single-digit day is padded with a
// second space ("Nov  6"), never with a zero and never left bare.
const ASCTIME_DATE_RE = new RegExp(
  `^${SHORT_WEEKDAY} ${MONTH_NAME} (\\d{2}| \\d) ${TIME_OF_DAY} (\\d{4})$`,
);

/**
 * Match any of the three HTTP-date formats, returning the calendar fields
 * (weekday normalised to its three-letter abbreviation) or null.
 */
function matchHttpDate(value) {
  if (typeof value !== 'string') return null;

  let m = IMF_FIXDATE_RE.exec(value);
  if (m) {
    return {
      weekday: m[1],
      day: Number(m[2]),
      month: MONTH_INDEX[m[3]],
      year: Number(m[4]),
      hour: Number(m[5]),
      minute: Number(m[6]),
      second: Number(m[7]),
      twoDigitYear: false,
    };
  }

  m = RFC850_DATE_RE.exec(value);
  if (m) {
    return {
      weekday: m[1].slice(0, 3),
      day: Number(m[2]),
      month: MONTH_INDEX[m[3]],
      year: Number(m[4]),
      hour: Number(m[5]),
      minute: Number(m[6]),
      second: Number(m[7]),
      twoDigitYear: true,
    };
  }

  m = ASCTIME_DATE_RE.exec(value);
  if (m) {
    return {
      weekday: m[1],
      day: Number(m[3]),
      month: MONTH_INDEX[m[2]],
      year: Number(m[7]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: Number(m[6]),
      twoDigitYear: false,
    };
  }

  return null;
}

/**
 * RFC 9110 §5.6.7: a recipient parsing an rfc850-date two-digit year MUST
 * interpret a timestamp that appears to be more than 50 years in the future
 * as the most recent year in the past that had the same last two digits.
 * The year is resolved against the receiver's current UTC year.
 */
function resolveRfc850Year(twoDigitYear, currentYear) {
  let year = Math.floor(currentYear / 100) * 100 + twoDigitYear;
  if (year - currentYear > 50) year -= 100;
  return year;
}

/**
 * Parse a strict HTTP-date (RFC 9110 §5.6.7) into a millisecond timestamp.
 * All three standard formats are accepted: IMF-fixdate, RFC 850 and asctime.
 *
 * Returns null for anything that is not a syntactically and semantically
 * valid HTTP-date: the shape is matched with strict regexes, then the value
 * is reconstructed via Date.UTC to reject impossible dates (e.g. Feb 30),
 * weekdays that do not match the calendar date and out-of-range time fields.
 *
 * @param {string} value
 * @param {Date} [now] reception time; only used to resolve RFC 850 two-digit
 *   years (defaults to the current time)
 */
export function parseHttpDate(value, now = new Date()) {
  const fields = matchHttpDate(value);
  if (fields === null) return null;

  const { weekday, day, month, hour, minute, second } = fields;
  const year = fields.twoDigitYear
    ? resolveRfc850Year(fields.year, now.getUTCFullYear())
    : fields.year;

  if (hour > 23 || minute > 59 || second > 59) return null;

  const time = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(time);

  // Round-trip rejects e.g. "Mon, 31 Feb 2024 ..." and wrong weekdays.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    WEEKDAYS[date.getUTCDay()] !== weekday
  ) {
    return null;
  }
  return time;
}

/**
 * Evaluate an If-Range header against the current representation metadata.
 *
 * @param {string} ifRange      received If-Range field value
 * @param {string} [etag]       current ETag of the resource (strong or weak)
 * @param {string} [lastModified] current Last-Modified as an HTTP-date
 * @param {Date} [now]          reception time for RFC 850 year resolution
 * @returns {{satisfied: boolean, kind: 'etag'|'date', reason: string}}
 *   reason is one of etag-match / etag-mismatch / weak-validator /
 *   date-not-earlier / date-earlier / resource-metadata-missing /
 *   invalid-validator.
 */
export function evaluateIfRange({ ifRange, etag, lastModified, now } = {}) {
  const value = ifRange;
  if (typeof value !== 'string' || value.length === 0) {
    return { satisfied: false, kind: 'etag', reason: 'invalid-validator' };
  }

  // An entity-tag validator starts with DQUOTE (weak ones with the case-
  // sensitive "W/"); anything else must parse as an HTTP-date.
  if (value.charCodeAt(0) === 0x22) {
    if (!STRONG_ENTITY_TAG_RE.test(value)) {
      return { satisfied: false, kind: 'etag', reason: 'invalid-validator' };
    }
    if (typeof etag !== 'string') {
      return { satisfied: false, kind: 'etag', reason: 'resource-metadata-missing' };
    }
    // Verbatim strong comparison: a weak current validator can never match,
    // and no normalisation (whitespace, case, weak prefix) is performed.
    if (!STRONG_ENTITY_TAG_RE.test(etag) || value !== etag) {
      return { satisfied: false, kind: 'etag', reason: 'etag-mismatch' };
    }
    return { satisfied: true, kind: 'etag', reason: 'etag-match' };
  }

  if (value.startsWith('W/')) {
    // RFC 9110: a weak validator in If-Range cannot authorise a partial
    // response; ignore the field entirely.
    return { satisfied: false, kind: 'etag', reason: 'weak-validator' };
  }

  const requestTime = parseHttpDate(value, now);
  if (requestTime === null) {
    return { satisfied: false, kind: 'date', reason: 'invalid-validator' };
  }
  const currentTime = typeof lastModified === 'string' ? parseHttpDate(lastModified, now) : null;
  if (currentTime === null) {
    return { satisfied: false, kind: 'date', reason: 'resource-metadata-missing' };
  }

  // Earlier-than comparison: equal or fresher validators still select the
  // range (the common case is the client echoing Last-Modified verbatim).
  return requestTime < currentTime
    ? { satisfied: false, kind: 'date', reason: 'date-earlier' }
    : { satisfied: true, kind: 'date', reason: 'date-not-earlier' };
}
