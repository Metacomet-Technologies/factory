import { useState } from "react";

/** Client-side pages over a list that is already loaded, newest first. */
export function usePages<T>(items: T[], size: number) {
  const [wanted, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(items.length / size));
  // A shorter list (a narrower range) keeps the reader on its last page, not an empty one.
  const page = Math.min(wanted, pages);
  return {
    rows: items.slice((page - 1) * size, page * size),
    page,
    pages,
    newer: page > 1 ? () => setPage(page - 1) : undefined,
    older: page < pages ? () => setPage(page + 1) : undefined,
  };
}

/**
 * Cursor pages for an API list that returns a `before` cursor: the cursors already followed
 * form a stack, so Newer steps back one page instead of jumping to the first.
 */
export function useCursorPages() {
  const [cursors, setCursors] = useState<string[]>([""]);
  return {
    cursor: cursors[cursors.length - 1]!,
    page: cursors.length,
    older: (next: string) => setCursors((stack) => [...stack, next]),
    newer: cursors.length > 1 ? () => setCursors((stack) => stack.slice(0, -1)) : undefined,
  };
}
