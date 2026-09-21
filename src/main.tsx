import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { IdeWorkspace } from "./components/IdeWorkspace";
import { StoreProvider } from "./state/store";
import { readSessionState, takePairingCodeFromLocation } from "./lib/session";
import { applyBrand } from "./lib/brand";
import { applySkin, readSkin } from "./lib/skins";
import { PairPage } from "./pair/PairPage";
import "./styles.css";

// Before the first paint, not inside a component: stamping the skin during
// render would show one frame of the default palette first. The brand (window
// title, accent) is fetched the same way so a white-labelled deployment never
// flashes the default name; it waits at most a moment and falls back silently.
applySkin(readSkin());

/** A pairing link lands on /pair. A remote browser without a session lands
 * there too, because every API call would otherwise fail with "pair this
 * device"; on the owner's own machine the server trusts loopback and this
 * check is a single fast request. */
async function chooseRoot(): Promise<React.ReactNode> {
  if (location.pathname === "/pair") return <PairPage initialCode={takePairingCodeFromLocation()} />;
  if (location.pathname === "/ide") {
    applyBrand({
      brand: { name: "Gooey pi", tagline: "Gooey workspace", accent: "#7dd3fc" },
      source: "default",
      file: "",
    });
    const session = await readSessionState();
    if (session.kind === "unauthenticated") return <PairPage initialCode={null} reason={session.error} />;
    return (
      <StoreProvider>
        <IdeWorkspace />
      </StoreProvider>
    );
  }
  const session = await readSessionState();
  if (session.kind === "unauthenticated") return <PairPage initialCode={null} reason={session.error} />;
  return <App />;
}

void chooseRoot().then((root) => {
  createRoot(document.getElementById("root")!).render(<StrictMode>{root}</StrictMode>);
});

