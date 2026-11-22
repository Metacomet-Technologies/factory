import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./button";

/** Newer / Older paging for a newest-first list. Hidden while everything fits on one page. */
export function Pager({
  label,
  page,
  pages,
  onNewer,
  onOlder,
  busy = false,
}: {
  label: string;
  page: number;
  /** Total pages when known; cursor-paged lists only know whether an older page exists. */
  pages?: number;
  onNewer?: (() => void) | undefined;
  onOlder?: (() => void) | undefined;
  busy?: boolean;
}) {
  if (page === 1 && !onOlder) return null;
  return (
    <nav className="pager" aria-label={label}>
      <Button variant="outline" size="sm" disabled={busy || !onNewer} onClick={onNewer}>
        <ChevronLeft aria-hidden="true" />
        Newer
      </Button>
      <span className="muted" aria-live="polite">
        Page {page}
        {pages ? ` of ${pages}` : ""}
      </span>
      <Button variant="outline" size="sm" disabled={busy || !onOlder} onClick={onOlder}>
        Older
        <ChevronRight aria-hidden="true" />
      </Button>
    </nav>
  );
}
