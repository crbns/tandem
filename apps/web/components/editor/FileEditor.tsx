"use client";

import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BotIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { useMockControls, useTandemApi, type Actor, type FileDetail } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { useSession } from "@/lib/auth/useSession";
import { humanActorId } from "@/lib/actors";
import { canSave, draftToStash, restoreSaveState, saveReducer, type Theirs } from "@/lib/editor/saveMachine";
import { performSave } from "@/lib/editor/performSave";
import { clearDraftStash, draftOwnerKey, readDraftStash, stashDraft } from "@/lib/editor/draftStash";
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

interface FileEditorProps {
  file: FileDetail;
  historyHref: string;
}

export function FileEditor({ file, historyHref }: FileEditorProps) {
  const api = useTandemApi();
  const mock = useMockControls();
  const session = useSession();
  const { user } = session;
  const router = useRouter();
  const pathname = usePathname();
  const userKey = draftOwnerKey(user?.email);
  const readOnly = !file.permissions.canEdit;

  const [stash] = useState(() => (userKey ? readDraftStash(userKey, file.id) : null));
  const head: Theirs = { version: file.version, content: file.content ?? "", updatedBy: file.updatedBy };
  // A read-only user can't save or discard in the editor, so a draft from before
  // their access changed is shown beside the file instead of replacing it.
  const [orphanedDraft, setOrphanedDraft] = useState(() =>
    readOnly && stash && stash.draft !== head.content ? stash.draft : null,
  );
  const [state, dispatch] = useReducer(saveReducer, undefined, () =>
    restoreSaveState(head, readOnly ? null : stash),
  );
  const [lastEdited, setLastEdited] = useState({ actor: file.updatedBy, at: file.updatedAt });
  const [view, setView] = useState<EditorView>("split");
  // After "Keep my text": the version the next save will replace, kept visible until then.
  const [replacing, setReplacing] = useState<Theirs | null>(null);
  const [returnFocus, setReturnFocus] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { phase } = state;

  const restored = !readOnly && stash !== null && stash.draft !== head.content;
  const toastedRestore = useRef(false);
  useEffect(() => {
    if (!restored || toastedRestore.current) return;
    toastedRestore.current = true;
    toast.info(
      stash && stash.baseVersion !== file.version
        ? "Restored your unsaved changes. The file changed since, so review the newer version below."
        : "Restored your unsaved changes.",
    );
  }, [restored]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist unsaved work on every change, so losing the session mid-edit (the
  // layout unmounts us and redirects to sign-in) or navigating away can't drop it.
  const pending = draftToStash(state);
  useEffect(() => {
    // Read-only: nothing to stash, and an orphaned draft stays until dismissed.
    if (!userKey || readOnly) return;
    if (pending) stashDraft(userKey, file.id, pending);
    else clearDraftStash(userKey, file.id);
  }, [userKey, readOnly, file.id, pending?.draft, pending?.baseVersion]); // eslint-disable-line react-hooks/exhaustive-deps

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
      refreshLastEdited(); // replace the local guess with the backend's attribution
    } else if (event.type === "SAVE_CONFLICT") {
      // The bar should name who saved the version we just collided with.
      if (event.theirs.updatedBy) setLastEdited({ actor: event.theirs.updatedBy, at: Date.now() });
      refreshLastEdited();
    } else if (event.type === "SAVE_ERROR" && event.code === "UNAUTHENTICATED") {
      // The draft is already stashed by the effect above. End the client session
      // too: sign-in bounces an "authenticated" session straight back here, so
      // the user would never see the form. Not signOutAndLeave: drafts stay.
      try {
        await session.signOut();
      } catch {
        // the session is already unusable; sign-in still shows the form
      }
      router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
    }
  }

  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      // Not behind the discard dialog: a save started there would commit the text being discarded.
      if (!confirmDiscard) void save();
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

      {orphanedDraft !== null && (
        <Alert>
          <AlertTitle>Unsaved text from before your access changed</AlertTitle>
          <AlertDescription>
            <p>You can no longer edit this file, so it shows the current version. Copy anything you need from your text below.</p>
            <details className="mt-2 w-full">
              <summary className="cursor-pointer">Show your text</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-background px-3 py-2 font-mono text-xs">
                {orphanedDraft}
              </pre>
            </details>
            <div className="mt-2 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  navigator.clipboard.writeText(orphanedDraft).then(
                    () => toast.success("Copied your text."),
                    () => toast.error("Couldn't copy. Select the text above instead."),
                  )
                }
              >
                Copy
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (userKey) clearDraftStash(userKey, file.id);
                  setOrphanedDraft(null);
                }}
              >
                Delete it
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Only while there's something to save; edited back to match, nothing gets replaced. */}
      {replacing && phase.kind !== "conflict" && state.draft !== state.base && (
        <details className="rounded-md border border-amber-300 bg-amber-50 text-sm" open>
          {/* One span per phrase: bare JSX text beside {expressions} loses its
              spaces inside a flex row ("version 2by"). The gap spaces them. */}
          <summary className="flex cursor-pointer flex-wrap items-center gap-x-1.5 gap-y-1 px-3 py-2 text-amber-900">
            <span className="font-medium">Saving will replace version {replacing.version}</span>
            {replacing.updatedBy && (
              <>
                <span>by</span>
                <ActorBadge actor={replacing.updatedBy} />
              </>
            )}
            <span className="text-amber-900/80">· Copy anything you want to keep from it below.</span>
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
              phase.mine === phase.theirs.content
                ? `Your text matches version ${phase.theirs.version}, so there's nothing to save.`
                : `Continuing with your changes. Your next save replaces version ${phase.theirs.version}.`,
            );
          }}
          onDiscardMine={() => {
            dispatch({ type: "RELOAD_THEIRS" });
            setReplacing(null);
            setReturnFocus(true);
            refreshLastEdited();
            toast.info(`Version ${phase.theirs.version} loaded. Your changes were discarded.`);
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
              The editor goes back to version {state.baseVersion}. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDiscard(false)}>
              Keep my changes
            </Button>
            <Button
              variant="destructive"
              disabled={phase.kind === "saving"}
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
