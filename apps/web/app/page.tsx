"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../../packages/backend/convex/_generated/api";
import type { Id } from "../../../packages/backend/convex/_generated/dataModel";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useEffect, useState, type FormEvent } from "react";
import styles from "./page.module.css";

export default function Home() {
  const { signIn, signOut } = useAuthActions();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signUp");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const form = new FormData(event.currentTarget);
      await signIn("password", form);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isLoading) {
    return (
      <main className={styles.page}>
        <section className={styles.card}>
          <p className={styles.status}>Connecting to Tandem…</p>
        </section>
      </main>
    );
  }

  if (isAuthenticated)
    return <WorkspaceTester onSignOut={() => void signOut()} />;

  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <div className={styles.brand}>Tandem</div>
        <p className={styles.eyebrow}>Backend smoke test</p>
        <div className={styles.content}>
          <h1>
            {flow === "signUp" ? "Create a test account" : "Welcome back"}
          </h1>
          <p className={styles.description}>
            Sign in to create a workspace, save a document, and check its
            revision history.
          </p>
          <form className={styles.form} onSubmit={handleSubmit}>
            {flow === "signUp" && (
              <label className={styles.field}>
                <span>Name</span>
                <input name="name" autoComplete="name" required />
              </label>
            )}
            <label className={styles.field}>
              <span>Email</span>
              <input name="email" type="email" autoComplete="email" required />
            </label>
            <label className={styles.field}>
              <span>Password</span>
              <input
                name="password"
                type="password"
                autoComplete={
                  flow === "signUp" ? "new-password" : "current-password"
                }
                minLength={8}
                required
              />
            </label>
            <input name="flow" type="hidden" value={flow} />
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <button className={styles.primaryButton} disabled={isSubmitting}>
              {isSubmitting
                ? "Please wait…"
                : flow === "signUp"
                  ? "Create account"
                  : "Sign in"}
            </button>
          </form>
          <button
            className={styles.textButton}
            type="button"
            onClick={() => {
              setError(null);
              setFlow(flow === "signUp" ? "signIn" : "signUp");
            }}
          >
            {flow === "signUp"
              ? "Already have an account? Sign in"
              : "Create a test account"}
          </button>
          <p className={styles.note}>
            Use a unique test email and password you choose. This account and
            test data are stored in the configured Convex deployment.
          </p>
        </div>
      </section>
    </main>
  );
}

