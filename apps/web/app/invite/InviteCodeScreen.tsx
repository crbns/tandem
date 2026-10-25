import Link from "next/link";
import { JoinWithCodeForm } from "@/components/common/JoinWithCodeForm";

/** /invite and /invite/<CODE>: the same form, filled in when the link carries a code. */
export function InviteCodeScreen({ initialCode }: { initialCode?: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 px-4 text-sm text-muted-foreground">
      <div className="max-w-sm text-center">
        <h1 className="text-lg font-semibold text-foreground">Join a workspace</h1>
        <p className="mt-1">
          {initialCode
            ? "Check the code your teammate shared, then join. You'll sign in first if you need to."
            : "Enter the invite code a teammate shared. You'll sign in first if you need to."}
        </p>
      </div>
      <JoinWithCodeForm initialCode={initialCode} className="w-full max-w-sm rounded-md border bg-card p-4" />
      <Link href="/" className="underline underline-offset-4 hover:text-foreground">
        Back to Tandem
      </Link>
    </main>
  );
}
