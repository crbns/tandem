"use client";

import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BotIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { useMockControls, useTandemApi, type Actor, type FileDetail } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { useSession } from "@/lib/auth/useSession";
import { actorLabel, humanActorId } from "@/lib/actors";
import {
  canSave,
  draftToStash,
  initSaveState,
  saveReducer,
  type SaveState,
  type Theirs,
} from "@/lib/editor/saveMachine";
import { performSave } from "@/lib/editor/performSave";
import { clearDraftStash, readDraftStash, stashDraft } from "@/lib/editor/draftStash";
import { isMarkdown } from "@/lib/files";
import { MarkdownEditor, type EditorView } from "@/components/editor/MarkdownEditor";
import { SaveBar } from "@/components/editor/SaveBar";
import { ConflictPanel } from "@/components/editor/ConflictPanel";
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

const SIMULATED_AGENT: Actor = { actorType: "agent", actorId: "agent_claude", actorName: "Claude" };

/**
 * Restore a stashed draft (lost session, navigation). We keep the stashed
 * `baseVersion`: if the file moved on meanwhile, the next save conflicts and
 * the user sees the newer version instead of silently overwriting it.
 */
function initialState(file: FileDetail, stash: ReturnType<typeof readDraftStash>): SaveState {
  const fresh = initSaveState(file.content ?? "", file.version);
  if (!stash || stash.draft === fresh.base) return fresh;
  return { ...fresh, baseVersion: stash.baseVersion, draft: stash.draft, phase: { kind: "dirty" } };
}

interface FileEditorProps {
  file: FileDetail;
  historyHref: string;
}

