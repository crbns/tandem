"use client";

import { useCallback, useState } from "react";
import { useParams } from "next/navigation";
import { AlertTriangleIcon, InfoIcon, RotateCwIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { normalizeError, useTandemApi, type ContextProposal, type TandemApiError } from "@/lib/api";
import { DECIDE_ERROR_COPY, ERROR_COPY } from "@/lib/api/errorCopy";
import { useResource } from "@/lib/api/useResource";
import { useWorkspaceRefresh, useWorkspaceRole } from "@/lib/api/useWorkspace";
import { canDecideProposals, FIELD_LABELS, scopeReference } from "@/lib/proposals";
import { ContextApprovalSetting } from "@/components/approvals/ContextApprovalSetting";
import { DecidedProposal, ProposalCard, type Decision } from "@/components/approvals/ProposalCard";
import { ErrorState } from "@/components/common/ErrorState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface Outcome {
  proposal: ContextProposal;
  error: TandemApiError;
}

export default function ApprovalsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const api = useTandemApi();
  const role = useWorkspaceRole(workspaceId);
  const canDecide = canDecideProposals(role);

  const load = useCallback(async () => {
    const [proposals, context] = await Promise.all([
      api.listProposals(workspaceId),
      // Shows what a goal/scope change would replace, and the scope other changes must fit.
      api.getContext(workspaceId).catch(() => null),
    ]);
    return { proposals, context };
  }, [api, workspaceId]);
  const { resource, refreshing, reload } = useResource(load);
  useWorkspaceRefresh(workspaceId, reload);

  const [deciding, setDeciding] = useState<{ id: string; decision: Decision } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function decide(proposal: ContextProposal, decision: Decision) {
    setDeciding({ id: proposal.id, decision });
    setOutcome(null);
    try {
      await api.decideProposal(proposal, decision);
      toast.success(
        decision === "approved"
          ? `Approved. The ${FIELD_LABELS[proposal.field].toLowerCase()} ${proposal.operation === "remove" ? "is removed" : proposal.operation === "resolve" ? "is resolved" : "is updated"}.`
          : "Rejected. Nothing in the context changed.",
      );
    } catch (err) {
      setOutcome({ proposal, error: normalizeError(err) });
    } finally {
      setDeciding(null);
      // Stale and already-decided proposals have moved on; show where they landed.
      reload();
    }
  }

  const pending = resource.status === "ready" ? resource.data.proposals.filter((p) => p.status === "pending") : [];
  const decided = resource.status === "ready" ? resource.data.proposals.filter((p) => p.status !== "pending") : [];
  const context = resource.status === "ready" ? resource.data.context : null;
  const currentFor = (p: ContextProposal) =>
    p.field === "goal" ? (context?.goal ?? "") : p.field === "scope" ? (context?.scope ?? "") : undefined;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <h1 className="text-2xl font-bold leading-8 tracking-[-0.01em]">Approvals</h1>
        {resource.status === "ready" && (
          <span className="pb-1 text-sm text-muted-foreground">
            {pending.length === 0 ? "nothing waiting" : pending.length === 1 ? "1 waiting" : `${pending.length} waiting`}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={reload}
          disabled={refreshing}
          aria-label="Refresh approvals"
        >
          <RotateCwIcon className={cn(refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>
      <p className="-mt-2 max-w-2xl text-sm text-muted-foreground">
        Proposed changes to the project context wait here until a person approves them. Assistants can propose;
        they can&apos;t approve.
      </p>

      <ContextApprovalSetting workspaceId={workspaceId} canEdit={canDecide} />

      {role !== undefined && !canDecide && (
        <Alert>
          <InfoIcon />
          <AlertTitle>Read only</AlertTitle>
          <AlertDescription>Workspace owners and admins approve or reject proposals. You can follow them here.</AlertDescription>
        </Alert>
      )}

      {outcome && <OutcomeAlert outcome={outcome} onDismiss={() => setOutcome(null)} />}

      {resource.status === "loading" && (
        <div className="flex flex-col gap-3" aria-label="Loading approvals">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      )}

      {resource.status === "error" && <ErrorState error={resource.error} onRetry={reload} retrying={refreshing} />}

      {resource.status === "ready" && (
        <>
          <section aria-labelledby="pending-heading" className="flex flex-col gap-3">
            <h2 id="pending-heading" className="sr-only">
              Pending
            </h2>
            {pending.length === 0 ? (
              <div className="rounded-md border border-dashed bg-card px-5 py-8 text-center text-sm text-muted-foreground">
                No proposals are waiting. When a teammate or their assistant proposes a change, it shows up here.
              </div>
            ) : (
              pending.map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  current={currentFor(proposal)}
                  approvedScope={scopeReference(proposal.field, context?.scope)}
                  canDecide={canDecide}
                  deciding={deciding?.id === proposal.id ? deciding.decision : null}
                  busy={deciding !== null}
                  onDecide={(decision) => void decide(proposal, decision)}
                />
              ))
            )}
          </section>

          {decided.length > 0 && (
            <section aria-labelledby="decided-heading" className="flex flex-col gap-2">
              <h2 id="decided-heading" className="text-base font-bold leading-6">
                Recorded and decided
              </h2>
              <ul className="rounded-md border bg-card">
                {decided.map((proposal) => (
                  <DecidedProposal key={proposal.id} proposal={proposal} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function OutcomeAlert({ outcome, onDismiss }: { outcome: Outcome; onDismiss: () => void }) {
  const { code } = outcome.error;
  const copy =
    code === "VERSION_CONFLICT" && outcome.proposal.operation !== "add"
      ? {
          title: "The entry changed since this was proposed",
          description: `It's already ${outcome.proposal.operation === "resolve" ? "resolved or removed" : "removed"}, so there's nothing to apply. It's now marked stale.`,
        }
      : (DECIDE_ERROR_COPY[code] ?? ERROR_COPY[code]);
  // A stale approval is contested work (ochre), not a failure.
  const contested = code === "VERSION_CONFLICT";
  return (
    <Alert variant={contested ? "warning" : "destructive"}>
      <AlertTriangleIcon />
      <AlertTitle className="flex items-start justify-between gap-3">
        <span>
          {copy.title}
          <span className="font-normal">: {FIELD_LABELS[outcome.proposal.field]}</span>
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1 rounded p-0.5 opacity-70 hover:opacity-100"
        >
          <XIcon className="size-3.5" />
        </button>
      </AlertTitle>
      <AlertDescription>
        <p>{copy.description}</p>
        <p className="italic">&ldquo;{outcome.proposal.proposedValue}&rdquo;</p>
      </AlertDescription>
    </Alert>
  );
}
