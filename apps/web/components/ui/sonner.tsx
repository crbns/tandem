"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster(props: ToasterProps) {
  return <Sonner theme="light" className="toaster group" richColors {...props} />;
}

export { Toaster };
