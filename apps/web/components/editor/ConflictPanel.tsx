"use client";

import { useMemo, useState } from "react";
import { CircleAlertIcon, CopyIcon, GitMergeIcon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import type { Theirs } from "@/lib/editor/saveMachine";
import { sideBySide, type DiffLine } from "@/lib/editor/lineDiff";
import { ActorBadge } from "@/components/common/ActorBadge";
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
import { cn } from "@/lib/utils";

interface ConflictPanelProps {
  mine: string;
  theirs: Theirs;
  onDiscardMine: () => void;
  onKeepMine: () => void;
}

function Column({
  title,
  lines,
  tone,
}: {
  title: React.ReactNode;
  lines: DiffLine[];
  tone: "mine" | "theirs";
}) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2 text-sm font-medium">{title}</div>
      <pre className="max-h-[55vh] overflow-auto py-2 font-mono text-xs leading-relaxed">
        {lines.length === 0 && <span className="px-3 text-muted-foreground italic">(empty)</span>}
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              "whitespace-pre-wrap px-3",
              line.changed && (tone === "mine" ? "bg-amber-100" : "bg-sky-100"),
            )}
          >
            {line.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function ConflictPanel({ mine, theirs, onDiscardMine, onKeepMine }: ConflictPanelProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const diff = useMemo(() => sideBySide(mine, theirs.content), [mine, theirs.content]);

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

      <div className="grid gap-4 lg:grid-cols-2">
        <Column title="Your unsaved changes" lines={diff.mine} tone="mine" />
        <Column
          title={
            <>
              Version {theirs.version}
              {theirs.updatedBy && (
                <>
                  <span className="font-normal text-muted-foreground">by</span>
                  <ActorBadge actor={theirs.updatedBy} />
                </>
              )}
            </>
          }
          lines={diff.theirs}
          tone="theirs"
        />
      </div>

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
