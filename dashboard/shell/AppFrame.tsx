/**
 * The application frame: side navigation, system banners, toast and the
 * shared route-independent chrome.
 *
 * Astryx AppShell owns the landmarks (skip link, main, mobile drawer), so
 * this file only supplies navigation, announcements and the toast region.
 */

import {useEffect, type ReactNode} from "react";
import {AppShell} from "@astryxdesign/core/AppShell";
import {SideNav, SideNavHeading, SideNavItem} from "@astryxdesign/core/SideNav";
import {Banner} from "@astryxdesign/core/Banner";
import {StatusDot} from "@astryxdesign/core/StatusDot";
import {Text} from "@astryxdesign/core/Text";
import {Link} from "@astryxdesign/core/Link";
import {Stack} from "@astryxdesign/core/Stack";
import {
  BrandMark,
  CampaignIcon,
  HistoryIcon,
  MiningIcon,
  OverviewIcon,
  SettingsIcon,
} from "../core/icons";
import {routeMeta, useRoute} from "../core/router";
import {useStore} from "../core/store";
import {appearanceNames, chooseAppearance, usePreference} from "../core/theme";
import {cx} from "../core/util";

interface NavEntry {
  name: string;
  href: string;
  label: string;
  icon: ReactNode;
}

const NAV: NavEntry[] = [
  {name: "dashboard", href: "/", label: "Overview", icon: <OverviewIcon />},
  {name: "campaigns", href: "/campaigns", label: "Campaigns", icon: <CampaignIcon />},
  {name: "mining", href: "/mining", label: "Mining plan", icon: <MiningIcon />},
  {name: "history", href: "/history", label: "History", icon: <HistoryIcon />},
  {name: "settings", href: "/settings", label: "Settings", icon: <SettingsIcon />},
];

export function AppFrame({children}: {children: ReactNode}) {
  const {state, connected, toastMessage, toast} = useStore();
  const route = useRoute();
  const preference = usePreference();
  const navName = route.name === "campaign" ? "campaigns" : route.name;
  const [, title] = routeMeta[route.name];

  useEffect(() => {
    document.title = `${title} · Twitch Drops Miner`;
  }, [title]);

  const activeCampaigns = state.campaigns.filter(
    (campaign) => campaign.status === "active" && campaign.eligible && !campaign.finished,
  ).length;

  const connectionKind = !connected
    ? "error"
    : state.activity === "error"
      ? "error"
      : ["active", "pickaxe"].includes(state.activity)
        ? "success"
        : "warning";

  const issues = state.networkIssues ?? [];

  return (
    <AppShell
      id="app-shell"
      contentPadding={0}
      height="fill"
      banner={
        <>
          {!connected ? (
            <Banner
              id="connection-banner"
              status="warning"
              title="Connection interrupted"
              description="Showing the last received state while we reconnect."
            />
          ) : null}
          {issues.length ? (
            <Banner
              id="network-alert"
              status="error"
              title="Twitch service blocked or unreachable"
              description={`Requests to ${issues.join(", ")} are failing. Drop progress may stop.`}
              endContent={
                <Link
                  href="https://github.com/0libote/TwitchDropsMiner#dns-blockers-and-firewalls"
                  isExternalLink
                >
                  Troubleshoot
                </Link>
              }
            />
          ) : null}
        </>
      }
      sideNav={
        <SideNav
          header={
            <SideNavHeading
              icon={<BrandMark />}
              heading="Drops Miner"
              subheading="Twitch Drops Miner"
              headingHref="/"
            />
          }
          footer={
            <Stack gap={3} className="sidebar-footer">
              <label className="field-label" htmlFor="quick-theme">
                Appearance
              </label>
              <select
                id="quick-theme"
                className="select"
                value={preference}
                onChange={(event) => {
                  if (!chooseAppearance(event.target.value)) {
                    toast("Theme applied. This browser could not save your preference.", true);
                  }
                }}
              >
                {Object.entries(appearanceNames).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <Text type="supporting" color="secondary" id="sidebar-version" className="sidebar-caption">
                {state.system?.version ? `Next · ${state.system.version}` : "Twitch Drops Miner Next"}
              </Text>
              <Link href="/diagnostics" data-route data-nav="diagnostics" className="sidebar-status">
                <StatusDot
                  id="connection-dot"
                  variant={connectionKind}
                  label={connected ? "Miner connected" : "Reconnecting"}
                />
                <span className="sidebar-status-text">
                  <strong id="connection-label">
                    {connected ? (state.paused === true ? "Miner paused" : "Miner connected") : "Reconnecting"}
                  </strong>
                  <small id="connection-detail">
                    {connected ? state.status || "Waiting for updates" : "Showing last received state"}
                  </small>
                </span>
              </Link>
            </Stack>
          }
        >
          {NAV.map((entry) => (
            <SideNavItem
              key={entry.name}
              href={entry.href}
              data-route=""
              data-nav={entry.name}
              label={entry.label}
              icon={entry.icon}
              isSelected={navName === entry.name}
              endContent={
                entry.name === "campaigns" && activeCampaigns > 0 ? (
                  <span id="campaign-count" className="nav-count">
                    {activeCampaigns}
                  </span>
                ) : entry.name === "campaigns" ? (
                  <span id="campaign-count" className="nav-count" hidden />
                ) : null
              }
            />
          ))}
        </SideNav>
      }
      mobileNav={{breakpoint: "md"}}
    >
      <div id="view" tabIndex={-1} className="view">
        {children}
      </div>
      <div
        id="toast"
        role="status"
        aria-live="polite"
        className={cx("toast", toastMessage && "show", toastMessage?.isError && "error")}
      >
        {toastMessage?.text}
      </div>
    </AppShell>
  );
}