export function FileEditor({ file, historyHref }: FileEditorProps) {
  const api = useTandemApi();
  const mock = useMockControls();
  const { user } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const userKey = user?.email ?? "anonymous";

  const [stash] = useState(() => readDraftStash(userKey, file.id));
  const [state, dispatch] = useReducer(saveReducer, undefined, () => initialState(file, stash));
  const [lastEdited, setLastEdited] = useState({ actor: file.updatedBy, at: file.updatedAt });
  const [view, setView] = useState<EditorView>("split");
  // After "Keep my text": the version the next save will replace, kept visible until then.
  const [replacing, setReplacing] = useState<Theirs | null>(null);
  const [returnFocus, setReturnFocus] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const readOnly = !file.permissions.canEdit;
  const { phase } = state;

  const restored = stash !== null && stash.draft !== (file.content ?? "");
  const toastedRestore = useRef(false);
  useEffect(() => {
    if (!restored || toastedRestore.current) return;
    toastedRestore.current = true;
    toast.info("Restored your unsaved changes.");
  }, [restored]);

  // Persist unsaved work on every change, so losing the session mid-edit (the
  // layout unmounts us and redirects to sign-in) or navigating away can't drop it.
  const pending = draftToStash(state);
  useEffect(() => {
    if (pending) stashDraft(userKey, file.id, pending);
    else clearDraftStash(userKey, file.id);
  }, [userKey, file.id, pending?.draft, pending?.baseVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshLastEdited = () => {
    api.readFile(file.id).then(
      (latest) => setLastEdited({ actor: latest.updatedBy, at: latest.updatedAt }),
      () => {}, // cosmetic; keep the previous attribution
    );
  };

  async function save() {
    if (readOnly || !canSave(state)) return;
    const { baseVersion, draft } = state;
    dispatch({ type: "SAVE" });
    const event = await performSave(api, file.id, baseVersion, draft);
    dispatch(event);

    if (event.type === "SAVE_OK") {
      toast.success(`Saved as version ${event.version}`);
      setReplacing(null);
      setLastEdited({
        actor: {
          actorType: "human",
          actorId: humanActorId(user?.email ?? "unknown"),
          actorName: user?.name ?? "You",
        },
        at: Date.now(),
      });
    } else if (event.type === "SAVE_CONFLICT") {
      // The bar should name who saved the version we just collided with.
      if (event.theirs.updatedBy) setLastEdited({ actor: event.theirs.updatedBy, at: Date.now() });
      refreshLastEdited();
    } else if (event.type === "SAVE_ERROR" && event.code === "UNAUTHENTICATED") {
      // The draft is already stashed by the effect above.
      router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
    }
  }

  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
  });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKeyDown(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const hasUnsaved = pending !== null;
  useEffect(() => {
    if (!hasUnsaved) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // older Safari only prompts when this is set
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsaved]);

  const canDiscard = !readOnly && (phase.kind === "dirty" || phase.kind === "error") && state.draft !== state.base;

  async function simulateAgentEdit() {
    if (!mock) return;
    const head = await mock.readFile(file.id);
    const stamp = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    mock.__simulateExternalEdit(
      file.id,
      `${head.content ?? ""}\n> Claude updated this file through MCP at ${stamp} (simulated).\n`,
      SIMULATED_AGENT,
    );
    toast(`Claude saved version ${head.version + 1} (simulated)`, {
      description: "This tab hasn't seen it yet. Edit and save to see the conflict flow.",
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <SaveBar
        version={state.baseVersion}
        phase={phase.kind}
        lastEditedBy={lastEdited.actor}
        lastEditedAt={lastEdited.at}
        canSave={!readOnly && canSave(state)}
        onSave={() => void save()}
        onDiscard={canDiscard ? () => setConfirmDiscard(true) : undefined}
        historyHref={historyHref}
        readOnly={readOnly}
      />

      {mock && !readOnly && (
        <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium">Dev (mock only)</span>
          <Button variant="outline" size="sm" onClick={() => void simulateAgentEdit()}>
            <BotIcon />
            Simulate agent edit
          </Button>
        </div>
      )}

      {readOnly && (
        <Alert>
          <AlertTitle>View only</AlertTitle>
          <AlertDescription>
            Your role in this workspace is read-only. Ask a workspace owner for edit access.
          </AlertDescription>
        </Alert>
      )}

      {phase.kind === "error" && (
        <Alert variant="destructive">
          <AlertTitle>{ERROR_COPY[phase.code].title}</AlertTitle>
          <AlertDescription>
            <p>{ERROR_COPY[phase.code].description} Your text is still in the editor.</p>
          </AlertDescription>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-2 top-2 size-7"
            aria-label="Dismiss"
            onClick={() => dispatch({ type: "DISMISS_ERROR" })}
          >
            <XIcon />
          </Button>
        </Alert>
      )}

      {replacing && phase.kind !== "conflict" && (
        <details className="rounded-md border border-amber-300 bg-amber-50 text-sm" open>
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-amber-900">
            Saving will overwrite version {replacing.version}
            {replacing.updatedBy && (
              <>
                by <ActorBadge actor={replacing.updatedBy} />
              </>
            )}
            <span className="text-amber-900/80">(shown here for reference)</span>
          </summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-amber-200 bg-background px-3 py-2 font-mono text-xs">
            {replacing.content}
          </pre>
        </details>
      )}

      {phase.kind === "conflict" ? (
        <ConflictPanel
          mine={phase.mine}
          theirs={phase.theirs}
          onKeepMine={() => {
            dispatch({ type: "KEEP_MINE_REBASE" });
            setReplacing(phase.theirs);
            setReturnFocus(true);
            toast.info(
              `Your next save will overwrite ${phase.theirs.updatedBy ? actorLabel(phase.theirs.updatedBy) : "the latest"}'s version ${phase.theirs.version}.`,
            );
          }}
          onDiscardMine={() => {
            dispatch({ type: "RELOAD_THEIRS" });
            setReplacing(null);
            setReturnFocus(true);
            refreshLastEdited();
            toast.info(`Loaded version ${phase.theirs.version}.`);
          }}
        />
      ) : (
        <MarkdownEditor
          value={state.draft}
          onChange={(draft) => dispatch({ type: "EDIT", draft })}
          markdown={isMarkdown(file.mimeType)}
          view={view}
          onViewChange={setView}
          readOnly={readOnly}
          autoFocus={returnFocus}
          textareaRef={textareaRef}
        />
      )}

      <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <DialogContent
          // The "Discard changes" trigger disappears once the draft is clean, so
          // send focus back to the editor instead of letting it fall to <body>.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            textareaRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Discard your changes?</DialogTitle>
            <DialogDescription>
              The editor goes back to version {state.baseVersion}. Your unsaved edits can&apos;t be recovered.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmDiscard(false);
                setReplacing(null);
                dispatch({ type: "DISCARD_DRAFT" });
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
