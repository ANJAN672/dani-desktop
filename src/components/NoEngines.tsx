// Shown instead of a chat when no bot can run on this machine. Under the
// Hermes-only product this is exactly the managed-runtime state: Dani is
// either preparing itself or needs a truthful repair - never a pick-an-
// engine screen, never a raw install command.
import { useEffect } from "react";
import { useStore } from "@/state/store";
import { RuntimePreparation } from "@/components/RuntimePreparation";

export function NoEngines() {
  const { refreshInstances } = useStore();
  const remoteClient = window.dani?.remoteClient?.active === true;

  // The host prepares its own runtime; a paired client only waits for it.
  useEffect(() => {
    if (!remoteClient) return;
    const t = setInterval(() => void refreshInstances().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [remoteClient, refreshInstances]);

  if (remoteClient) {
    return (
      <main className="flex h-full min-w-0 flex-1 items-center justify-center bg-app px-6">
        <div className="max-w-[520px] rounded-2xl border border-hairline/40 bg-card p-6 text-center">
          <h1 className="text-[20px] font-semibold text-ink">The host is still setting up</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-secondary">
            Dani on the host computer isn't ready yet. Finish its one-time setup there, and this window picks up
            on its own.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <div className="my-auto py-12">
        <RuntimePreparation variant="screen" onReady={() => void refreshInstances().catch(() => {})} />
      </div>
    </main>
  );
}
