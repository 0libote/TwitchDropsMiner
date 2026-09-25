/**
 * Diagnostics: connection health, miner counters and the raw event log.
 */

import {useState} from "react";
import {Button} from "@astryxdesign/core/Button";
import {Card} from "@astryxdesign/core/Card";
import {Banner} from "@astryxdesign/core/Banner";
import {Heading, Text} from "@astryxdesign/core/Text";
import {Stack} from "@astryxdesign/core/Stack";
import {Grid} from "@astryxdesign/core/Grid";
import {Page, PageHeader} from "../shell/parts";
import {request} from "../core/api";
import {formatDate} from "../core/format";
import {useStore} from "../core/store";

interface StatTile {
  label: string;
  value: string;
  note: string;
}

export function Diagnostics() {
  const {state, connected, toast} = useStore();
  const [logRef, setLogRef] = useState<HTMLDivElement | null>(null);

  const socketTopics = state.websockets.reduce(
    (sum, socket) => sum + (socket.topics || 0),
    0,
  );
  const lines = [...(state.messages ?? [])].reverse();
  const notifications = state.notifications ?? [];
  const lifetime = state.stats.lifetime;

  const tiles: StatTile[] = [
    {label: "Miner state", value: state.activity || "Unknown", note: state.status || "No status message"},
    {
      label: "Event sockets",
      value: String(state.websockets.length || 0),
      note: `${socketTopics} subscribed topics`,
    },
    {
      label: "Dashboard stream",
      value: connected ? "Connected" : "Reconnecting",
      note: `State revision ${state.revision}`,
    },
    {
      label: "Version",
      value: state.system.version,
      note: `Engine ${state.system.upstreamVersion}`,
    },
    {
      label: "Watch failures",
      value: String(lifetime.watch_failures || 0),
      note: `${lifetime.watch_heartbeats || 0} heartbeats`,
    },
    {
      label: "Last progress",
      value: formatDate(String(lifetime.last_progress_at ?? ""), true),
      note: formatDate(String(lifetime.last_progress_at ?? "")),
    },
  ];

  return (
    <Page>
      <Stack gap={5}>
        <PageHeader
          title="Diagnostics"
          description="Connection health and miner events"
        />

        <Grid columns={{minWidth: 240, max: 3, repeat: "fit"}} gap={3}>
          {tiles.map((tile) => (
            <Card key={tile.label} className="diagnostic-card">
              <Stack gap={1}>
                <Text type="supporting" color="secondary">
                  {tile.label}
                </Text>
                <Heading level={3}>{tile.value}</Heading>
                <Text type="supporting" color="secondary">
                  {tile.note}
                </Text>
              </Stack>
            </Card>
          ))}
        </Grid>

        <Card padding={0}>
          <Stack gap={0}>
            <Stack
              direction="horizontal"
              justify="between"
              align="center"
              gap={3}
              padding={4}
              className="log-header"
            >
              <Stack gap={0.5}>
                <Heading level={2}>Event log</Heading>
                <Text type="supporting" color="secondary">
                  Newest events appear first
                </Text>
              </Stack>
              <Stack direction="horizontal" gap={2}>
                <Button
                  variant="secondary"
                  size="sm"
                  data-copy-log
                  label="Copy log"
                  onClick={() => {
                    const text = logRef?.innerText ?? "";
                    navigator.clipboard
                      .writeText(text)
                      .then(() => toast("Activity log copied"))
                      .catch(() => toast("Unable to copy the activity log", true));
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  href="/api/diagnostics"
                  label="Download"
                />
              </Stack>
            </Stack>
            <div className="log" id="activity-log" ref={setLogRef}>
              {notifications.map((item) => (
                <p className="notification" key={`n-${item.time}-${item.title}`}>
                  <strong>
                    {formatDate(item.time)} · {item.title}
                  </strong>{" "}
                  {item.message}
                </p>
              ))}
              {lines.length ? (
                lines.map((item, index) => (
                  <p key={`${item.time}-${index}`}>
                    <small>{formatDate(item.time)}</small> {item.message || String(item)}
                  </p>
                ))
              ) : !notifications.length ? (
                <p>Waiting for miner events…</p>
              ) : null}
            </div>
          </Stack>
        </Card>

        <Card variant="muted">
          <Stack gap={3}>
            <Heading level={3}>Network health</Heading>
            <Text>
              {state.networkIssues?.length
                ? `Requests are failing for ${state.networkIssues.join(", ")}.`
                : "No repeated Twitch network failures have been detected."}
            </Text>
            <Text type="supporting" color="secondary">
              {state.system.platform} · Python {state.system.python} ·{" "}
              {state.system.authenticationEnabled
                ? "Dashboard authentication enabled"
                : "Dashboard authentication disabled"}
            </Text>
          </Stack>
        </Card>

        {state.networkIssues?.length ? (
          <Banner
            status="warning"
            title="Network requests are failing"
            description={`Requests to ${state.networkIssues.join(", ")} are failing. Drop progress may stop.`}
          />
        ) : null}
      </Stack>
    </Page>
  );
}
