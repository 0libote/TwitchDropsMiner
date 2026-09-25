/**
 * Dashboard entry.
 *
 * Boots the React tree on top of the same static files the server has always
 * served: `web/theme.js` paints the saved appearance first, then this bundle
 * takes over the shell, routing and live state.
 */

import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "./themes/graphite.css";
import "./themes/paper.css";
import "./themes/midnight.css";
import "./themes/evergreen.css";
import "./styles/app.css";

import {useEffect, type ReactNode} from "react";
import {createRoot} from "react-dom/client";
import {Theme} from "@astryxdesign/core";
import type {DefinedTheme} from "@astryxdesign/core/theme";

import {graphiteTheme} from "./themes/graphite";
import {paperTheme} from "./themes/paper";
import {midnightTheme} from "./themes/midnight";
import {evergreenTheme} from "./themes/evergreen";

import {MinerProvider, useStore} from "./core/store";
import {navigate, setNavigationGuard, useRoute} from "./core/router";
import {useResolvedAppearance} from "./core/theme";
import {AppFrame} from "./shell/AppFrame";
import {AuthView} from "./shell/AuthView";
import {Overview} from "./routes/Overview";
import {Campaigns} from "./routes/Campaigns";
import {CampaignDetail} from "./routes/CampaignDetail";
import {Mining} from "./routes/Mining";
import {History} from "./routes/History";
import {Settings} from "./routes/Settings";
import {Diagnostics} from "./routes/Diagnostics";

const THEMES: Record<string, DefinedTheme> = {
  graphite: graphiteTheme,
  paper: paperTheme,
  midnight: midnightTheme,
  evergreen: evergreenTheme,
};

function Routes() {
  const {state, dirty, discard} = useStore();
  const route = useRoute();

  // In-app links keep the SPA fast; the guard keeps unsaved settings safe.
  useEffect(() => {
    setNavigationGuard(() => {
      if (!dirty) return true;
      if (!confirm("Discard your unsaved changes?")) return false;
      discard();
      return true;
    });
  }, [dirty, discard]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const link = target?.closest?.("a[data-route]") as HTMLAnchorElement | null;
      if (!link || link.origin !== location.origin) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      navigate(link.pathname);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    addEventListener("beforeunload", onBeforeUnload);
    return () => removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const login = state.login ?? {};
  const needsActivation = Boolean(login.activationCode && !login.userId);
  const waiting = !needsActivation && !login.userId && !state.canLogout;

  if (waiting) {
    return (
      <div id="loading" className="loading" role="status">
        Connecting to the miner…
      </div>
    );
  }
  if (needsActivation) return <AuthView />;

  let content: ReactNode;
  if (route.name === "dashboard") content = <Overview />;
  else if (route.name === "campaigns") content = <Campaigns />;
  else if (route.name === "campaign")
    content = (
      <CampaignDetail campaign={state.campaigns.find((item) => item.id === route.id)} />
    );
  else if (route.name === "mining") content = <Mining />;
  else if (route.name === "history") content = <History />;
  else if (route.name === "settings") content = <Settings />;
  else content = <Diagnostics />;

  return <AppFrame>{content}</AppFrame>;
}

function App() {
  const appearance = useResolvedAppearance();
  const theme = THEMES[appearance] ?? graphiteTheme;
  useEffect(() => {
    // The static splash in index.html covers the gap before React mounts.
    document.getElementById("splash")?.remove();
  }, []);
  return (
    <Theme theme={theme} mode={appearance === "paper" ? "light" : "dark"}>
      <MinerProvider>
        <Routes />
      </MinerProvider>
    </Theme>
  );
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
