export interface TextMatchOffset {
  start: number;
  end: number;
}

export const MAX_WINDOW_SEARCH_MATCHES = 2000;

/**
 * Find all non-overlapping, case-insensitive substring match offsets in `text`.
 */
export function findTextMatchOffsets(
  text: string,
  query: string,
  limit: number = MAX_WINDOW_SEARCH_MATCHES,
): TextMatchOffset[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery || limit <= 0) return [];

  const haystack = text.toLowerCase();
  const matches: TextMatchOffset[] = [];
  let cursor = 0;

  while (cursor <= haystack.length - normalizedQuery.length && matches.length < limit) {
    const index = haystack.indexOf(normalizedQuery, cursor);
    if (index === -1) break;
    matches.push({ start: index, end: index + normalizedQuery.length });
    cursor = index + normalizedQuery.length;
  }

  return matches;
}

/**
 * Wrap a navigation step (`+1` or `-1`) around `[0, total - 1]`.
 */
export function stepSearchMatchIndex(
  currentIndex: number,
  delta: 1 | -1,
  totalMatches: number,
): number {
  if (totalMatches <= 0) return 0;
  const clamped = Math.max(0, Math.min(currentIndex, totalMatches - 1));
  return (clamped + delta + totalMatches) % totalMatches;
}
