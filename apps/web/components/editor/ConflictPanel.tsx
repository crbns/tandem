"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlertIcon, CopyIcon, PencilLineIcon, RotateCcwIcon } from "lucide-react";
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

  // The textarea that had focus just unmounted; move focus somewhere meaningful.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  async function copyMine() {
    try {
      await navigator.clipboard.writeText(mine);
      toast.success("Your text is on the clipboard");
    } catch {
      toast.error("Couldn't copy. Select the text on the left and copy it manually.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert variant="warning" role="alert">
        <CircleAlertIcon />
        <AlertTitle ref={headingRef} tabIndex={-1} className="outline-none">
          {who} saved version {theirs.version} while you were editing. Your changes were not saved.
        </AlertTitle>
        <AlertDescription>
          Nothing has been overwritten. Your text is kept on the left; version {theirs.version} is on the right.
        </AlertDescription>
      </Alert>

      <DiffView
        left={{ title: "Your unsaved changes", content: mine }}
        right={{
          content: theirs.content,
          title: (
            <>
              Version {theirs.version}
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

      <div className="flex flex-wrap gap-2">
        <Button onClick={onKeepMine}>
          <PencilLineIcon />
          Keep my text
        </Button>
        <Button variant="outline" onClick={() => void copyMine()}>
          <CopyIcon />
          Copy my text
        </Button>
        <Button variant="outline" className="text-destructive" onClick={() => setConfirmOpen(true)}>
          <RotateCcwIcon />
          Discard mine &amp; load latest
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        &ldquo;Keep my text&rdquo; does not merge. Your next save will <strong>overwrite</strong> {who}&apos;s
        version {theirs.version}. Copy anything you need from the right-hand column into your text first; it
        stays visible above the editor until you save.
      </p>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard your changes?</DialogTitle>
            <DialogDescription>
              Your unsaved text will be replaced with version {theirs.version}. This can&apos;t be undone. Copy
              your text first if you might need it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                onDiscardMine();
              }}
            >
              Discard and load latest
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
