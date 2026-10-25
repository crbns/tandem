"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <Button type="button" variant="outline" onClick={copy} className="w-fit">
      {state === "copied" ? <CheckIcon /> : <CopyIcon />}
      {state === "copied" ? "Copied" : state === "failed" ? "Select and copy manually" : label}
    </Button>
  );
}
