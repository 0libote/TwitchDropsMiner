/**
 * Settings: appearance, miner preferences, network options and system actions.
 *
 * The form edits a local draft; live snapshots never overwrite work in
 * progress, and nothing is written back until the save bar is used.
 */

import {useState} from "react";
import {Button} from "@astryxdesign/core/Button";
import {Card} from "@astryxdesign/core/Card";
import {Slider} from "@astryxdesign/core/Slider";
import {Switch} from "@astryxdesign/core/Switch";
import {TextInput} from "@astryxdesign/core/TextInput";
import {Heading, Text} from "@astryxdesign/core/Text";
import {Stack} from "@astryxdesign/core/Stack";
import {Page, PageHeader} from "../shell/parts";
import {SaveBar} from "../shell/SaveBar";
import {request} from "../core/api";
import {useAction} from "../core/actions";
import {useStore} from "../core/store";
import {
  appearanceDescriptions,
  appearanceNames,
  chooseAppearance,
  usePreference,
} from "../core/theme";
import {cx} from "../core/util";

function validProxy(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const url = new URL(value);
    return Boolean(url.hostname && url.port);
  } catch {
    return false;
  }
}

export function Settings() {
  const {state, settings, update, dirty, toast} = useStore();
  const {run, pending} = useAction();
  const preference = usePreference();
  const [proxyDraft, setProxyDraft] = useState(settings.proxy);

  const proxyValid = validProxy(settings.proxy);

  return (
    <Page>
      <Stack gap={6}>
        <PageHeader title="Settings" description="Make this miner your own" />

        <div className="settings-layout">
          <Stack gap={4}>
            <Card>
              <Stack gap={4}>
                <Stack gap={0.5}>
                  <Heading level={2}>Appearance</Heading>
                  <Text type="supporting" color="secondary">
                    A palette for your setup.
                  </Text>
                </Stack>
                <div className="theme-options" role="group" aria-label="Color theme">
                  {Object.entries(appearanceNames).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={cx("theme-option", preference === value && "selected")}
                      data-theme-choice={value}
                      aria-pressed={preference === value}
                      onClick={() => {
                        if (!chooseAppearance(value)) {
                          toast(
                            "Theme applied. This browser could not save your preference.",
                            true,
                          );
                        }
                      }}
                    >
                      <span
                        className={cx("theme-preview", `preview-${value}`)}
                        aria-hidden="true"
                      >
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="theme-label">{label}</span>
                      <small>{appearanceDescriptions[value]}</small>
                    </button>
                  ))}
                </div>
                <Text type="supporting" color="secondary">
                  Applies immediately and is remembered in this browser. System follows your
                  device’s light or dark appearance.
                </Text>
              </Stack>
            </Card>

            <Card>
              <Stack gap={3}>
                <Stack gap={0.5}>
                  <Heading level={2}>Campaigns</Heading>
                  <Text type="supporting" color="secondary">
                    Control which kinds of drops can be mined
                  </Text>
                </Stack>
                <Switch
                  data-setting="enableBadgesEmotes"
                  label="Badge and emote campaigns"
                  description="Include campaigns whose rewards are Twitch badges or emotes."
                  value={settings.enableBadgesEmotes}
                  onChange={(checked) => update({enableBadgesEmotes: checked})}
                />
                <Switch
                  data-setting="availableDropsCheck"
                  label="Verify drops on each channel"
                  description="Check campaign availability per channel before switching."
                  value={settings.availableDropsCheck}
                  onChange={(checked) => update({availableDropsCheck: checked})}
                />
              </Stack>
            </Card>

            <Card>
              <Stack gap={3}>
                <Stack gap={0.5}>
                  <Heading level={2}>Notifications</Heading>
                  <Text type="supporting" color="secondary">
                    Choose what appears in the activity feed
                  </Text>
                </Stack>
                <Switch
                  data-setting="trayNotifications"
                  label="Claim notifications"
                  description="Record a notification whenever a drop is claimed."
                  value={settings.trayNotifications}
                  onChange={(checked) => update({trayNotifications: checked})}
                />
              </Stack>
            </Card>

            <Card>
              <Stack gap={3}>
                <Stack gap={0.5}>
                  <Heading level={2}>Webhook notifications</Heading>
                  <Text type="supporting" color="secondary">
                    Send claim notifications to your configured service
                  </Text>
                </Stack>
                <TextInput
                  type="text"
                  label="Webhook URL"
                  autoComplete="off"
                  value={settings.webhookUrl ?? ""}
                  onChange={(value) => update({webhookUrl: value})}
                  description={
                    state.system.webhookManagedByEnvironment
                      ? "Managed by the launch environment."
                      : "Save the URL before sending a test notification."
                  }
                  isDisabled={Boolean(state.system.webhookManagedByEnvironment)}
                />
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    data-action="test-webhook"
                    label="Test notification"
                    isDisabled={dirty || (!settings.webhookUrl && !state.system.webhookManagedByEnvironment)}
                    onClick={() => void run("test-webhook", "Test notification")}
                  />
                </div>
              </Stack>
            </Card>

            <Card>
              <Stack gap={4}>
                <Stack gap={0.5}>
                  <Heading level={2}>Network</Heading>
                  <Text type="supporting" color="secondary">
                    Usually best left at the defaults
                  </Text>
                </Stack>
                <Stack gap={3}>
                  <Slider
                    label="Connection tolerance"
                    description="Higher values give slow or unreliable networks more time."
                    min={1}
                    max={6}
                    value={settings.connectionQuality}
                    onChange={(value: number) => update({connectionQuality: value})}
                    valueDisplay="text"
                    formatValue={(value) => `${value} / 6`}
                    marks={[
                      {value: 1, label: "Fast"},
                      {value: 6, label: "Tolerant"},
                    ]}
                    htmlName="connectionQuality"
                  />
                  <TextInput
                    id="proxy"
                    type="text"
                    label="HTTP proxy"
                    description="Optional. Include a scheme, hostname, and explicit port."
                    placeholder="http://localhost:3128"
                    autoComplete="off"
                    value={proxyDraft}
                    onChange={(value) => {
                      setProxyDraft(value);
                      update({proxy: value});
                    }}
                    status={proxyValid ? undefined : {type: "error"}}
                    statusVariant={proxyValid ? undefined : "attached"}
                  />
                  {!proxyValid ? (
                    <Text type="supporting" className="form-error" id="proxy-error">
                      Enter a complete proxy URL including its port.
                    </Text>
                  ) : null}
                </Stack>
              </Stack>
            </Card>

            <SaveBar />
          </Stack>

          <Stack gap={4} className="settings-rail">
            <Card variant="muted">
              <Stack gap={3}>
                <Heading level={3}>Your mining plan</Heading>
                <Text type="supporting" color="secondary">
                  Choose your priority games, exclude others, and decide what to mine next.
                </Text>
                <div>
                  <Button variant="secondary" size="sm" href="/mining" label="Open mining plan" />
                </div>
              </Stack>
            </Card>

            <Card className="danger-zone">
              <Stack gap={3}>
                <Stack gap={0.5}>
                  <Heading level={3}>Account and system</Heading>
                  <Text type="supporting" color="secondary">
                    Actions that interrupt the miner
                  </Text>
                </Stack>
                <Stack direction="horizontal" gap={2} wrap="wrap">
                  <Button
                    variant="secondary"
                    size="sm"
                    data-action="logout"
                    isDisabled={!state.canLogout || pending !== null}
                    label="Disconnect Twitch"
                    onClick={() => void run("logout", "Disconnect Twitch")}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    data-action="restart"
                    isDisabled={pending !== null}
                    label="Restart miner"
                    onClick={() => void run("restart", "Restart miner")}
                  />
                  <Button
                    variant="destructive"
                    size="sm"
                    data-action="shutdown"
                    isDisabled={pending !== null}
                    label="Shut down"
                    onClick={() => void run("shutdown", "Shut down")}
                  />
                </Stack>
              </Stack>
            </Card>

            <Card>
              <Stack gap={3}>
                <Heading level={3}>Data</Heading>
                <Text type="supporting" color="secondary">
                  Export or restore settings and statistics.
                </Text>
                <Stack direction="horizontal" gap={2} wrap="wrap">
                  <Button
                    variant="secondary"
                    size="sm"
                    href="/api/export?stats=1"
                    label="Export settings & stats"
                  />
                  <label className="button secondary small import-label">
                    Import settings
                    <input
                      type="file"
                      accept="application/json"
                      data-import-settings
                      hidden
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        file
                          .text()
                          .then((text) => request("/api/import", {method: "POST", body: text}))
                          .then(() => {
                            toast("Settings imported");
                            location.reload();
                          })
                          .catch((error: unknown) =>
                            toast(
                              error instanceof Error && error.message
                                ? error.message
                                : "Import failed",
                              true,
                            ),
                          );
                      }}
                    />
                  </label>
                </Stack>
              </Stack>
            </Card>
          </Stack>
        </div>
      </Stack>
    </Page>
  );
}
