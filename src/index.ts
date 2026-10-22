interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Shared "count records by a named date field over a year or range" helper —
 * fleet #3170.
 *
 * WHY THIS EXISTS. Four baked-table packs (ny-omig-exclusions,
 * tx-medical-exclusions, ca-medical-exclusions, fl-medical-exclusions) each
 * hold thousands of rows and each had only a list-wide total — no way to
 * answer "how many took effect in year Y" without a caller paging through
 * every row itself. A benchmark probe (fleet #3170/#3149) asked exactly that
 * question against two of them and both returned the SAME list-wide total on
 * every one of 7-8 rounds; the model ran out of rounds and refused rather
 * than get a wrong number. This is the one piece of that fix every pack
 * shares: parsing `year` or `start_date`/`end_date` into an inclusive
 * YYYY-MM-DD range, or a NAMED reason when the input can't be turned into
 * one. It deliberately never returns a silent zero for a bad argument —
 * root CLAUDE.md's silent-zero policy applies to a malformed count request
 * exactly as it does to an upstream outage.
 *
 * WHAT IT DOES NOT DO. It does not touch the rows — each pack's own ISO date
 * field (already YYYY-MM-DD in every one of these four) is filtered by plain
 * string comparison, which is correct for YYYY-MM-DD strings and avoids a
 * Date() parse / timezone trap entirely. Each pack is responsible for saying
 * which of its own fields it counted (data varies: NY/TX/CA have exactly one
 * exclusion-date field each; FL additionally splits "all sanction orders" vs
 * "participation exclusions" within the matched range).
 */

interface DateRange {
  /** Inclusive start date, YYYY-MM-DD. */
  start: string;
  /** Inclusive end date, YYYY-MM-DD. */
  end: string;
  /** Human label for the range, e.g. "2025" or "2024-06-01 to 2025-06-01". */
  label: string;
}

interface DateRangeError {
  error: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads `args.year`, `args.start_date` and `args.end_date` and returns:
 *   - `null` if none were passed (no date-range count was requested at all —
 *     the caller should fall through to its normal, non-counting response);
 *   - `{ error }` if something WAS passed but can't be turned into a valid
 *     range (bad format, start after end, year out of a sane bound) — the
 *     caller must surface this as a named reason, never as a zero count;
 *   - `{ start, end, label }` otherwise.
 *
 * start_date/end_date, if either is present, take precedence over `year`
 * (an explicit range is a more specific request than a calendar year).
 */
function parseYearOrDateRange(args: Record<string, unknown>): DateRange | DateRangeError | null {
  const startRaw = typeof args.start_date === 'string' ? args.start_date.trim() : '';
  const endRaw = typeof args.end_date === 'string' ? args.end_date.trim() : '';
  const yearRaw = args.year;
  const yearGiven = yearRaw !== undefined && yearRaw !== null && yearRaw !== '';

  if (!startRaw && !endRaw && !yearGiven) return null;

  if (startRaw || endRaw) {
    if (!DATE_RE.test(startRaw) || !DATE_RE.test(endRaw)) {
      return {
        error:
          `start_date and end_date must BOTH be present and in YYYY-MM-DD form ` +
          `(got start_date=${startRaw ? JSON.stringify(startRaw) : '(missing)'}, end_date=${endRaw ? JSON.stringify(endRaw) : '(missing)'}).`,
      };
    }
    if (startRaw > endRaw) {
      return { error: `start_date (${startRaw}) is after end_date (${endRaw}).` };
    }
    return { start: startRaw, end: endRaw, label: startRaw === endRaw ? startRaw : `${startRaw} to ${endRaw}` };
  }

  const year = Math.floor(Number(yearRaw));
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    return { error: `year must be a 4-digit calendar year between 1900 and 2100 (got ${JSON.stringify(yearRaw)}).` };
  }
  return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
}

function isDateRangeError(r: DateRange | DateRangeError | null): r is DateRangeError {
  return r != null && typeof (r as DateRangeError).error === 'string';
}

/** Inclusive YYYY-MM-DD membership test; `null`/empty dates never match. */
function inRange(date: string | null | undefined, range: DateRange): boolean {
  return Boolean(date) && (date as string) >= range.start && (date as string) <= range.end;
}

const DATE_RANGE_ARG_SCHEMA = {
  year: {
    type: 'number' as const,
    description: 'Count records whose date field falls in this calendar year (e.g. 2025), counted over the WHOLE list, not a page. Ignored if start_date/end_date are given.',
  },
  start_date: {
    type: 'string' as const,
    description: 'Inclusive range start, YYYY-MM-DD. Use with end_date for a custom date range instead of a calendar year.',
  },
  end_date: {
    type: 'string' as const,
    description: 'Inclusive range end, YYYY-MM-DD. Use with start_date for a custom date range instead of a calendar year.',
  },
};
/**
 * Illinois Medicaid provider sanctions screening: the Illinois Department of
 * Healthcare and Family Services (HFS) Office of Inspector General's
 * Provider Sanctions list. State-level counterpart to the federal HHS OIG
 * LEIE (leie pack) and sibling of tx/ny/ca/fl-medical-exclusions.
 *
 * SOURCE AND SHAPE. HFS OIG publishes the list through its provider
 * sanctions search portal (3,273 rows at capture). Each row is a provider
 * name, license number, NPI, provider type, an optional affiliation (the
 * business a sanctioned individual is tied to), the action date and the
 * action type: Terminated, Barred, Exclusion, Suspended or Voluntary
 * Withdrawal. There is NO per-record reason text and NO date of birth.
 *
 * BAKED, NOT LIVE. The portal needs a session cookie and an anti-forgery
 * token before it will page, so the list is copied by
 * scripts/bake-index.mjs, registered in
 * workers/gateway/src/pack-baked-indexes.json, uploaded to KV at deploy and
 * injected as `args._bakedIndex` (fleet #2754). NEVER value-import
 * ./il-hfs-index-data.js here: only the type-only import below.
 *
 * PERSONAL DATA. The portal also publishes street address, city, state and
 * zip. They are dropped at ingest and are not in this pack at all.
 *
 * MATCHING. An NPI or license match identifies a provider. A name match,
 * even an exact one, is a CANDIDATE: the list has no date of birth.
 *
 * Keyless.
 */
import type { IlHfsRow } from './il-hfs-index-data.js';

let ROWS: IlHfsRow[] = [];
let DATA_AS_OF = '';
let CAPTURED_AT = '';
let TOTAL_ROWS = 0;

function ensureIndex(args: Record<string, unknown>): void {
  if (ROWS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const rows = idx?.IL_HFS_ROWS;
  if (!Array.isArray(rows) || rows.length === 0) {
    // Loud on purpose: "no sanction found" from an empty table would be
    // indistinguishable from a real clean screening result.
    throw new Error(
      `il-medical-exclusions: the baked Illinois HFS OIG provider sanctions index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad query. Retry shortly.',
    );
  }
  ROWS = rows as IlHfsRow[];
  DATA_AS_OF = String(idx?.IL_HFS_DATA_AS_OF ?? '');
  CAPTURED_AT = String(idx?.IL_HFS_CAPTURED_AT ?? '');
  TOTAL_ROWS = Number(idx?.IL_HFS_TOTAL_ROWS ?? ROWS.length);
}

const SOURCE_LABEL = 'Illinois Department of Healthcare and Family Services (HFS), Office of Inspector General: Provider Sanctions list';
const SOURCE_PAGE = 'https://hfs.illinois.gov/oig/sanctionslist.html';

const SCOPE_CAVEAT =
  'This list carries the action type and action date but no per-record reason and no date of birth. It includes providers who voluntarily withdrew from the programme as well as those sanctioned (action_type says which). HFS publishes no reinstatement field, so this pack does not claim a provider is "currently" sanctioned beyond HFS still listing them at data_as_of.';

const NOT_AN_ANSWER =
  'Name matches are CANDIDATES, not identifications: the list has no date of birth to tell same-named providers apart. Only an NPI or license-number match identifies a specific provider. Confirm a name match against NPI or license before acting on it.';

const OTHER_LISTS =
  'This checks the Illinois HFS OIG list only. It does not cover the federal HHS OIG LEIE (leie pack), SAM exclusions, or any other state list (see ny-omig-exclusions, tx-medical-exclusions, ca-medical-exclusions, fl-medical-exclusions).';

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}
function isTenDigitNpi(s: string): boolean {
  return /^\d{10}$/.test(s);
}

type MatchType = 'npi_match' | 'license_match' | 'name_candidate_exact' | 'name_candidate_partial';

const MATCH_MEANING: Record<MatchType, string> = {
  npi_match: "The NPI matched exactly against this provider's listed NPI. An NPI identifies one provider, so this is an identification.",
  license_match: 'The license number matched exactly. A license number identifies one provider, so this is an identification.',
  name_candidate_exact: 'The name matched exactly, but the list has no date of birth to confirm it is the same person. Confirm with NPI or license number before acting.',
  name_candidate_partial: 'The name is a partial match (every query word appears in the listed name or affiliation). A lead to check, not a finding. Confirm with NPI or license number.',
};

function shape(r: IlHfsRow, matchType: MatchType) {
  return {
    provider_name: r.provider_name,
    provider_type: r.provider_type,
    affiliation: r.affiliation,
    license_number: r.license_number,
    npi: r.npi,
    action_type: r.action_type,
    action_date: r.action_date,
    match_type: matchType,
    what_that_means: MATCH_MEANING[matchType],
  };
}

async function checkExclusion(args: Record<string, unknown>) {
  const nameRaw = typeof args.name === 'string' ? args.name.trim() : '';
  const npiRaw = typeof args.npi === 'string' ? digitsOnly(args.npi) : '';
  const licenseRaw = typeof args.license === 'string' ? args.license.trim() : '';
  const licenseDigits = licenseRaw ? digitsOnly(licenseRaw) : '';

  if (!nameRaw && !npiRaw && !licenseRaw) {
    return {
      found: false,
      reason: 'no_query',
      hint: 'Pass name (the provider or business to screen), and/or npi, and/or license. An NPI or license match is an identification; a name match is a lead.',
      source: SOURCE_LABEL,
      source_page: SOURCE_PAGE,
      data_as_of: DATA_AS_OF,
    };
  }

  const limit = Math.max(1, Math.min(50, Math.floor(typeof args.limit === 'number' ? args.limit : 10)));
  const screened = { name: nameRaw || null, npi: npiRaw || null, license: licenseRaw || null };

  const npiMatches = npiRaw && isTenDigitNpi(npiRaw) ? ROWS.filter((r) => r.npi && digitsOnly(r.npi) === npiRaw) : [];
  const licenseMatches = licenseDigits
    ? ROWS.filter((r) => r.license_number && digitsOnly(r.license_number).length > 0 && digitsOnly(r.license_number).replace(/^0+/, '') === licenseDigits.replace(/^0+/, ''))
    : [];

  const identitySeen = new Set<IlHfsRow>();
  const identityResults: ReturnType<typeof shape>[] = [];
  for (const r of npiMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'npi_match'));
  }
  for (const r of licenseMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'license_match'));
  }

  let nameResults: ReturnType<typeof shape>[] = [];
  if (nameRaw) {
    const qNorm = normalize(nameRaw);
    const qTokens = qNorm.split(' ').filter(Boolean);
    const exact: ReturnType<typeof shape>[] = [];
    const partial: ReturnType<typeof shape>[] = [];
    for (const r of ROWS) {
      if (identitySeen.has(r)) continue;
      const nameNorm = r.provider_name ? normalize(r.provider_name) : '';
      const affNorm = r.affiliation ? normalize(r.affiliation) : '';
      // Order-insensitive exact: same multiset of words ("SMITH JOHN" == "John Smith").
      const sameWords = nameNorm && [...nameNorm.split(' ')].sort().join(' ') === [...qTokens].sort().join(' ');
      if (nameNorm && (qNorm === nameNorm || sameWords)) {
        exact.push(shape(r, 'name_candidate_exact'));
      } else if (qTokens.length > 0 && qTokens.every((t) => nameNorm.includes(t) || affNorm.includes(t))) {
        partial.push(shape(r, 'name_candidate_partial'));
      }
    }
    nameResults = [...exact, ...partial];
  }

  const combined = [...identityResults, ...nameResults];
  const matches = combined.slice(0, limit);

  if (matches.length === 0) {
    return {
      found: false,
      result: 'No match found on the Illinois HFS OIG Provider Sanctions list for that provider.',
      filters_tried: screened,
      caveat: `${OTHER_LISTS} ${SCOPE_CAVEAT}`,
      source: SOURCE_LABEL,
      source_page: SOURCE_PAGE,
      data_as_of: DATA_AS_OF,
    };
  }

  const byType: Record<string, number> = {};
  for (const m of combined) byType[m.action_type ?? 'unspecified'] = (byType[m.action_type ?? 'unspecified'] ?? 0) + 1;

  return {
    found: true,
    screened,
    total_matches: combined.length,
    identification_matches: identityResults.length,
    name_candidate_matches: nameResults.length,
    matches_by_action_type: byType,
    returned: matches.length,
    truncated: combined.length > limit,
    matches,
    not_an_identification: NOT_AN_ANSWER,
    scope_caveat: SCOPE_CAVEAT,
    source: SOURCE_LABEL,
    source_page: SOURCE_PAGE,
    data_as_of: DATA_AS_OF,
  };
}

async function coverage(args: Record<string, unknown>) {
  const dates = ROWS.map((r) => r.action_date).filter((d): d is string => Boolean(d)).sort();
  const byType: Record<string, number> = {};
  for (const r of ROWS) byType[r.action_type ?? 'unspecified'] = (byType[r.action_type ?? 'unspecified'] ?? 0) + 1;

  // Date-range counting (same convention as the sibling state packs, fleet
  // #3170): the counted field is action_date, HFS's "Action Date", the date
  // the sanction/termination/withdrawal was recorded.
  const range = parseYearOrDateRange(args);
  if (isDateRangeError(range)) {
    return {
      found: false,
      reason: 'invalid_date_range',
      hint: range.error,
      source: SOURCE_LABEL,
      source_page: SOURCE_PAGE,
      data_as_of: DATA_AS_OF,
    };
  }
  if (range) {
    const inWin = ROWS.filter((r) => inRange(r.action_date, range));
    const winByType: Record<string, number> = {};
    for (const r of inWin) winByType[r.action_type ?? 'unspecified'] = (winByType[r.action_type ?? 'unspecified'] ?? 0) + 1;
    return {
      found: true,
      mode: 'date_range_count',
      count: inWin.length,
      count_by_action_type: winByType,
      date_field_counted: 'action_date, HFS\'s "Action Date" (when the sanction, termination, exclusion, suspension or voluntary withdrawal was recorded).',
      range: { start: range.start, end: range.end, label: range.label },
      counted_over: `the whole list (${TOTAL_ROWS} rows), not a page`,
      total_rows_all_time: TOTAL_ROWS,
      oldest_action_date: dates[0] ?? null,
      newest_action_date: dates[dates.length - 1] ?? null,
      data_as_of: DATA_AS_OF,
      index_captured_at: CAPTURED_AT,
      scope_caveat: SCOPE_CAVEAT,
      source: SOURCE_LABEL,
      source_page: SOURCE_PAGE,
    };
  }

  return {
    found: true,
    total_rows: TOTAL_ROWS,
    rows_by_action_type: byType,
    with_npi: ROWS.filter((r) => r.npi).length,
    with_license_number: ROWS.filter((r) => r.license_number).length,
    with_affiliation: ROWS.filter((r) => r.affiliation).length,
    distinct_provider_types: new Set(ROWS.map((r) => r.provider_type).filter(Boolean)).size,
    oldest_action_date: dates[0] ?? null,
    newest_action_date: dates[dates.length - 1] ?? null,
    data_as_of: DATA_AS_OF,
    index_captured_at: CAPTURED_AT,
    scope_caveat: SCOPE_CAVEAT,
    source: SOURCE_LABEL,
    source_page: SOURCE_PAGE,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'il_medical_check_exclusion',
    description:
      'Is this healthcare provider sanctioned or excluded from the Illinois Medicaid program? Screens a person or business name, an NPI, and/or a license number against the Illinois Department of Healthcare and Family Services (HFS) Office of Inspector General Provider Sanctions list: the state-level counterpart to the federal HHS OIG LEIE (leie pack) for Illinois, and sibling of tx_medical_check_exclusion, ny_omig_check_exclusion, ca_medical_check_exclusion and fl_medical_check_exclusion. '
      + 'Answers "is this provider barred from Illinois Medicaid", "check this NPI against the Illinois sanctions list", or pre-payment/credentialing screening for an Illinois Medicaid provider. '
      + 'An NPI or license-number match is an IDENTIFICATION; a name match, even an exact one, is a CANDIDATE lead only (the list has no date of birth). Each match carries the action type (Terminated, Barred, Exclusion, Suspended, Voluntary Withdrawal), the action date, provider type and any affiliated business. The response leads with counts by action type. No street addresses are served. Sourced from the Illinois HFS OIG, keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Provider or business name to screen, e.g. "Alrifai Tamer" or "Royal Transportation". Any word order.' },
        npi: { type: 'string', description: "The provider's 10-digit NPI, if known. An NPI match is an identification. Always pass it when known." },
        license: { type: 'string', description: 'Illinois professional license number, if known. A license match is an identification.' },
        limit: { type: 'number', description: 'Maximum matches to return (default 10, max 50).' },
      },
    },
  },
  {
    name: 'il_medical_exclusion_coverage',
    description:
      'What the Illinois HFS OIG Provider Sanctions list covers and how current it is: total rows, counts by action type (Terminated, Barred, Exclusion, Suspended, Voluntary Withdrawal), how many carry an NPI or license number, oldest and newest action date, and the capture date. Use to check the screening data is fresh enough before a compliance decision. '
      + 'Pass year (e.g. 2025) or start_date/end_date to instead COUNT how many sanction actions have an action date in that year or range, counted over the whole list rather than a page, with the count split by action type. The response names the date field counted (action_date, HFS\'s Action Date). Sourced from the Illinois HFS OIG, keyless.',
    inputSchema: { type: 'object' as const, properties: { ...DATE_RANGE_ARG_SCHEMA } },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'il_medical_check_exclusion':
      return checkExclusion(args);
    case 'il_medical_exclusion_coverage':
      return coverage(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
