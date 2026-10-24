"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlertIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import type { Theirs } from "@/lib/editor/saveMachine";
import { actorLabel } from "@/lib/actors";
import { ActorBadge } from "@/components/common/ActorBadge";
import { DiffView } from "@/components/common/DiffView";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ConflictPanelProps {
  mine: string;
  theirs: Theirs;
  onDiscardMine: () => void;
  onKeepMine: () => void;
}

export function ConflictPanel({ mine, theirs, onDiscardMine, onKeepMine }: ConflictPanelProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const headingRef = useRef<HTMLDivElement>(null);
  const who = theirs.updatedBy ? actorLabel(theirs.updatedBy) : "Someone";
  const v = theirs.version;

  // The textarea that had focus just unmounted; move focus somewhere meaningful.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  async function copyMine() {
    try {
      await navigator.clipboard.writeText(mine);
      toast.success("Your changes are on the clipboard");
    } catch {
      toast.error("Couldn't copy. Select your text on the left and copy it manually.");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Alert variant="warning" role="alert">
        <CircleAlertIcon />
        <AlertTitle ref={headingRef} tabIndex={-1} className="outline-none">
          {who} saved version {v} while you were editing
        </AlertTitle>
        <AlertDescription>
          Your changes aren&apos;t saved yet, and nothing has been overwritten. Compare the two versions, then
          choose how to continue.
        </AlertDescription>
      </Alert>

      <DiffView
        left={{
          content: mine,
          title: (
            <>
              Your unsaved changes
              <Button variant="ghost" size="sm" className="ml-auto h-7 px-2" onClick={() => void copyMine()}>
                <CopyIcon />
                Copy
              </Button>
            </>
          ),
        }}
        right={{
          content: theirs.content,
          title: (
            <>
              Version {v}
              {theirs.updatedBy && (
                <>
                  <span className="font-normal text-muted-foreground">by</span>
                  <ActorBadge actor={theirs.updatedBy} />
                </>
              )}
            </>
          ),
        }}
      />

      <section aria-labelledby="conflict-choices" className="flex flex-col gap-3">
        <h2 id="conflict-choices" className="text-sm font-semibold">
          How do you want to continue?
        </h2>
        {/* Both choices lose something, so neither is styled as the default. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col items-start gap-1.5">
            <Button variant="outline" onClick={onKeepMine}>
              Continue with my changes
            </Button>
            <p className="text-sm text-muted-foreground">
              Your next save replaces version {v}. Lines that are only on the right are lost unless you copy them
              into your text first.
            </p>
          </div>
          <div className="flex flex-col items-start gap-1.5">
            <Button variant="outline" onClick={() => setConfirmOpen(true)}>
              Load version {v} instead
            </Button>
            <p className="text-sm text-muted-foreground">
              Your unsaved changes are discarded and version {v} opens in the editor.
            </p>
          </div>
        </div>
      </section>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard your changes and load version {v}?</DialogTitle>
            <DialogDescription>
              Your unsaved changes will be replaced by version {v}. This can&apos;t be undone, so copy your text
              first if you might need it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Keep my changes
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                onDiscardMine();
              }}
            >
              Discard my changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
