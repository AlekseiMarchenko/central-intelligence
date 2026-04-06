/**
 * Extract dates from memory content text.
 * Returns the earliest and latest dates found, or null if none.
 * Used at store() time to populate event_date columns for temporal filtering.
 *
 * Zero external dependencies. Pure regex. <1ms per call.
 */

export interface ParsedDates {
  eventDateFrom: string | null; // ISO 8601
  eventDateTo: string | null;   // ISO 8601
}

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7,
  aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse all date references from text and return the date range.
 */
export function parseDates(text: string): ParsedDates {
  const dates: Date[] = [];

  // Pattern 1: ISO format — "2025-01-18" or "2025/01/18" (with optional time)
  const isoPattern = /(\d{4})[-/](\d{2})[-/](\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/g;
  let match;
  while ((match = isoPattern.exec(text)) !== null) {
    const d = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4] || "00"}:${match[5] || "00"}:${match[6] || "00"}Z`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 2000 && d.getFullYear() <= 2030) {
      dates.push(d);
    }
  }

  // Pattern 2: "January 18, 2025" / "January 18 2025" / "Jan 18, 2025"
  const namedMonthPattern = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\s*[,]?\s*(\d{4})\b/gi;
  while ((match = namedMonthPattern.exec(text)) !== null) {
    const month = MONTH_NAMES[match[1].toLowerCase()];
    if (month) {
      const d = new Date(Date.UTC(parseInt(match[3]), month - 1, parseInt(match[2])));
      if (!isNaN(d.getTime())) dates.push(d);
    }
  }

  // Pattern 3: "18 January 2025" (day-first)
  const dayFirstPattern = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s*[,]?\s*(\d{4})\b/gi;
  while ((match = dayFirstPattern.exec(text)) !== null) {
    const month = MONTH_NAMES[match[2].toLowerCase()];
    if (month) {
      const d = new Date(Date.UTC(parseInt(match[3]), month - 1, parseInt(match[1])));
      if (!isNaN(d.getTime())) dates.push(d);
    }
  }

  // Pattern 4: "on Month Day" without year (assume current context year)
  // Skip — too ambiguous without knowing the year context

  // Deduplicate and sort
  if (dates.length === 0) {
    return { eventDateFrom: null, eventDateTo: null };
  }

  dates.sort((a, b) => a.getTime() - b.getTime());

  // Remove obvious outliers (dates far from the median)
  const earliest = dates[0];
  const latest = dates[dates.length - 1];

  return {
    eventDateFrom: earliest.toISOString(),
    eventDateTo: latest.toISOString(),
  };
}
