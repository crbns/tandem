"use client";

import { useEffect, useEffectEvent, useReducer, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BotIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { useMockControls, useTandemApi, type Actor, type FileDetail } from "@/lib/api";
import { ERROR_COPY } from "@/lib/api/errorCopy";
import { useSession } from "@/lib/auth/useSession";
import { canSave, initSaveState, saveReducer, type SaveState } from "@/lib/editor/saveMachine";
import { performSave } from "@/lib/editor/performSave";
import { clearDraftStash, readDraftStash, stashDraft } from "@/lib/editor/draftStash";
import { isMarkdown } from "@/lib/files";
import { MarkdownEditor } from "@/components/editor/MarkdownEditor";
import { SaveBar } from "@/components/editor/SaveBar";
import { ConflictPanel } from "@/components/editor/ConflictPanel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const SIMULATED_AGENT: Actor = { actorType: "agent", actorId: "agent_claude", actorName: "Claude" };

/**
 * Restore a draft stashed before a forced sign-in. We keep the stashed
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

  const [stash] = useState(() => readDraftStash(file.id));
  const [state, dispatch] = useReducer(saveReducer, undefined, () => initialState(file, stash));
  const [lastEdited, setLastEdited] = useState({ actor: file.updatedBy, at: file.updatedAt });
  const readOnly = !file.permissions.canEdit;
  const { phase } = state;

  useEffect(() => {
    if (!stash) return;
    clearDraftStash(file.id);
    toast.info("Restored your unsaved changes.");
  }, [stash, file.id]);

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
      setLastEdited({
        actor: { actorType: "human", actorId: user?.email ?? "me", actorName: user?.name ?? "You" },
        at: Date.now(),
      });
    } else if (event.type === "SAVE_ERROR" && event.code === "UNAUTHENTICATED") {
      stashDraft(file.id, { draft, baseVersion });
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

  const hasUnsaved = state.draft !== state.base || phase.kind === "conflict";
  useEffect(() => {
    if (!hasUnsaved) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsaved]);

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
      description: `This tab is still based on version ${state.baseVersion}. Edit and save to see the conflict flow.`,
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
          <AlertDescription>You can read this file but not edit it.</AlertDescription>
        </Alert>
      )}

      {phase.kind === "error" && (
        <Alert variant="destructive">
          <AlertTitle>{ERROR_COPY[phase.code].title}</AlertTitle>
          <AlertDescription>
            <p>
              {ERROR_COPY[phase.code].description} Your text is still in the editor.
            </p>
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

      {phase.kind === "conflict" ? (
        <ConflictPanel
          mine={phase.mine}
          theirs={phase.theirs}
          onKeepMine={() => {
            dispatch({ type: "KEEP_MINE_REBASE" });
            refreshLastEdited();
            toast.info(`Your next save will replace version ${phase.theirs.version}.`);
          }}
          onDiscardMine={() => {
            dispatch({ type: "RELOAD_THEIRS" });
            refreshLastEdited();
            toast.info(`Loaded version ${phase.theirs.version}.`);
          }}
        />
      ) : (
        <MarkdownEditor
          value={state.draft}
          onChange={(draft) => dispatch({ type: "EDIT", draft })}
          markdown={isMarkdown(file.mimeType)}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}