function WorkspaceTester({ onSignOut }: { onSignOut: () => void }) {
  const workspaces = useQuery(api.workspaces.listWorkspaces);
  const createWorkspace = useMutation(api.workspaces.createWorkspace);
  const createDocument = useMutation(api.files.createDocument);
  const [workspaceId, setWorkspaceId] = useState<Id<"workspaces"> | null>(null);
  const [workspaceName, setWorkspaceName] = useState("Backend smoke test");
  const [newFileName, setNewFileName] = useState("Test document.md");
  const [pageError, setPageError] = useState<string | null>(null);
  const activeWorkspaceId = workspaceId ?? workspaces?.[0]?.id ?? null;
  const workspaceContext = useQuery(
    api.workspaces.getWorkspaceContext,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const files = useQuery(
    api.files.listFiles,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const [fileId, setFileId] = useState<Id<"files"> | null>(null);
  const activeFileId =
    fileId && files?.some((file) => file.id === fileId)
      ? fileId
      : (files?.[0]?.id ?? null);

  useEffect(() => {
    const firstWorkspace = workspaces?.[0];
    if (firstWorkspace && !workspaceId) setWorkspaceId(firstWorkspace.id);
  }, [workspaces, workspaceId]);

  async function createTestWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPageError(null);
    try {
      const id = await createWorkspace({ name: workspaceName });
      setWorkspaceId(id);
      setFileId(null);
    } catch (cause) {
      setPageError(errorText(cause));
    }
  }

  return (
    <main className={styles.dashboard}>
      <header className={styles.topbar}>
        <div>
          <div className={styles.brand}>Tandem</div>
          <p className={styles.eyebrow}>Backend smoke test</p>
        </div>
        <div className={styles.topActions}>
          <span className={styles.connection}>
            <i />{" "}
            {workspaces === undefined
              ? "Checking backend…"
              : "Backend connected"}
          </span>
          <button className={styles.secondaryButton} onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>
      <section className={styles.workspaceShell}>
        <aside className={styles.sidebar}>
          <div className={styles.sectionHeading}>
            <span>Workspaces</span>
            <span className={styles.count}>{workspaces?.length ?? "…"}</span>
          </div>
          {workspaces?.map((workspace) => (
            <button
              key={workspace.id}
              className={`${styles.workspaceButton} ${workspace.id === activeWorkspaceId ? styles.selectedWorkspace : ""}`}
              onClick={() => {
                setWorkspaceId(workspace.id);
                setFileId(null);
              }}
            >
              {workspace.name}
              <small>{workspace.role}</small>
            </button>
          ))}
          {workspaces?.length === 0 && (
            <p className={styles.emptyHint}>
              No workspaces yet. Create one to test writes.
            </p>
          )}
          {activeWorkspaceId && (
            <section className={styles.goalCard} aria-label="Approved goal">
              <div className={styles.sectionHeading}>Approved goal</div>
              <p>
                {workspaceContext === undefined
                  ? "Loading project context…"
                  : (workspaceContext?.goal?.text ?? "No approved goal yet.")}
              </p>
            </section>
          )}
          <form className={styles.createForm} onSubmit={createTestWorkspace}>
            <label className={styles.field}>
              <span>New workspace</span>
              <input
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                required
              />
            </label>
            <button className={styles.primaryButton}>Create workspace</button>
          </form>
          <div className={styles.sectionHeading}>
            <span>Files</span>
            <span className={styles.count}>{files?.length ?? "…"}</span>
          </div>
          {files?.map((file) => (
            <button
              key={file.id}
              className={`${styles.fileButton} ${file.id === activeFileId ? styles.selectedFile : ""}`}
              onClick={() => setFileId(file.id)}
            >
              <span>▤</span>
              {file.name}
              <small>v{file.version}</small>
            </button>
          ))}
          {activeWorkspaceId && (
            <form
              className={styles.createForm}
              onSubmit={async (event) => {
                event.preventDefault();
                setPageError(null);
                try {
                  const created = await createDocument({
                    workspaceId: activeWorkspaceId,
                    name: newFileName,
                    mimeType: "text/markdown",
                    content:
                      "# Backend smoke test\n\nEdit this document and save to create version 2.",
                  });
                  setFileId(created.id);
                } catch (cause) {
                  setPageError(errorText(cause));
                }
              }}
            >
              <label className={styles.field}>
                <span>New document</span>
                <input
                  value={newFileName}
                  onChange={(event) => setNewFileName(event.target.value)}
                  required
                />
              </label>
              <button className={styles.secondaryButton}>
                Create document
              </button>
            </form>
          )}
        </aside>
        <section className={styles.editorPane}>
          {pageError && (
            <p className={styles.errorBanner} role="alert">
              {pageError}
            </p>
          )}
          {!activeWorkspaceId ? (
            <div className={styles.emptyState}>
              <h1>Create your first workspace</h1>
              <p>
                This checks authenticated workspace creation and membership.
              </p>
            </div>
          ) : !activeFileId ? (
            <div className={styles.emptyState}>
              <h1>Workspace ready</h1>
              <p>
                Create a document to test file creation, reads, versioned
                updates, and revision history.
              </p>
            </div>
          ) : (
            <DocumentEditor key={activeFileId} fileId={activeFileId} />
          )}
        </section>
      </section>
    </main>
  );
}

function DocumentEditor({ fileId }: { fileId: Id<"files"> }) {
  const result = useQuery(api.files.readFile, { fileId });
  const versions = useQuery(api.files.getFileVersions, { fileId, limit: 20 });
  const updateDocument = useMutation(api.files.updateDocument);
  const [content, setContent] = useState("");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasConflict, setHasConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (result && !hasConflict) setContent(result.content ?? "");
  }, [result?.file.version, result?.content, hasConflict]);

  async function save() {
    if (!result) return;
    setSaving(true);
    setError(null);
    setSaveMessage(null);
    setHasConflict(false);
    try {
      const saved = await updateDocument({
        fileId,
        content,
        expectedVersion: result.file.version,
      });
      setSaveMessage(`Saved as version ${saved.version}.`);
    } catch (cause) {
      const message = errorText(cause);
      setError(message);
      setHasConflict(message.includes("VERSION_CONFLICT"));
    } finally {
      setSaving(false);
    }
  }

  if (!result) return <p className={styles.status}>Loading document…</p>;
  return (
    <div className={styles.editorContent}>
      <div className={styles.documentHeader}>
        <div>
          <p className={styles.eyebrow}>Text document</p>
          <h1>{result.file.name}</h1>
          <p className={styles.description}>
            Current version: {result.file.version} · Last updated by{" "}
            {result.file.updatedBy.label}
          </p>
        </div>
        <button
          className={styles.primaryButton}
          onClick={() => void save()}
          disabled={saving || content === (result.content ?? "")}
        >
          {saving ? "Saving…" : "Save new version"}
        </button>
      </div>
      {error && (
        <div className={styles.errorBanner} role="alert">
          <strong>Save failed.</strong> {error}{" "}
          {hasConflict && (
            <>
              <span>
                Your draft is preserved. The server now has version{" "}
                {result.file.version}; compare it below before retrying.
              </span>
              <button
                className={styles.inlineButton}
                type="button"
                onClick={() => {
                  setContent(result.content ?? "");
                  setHasConflict(false);
                  setError(null);
                }}
              >
                Use latest server version
              </button>
            </>
          )}
        </div>
      )}
      {saveMessage && <p className={styles.successBanner}>{saveMessage}</p>}
      <textarea
        className={styles.editor}
        aria-label="Document content"
        value={content}
        onChange={(event) => {
          setContent(event.target.value);
          setSaveMessage(null);
        }}
        spellCheck={false}
      />
      <section className={styles.history}>
        <div className={styles.sectionHeading}>
          <h2>Revision history</h2>
          <span className={styles.count}>{versions?.length ?? "…"}</span>
        </div>
        {versions?.map((version) => (
          <details className={styles.revision} key={version.id}>
            <summary>
              <strong>Version {version.version}</strong>
              <span>{new Date(version.createdAt).toLocaleString()}</span>
              <small>{version.actor.label}</small>
            </summary>
            <pre>{version.content}</pre>
          </details>
        ))}
      </section>
    </div>
  );
}

function errorText(cause: unknown) {
  return cause instanceof Error
    ? cause.message.replace(/^Uncaught Error: /, "")
    : "The request failed. Check your connection and try again.";
}
