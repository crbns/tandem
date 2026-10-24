"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

/** Toasts on the world's paper: card ground, rule border, ink text. */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast: "!bg-card !border-border !text-foreground !rounded-md !shadow-md font-sans",
          description: "!text-muted-foreground",
          actionButton: "!bg-primary !text-primary-foreground !rounded-sm !font-semibold",
          success: "[&_[data-icon]]:!text-archive",
          error: "[&_[data-icon]]:!text-destructive",
          info: "[&_[data-icon]]:!text-archive",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
