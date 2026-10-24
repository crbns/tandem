import { Fragment } from "react";
import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";
import type { Crumb } from "@/lib/folders";

/** A path trail. Every item links except the last, which is the current page. */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground">
      {items.map((item, index) => (
        <Fragment key={item.href + index}>
          {index > 0 && <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden />}
          {index === items.length - 1 ? (
            <span aria-current="page" className="truncate text-foreground">
              {item.label}
            </span>
          ) : (
            <Link href={item.href} className="truncate hover:text-foreground">
              {item.label}
            </Link>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
