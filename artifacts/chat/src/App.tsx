import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { ChatCryptoSession } from "./crypto/e2eeClient";
import { chatApi, type BootstrapResponse } from "./lib/api";
import { ActivationFlow } from "./components/ActivationFlow";
import { ChatWorkspace } from "./components/ChatWorkspace";

export function App() {
  const [loading, setLoading] = useState(true);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>({ state: "NO_HANDOFF" });
  const [cryptoSession, setCryptoSession] = useState<ChatCryptoSession | null>(null);
  const [keyEvictionReason, setKeyEvictionReason] = useState<string | null>(null);

  const loadBootstrap = useCallback(async () => {
    setLoading(true);
    setKeyEvictionReason(null);
    setCryptoSession(null);

    try {
      let state = await chatApi.bootstrap();

      if (state.state === "HANDOFF_READY") {
        try {
          state = await chatApi.exchangeHandoff();
        } catch (err) {
          // Graceful fallback: if exchange failed or already consumed, fall back cleanly
          state = await chatApi.bootstrap();
          if (state.state === "HANDOFF_READY") {
            state = { state: "NO_HANDOFF" };
          }
          console.warn("[chat-handoff] Fallback to clean state:", (err as Error).message);
        }
      }

      setBootstrap(state);

      if (
        (state.state === "AUTHENTICATED" || state.state === "AUTHENTICATED_WITH_PENDING_HANDOFF") &&
        state.account &&
        state.currentDevice
      ) {
        try {
          const opened = await ChatCryptoSession.openExisting(
            state.account.id,
            state.currentDevice.matrixDeviceId,
          );
          setCryptoSession(opened);
        } catch (err) {
          setKeyEvictionReason(
            (err as Error).message || "Local encryption keys could not be found in this browser.",
          );
        }
      }
    } catch {
      setBootstrap({ state: "NO_HANDOFF" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  if (loading) {
    return (
      <div className="min-h-dvh bg-[#faf9f6] flex items-center justify-center">
        <div className="flex items-center gap-2.5 text-sm font-semibold text-[#1a0a00]">
          <Loader2 className="w-5 h-5 animate-spin text-[#059669]" />
          <span>Initializing encrypted session…</span>
        </div>
      </div>
    );
  }

  if (
    bootstrap.state === "AUTHENTICATED" &&
    bootstrap.account &&
    cryptoSession &&
    !keyEvictionReason
  ) {
    return (
      <ChatWorkspace
        account={bootstrap.account}
        cryptoSession={cryptoSession}
        onLoggedOut={loadBootstrap}
      />
    );
  }

  return (
    <ActivationFlow
      bootstrap={bootstrap}
      keyEvictionReason={keyEvictionReason}
      onAuthenticated={(acc, sess) => {
        setKeyEvictionReason(null);
        setCryptoSession(sess);
        setBootstrap({
          state: "AUTHENTICATED",
          account: acc,
          currentDevice: { id: "local", matrixDeviceId: sess.matrixDeviceId },
        });
      }}
      onRefreshBootstrap={loadBootstrap}
    />
  );
}

export default App;
