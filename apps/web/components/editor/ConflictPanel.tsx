"use client";

import { useState } from "react";
import { CircleAlertIcon, CopyIcon, GitMergeIcon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import type { Theirs } from "@/lib/editor/saveMachine";
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
      <Alert variant="warning">
        <CircleAlertIcon />
        <AlertTitle>
          Version {theirs.version} was saved while you were editing. Your changes were not saved.
        </AlertTitle>
        <AlertDescription>
          Nothing has been overwritten. Your text is kept below. Compare it with the latest version, then choose
          what to do.
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
          <GitMergeIcon />
          Keep editing on top of latest
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
        &ldquo;Keep editing on top of latest&rdquo; keeps your text in the editor. Your next save will replace
        version {theirs.version}, which you&apos;ve now seen.
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
