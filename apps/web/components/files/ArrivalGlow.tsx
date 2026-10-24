"use client";

import { useState } from "react";
import { arrivalDelay, type ArrivalMark } from "@/lib/arrivals";

/**
 * The arrival tint and verdigris rule, painted behind a row's content. The
 * parent needs `relative isolate`. Key it on `mark.at` so a re-save restarts
 * only this, not the row. The delay is fixed at mount: a list that mounts
 * mid-arrival resumes the fade where it is instead of replaying it.
 */
export function ArrivalGlow({ mark }: { mark: ArrivalMark }) {
  const [delay] = useState(() => arrivalDelay(mark.at, Date.now()));
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 animate-arrival"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}
