/**
 * Mining plan: priority order, fallback rule, exclusions and live channels.
 *
 * The editor is a form with a save bar; the channel list underneath is live
 * and never rebuilt while the user is typing above it.
 */

import {IconButton} from "@astryxdesign/core/IconButton";
import {Text, Heading} from "@astryxdesign/core/Text";
import {Button} from "@astryxdesign/core/Button";
import {Card} from "@astryxdesign/core/Card";
import {StatusDot} from "@astryxdesign/core/StatusDot";
import {EmptyState} from "@astryxdesign/core/EmptyState";
import {List, ListItem} from "@astryxdesign/core/List";
import {Token} from "@astryxdesign/core/Token";
import {Stack} from "@astryxdesign/core/Stack";
import {Page, PageHeader, SectionTitle} from "../shell/parts";
import {GamePicker} from "../shell/GamePicker";
import {SaveBar} from "../shell/SaveBar";
import {ChevronDownIcon, ChevronUpIcon, CloseIcon, GiftIcon} from "../core/icons";
import {request} from "../core/api";
import {useStore} from "../core/store";
import {cx} from "../core/util";

const FALLBACK_RULES: Array<[string, string]> = [
  ["PRIORITY_ONLY", "Do not mine other games"],
  ["ENDING_SOONEST", "Campaign ending soonest"],
  ["LOW_AVBL_FIRST", "Lowest channel availability"],
];

export function Mining() {
  const {state, settings, update, toast} = useStore();

  const move = (index: number, delta: -1 | 1 | 0) => {
    const priority = [...settings.priority];
    if (delta === 0) priority.splice(index, 1);
    else {
      const target = index + delta;
      if (target < 0 || target >= priority.length) return;
      const current = priority[index] as string;
      const other = priority[target] as string;
      priority[index] = other;
      priority[target] = current;
    }
    update({priority});
  };

  const addGame = (list: "priority" | "exclude", game: string) => {
    const other = list === "priority" ? "exclude" : "priority";
    const next = {
      priority: settings.priority.filter((item) => item !== game),
      exclude: settings.exclude.filter((item) => item !== game),
    };
    if (!next[list].includes(game)) next[list].push(game);
    update({...next, [other]: next[other]});
  };

  const removeExcluded = (game: string) => {
    update({exclude: settings.exclude.filter((item) => item !== game)});
  };

  const switchChannel = async (id: number) => {
    try {
      await request(`/api/channels/${id}`, {method: "POST"});
      toast("Channel switch requested");
    } catch (error) {
      toast(error instanceof Error && error.message ? error.message : "Unable to switch channel", true);
    }
  };

  const channels = [...state.channels].sort(
    (a, b) =>
      Number(b.watching) - Number(a.watching) ||
      Number(b.watchable) - Number(a.watchable) ||
      (b.viewers ?? 0) - (a.viewers ?? 0),
  );

  return (
    <Page>
      <Stack gap={6}>
        <PageHeader title="Mining plan" description="Choose what to watch next" />

        <div className="mining-layout">
          <Card className="queue-editor">
            <Stack gap={4}>
              <Stack gap={0.5}>
                <Heading level={2}>Game priority</Heading>
                <Text type="supporting" color="secondary">
                  The first eligible game with a live channel is mined
                </Text>
              </Stack>

              <Stack id="priority-rows" className="priority-rows">
                {settings.priority.length ? (
                  <List hasDividers>
                    {settings.priority.map((game, index) => (
                      <ListItem
                        key={game}
                        startContent={
                          <Text type="supporting" color="secondary" className="queue-number">
                            {index + 1}
                          </Text>
                        }
                        label={<Text weight="semibold">{game}</Text>}
                        description={
                          index === 0 ? "First choice" : "Mined after higher priorities"
                        }
                        endContent={
                          <Stack direction="horizontal" gap={1} className="queue-controls">
                            <IconButton
                              label={`Move ${game} up`}
                              size="sm"
                              variant="ghost"
                              isDisabled={index === 0}
                              icon={<ChevronUpIcon />}
                              onClick={() => move(index, -1)}
                            />
                            <IconButton
                              label={`Move ${game} down`}
                              size="sm"
                              variant="ghost"
                              isDisabled={index === settings.priority.length - 1}
                              icon={<ChevronDownIcon />}
                              onClick={() => move(index, 1)}
                            />
                            <IconButton
                              label={`Remove ${game}`}
                              size="sm"
                              variant="ghost"
                              icon={<CloseIcon />}
                              onClick={() => move(index, 0)}
                            />
                          </Stack>
                        }
                      />
                    ))}
                  </List>
                ) : (
                  <EmptyState
                    title="No priority games"
                    description="Add games below or let the miner choose automatically."
                    headingLevel={3}
                    isCompact
                    icon={<GiftIcon />}
                  />
                )}
              </Stack>

              <GamePicker
                listName="priority"
                placeholder="Search discovered games"
                onAdd={(game) => addGame("priority", game)}
              />
            </Stack>
          </Card>

          <Stack gap={4}>
            <Card>
              <Stack gap={3}>
                <Stack gap={0.5}>
                  <Heading level={2}>Fallback rule</Heading>
                  <Text type="supporting" color="secondary">
                    Used after priority games
                  </Text>
                </Stack>
                <label className="field-label" htmlFor="priority-mode">
                  Order other eligible games
                </label>
                <select
                  id="priority-mode"
                  className="select"
                  value={settings.priorityMode}
                  onChange={(event) => update({priorityMode: event.target.value})}
                >
                  {FALLBACK_RULES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Stack>
            </Card>

            <Card>
              <Stack gap={3}>
                <Stack gap={0.5}>
                  <Heading level={2}>Excluded games</Heading>
                  <Text type="supporting" color="secondary">
                    Never select these games
                  </Text>
                </Stack>
                <Stack
                  direction="horizontal"
                  gap={2}
                  wrap="wrap"
                  id="excluded-tags"
                  className="excluded-tags"
                >
                  {settings.exclude.length ? (
                    settings.exclude.map((game) => (
                      <Token
                        key={game}
                        label={game}
                        color="gray"
                        onRemove={() => removeExcluded(game)}
                      />
                    ))
                  ) : (
                    <Text type="supporting" color="secondary">
                      No games excluded.
                    </Text>
                  )}
                </Stack>
                <GamePicker
                  listName="exclude"
                  placeholder="Search discovered games"
                  onAdd={(game) => addGame("exclude", game)}
                />
              </Stack>
            </Card>
          </Stack>
        </div>

        <SaveBar />

        <Stack gap={3}>
          <SectionTitle
            title="Channels"
            description="Streams discovered for your mining plan"
            id="channel-heading"
            action={
              <Text type="supporting" color="secondary" id="channel-count">
                {channels.filter((channel) => channel.online).length} live ·{" "}
                {channels.filter((channel) => channel.watchable).length} eligible
              </Text>
            }
          />
          <Stack id="channel-list" className="channel-list">
            {channels.length ? (
              <List hasDividers>
                {channels.map((channel) => (
                  <ListItem
                    key={channel.id}
                    label={
                      <Stack direction="horizontal" gap={2} align="center" wrap="wrap">
                        <Text weight="semibold">{channel.name}</Text>
                        {channel.watching ? (
                          <StatusDot variant="success" label="Watching" className="live" />
                        ) : null}
                      </Stack>
                    }
                    description={
                      <>
                        {channel.title || (channel.online ? "Live" : "Offline")}
                        <span className="channel-meta">
                          {" · "}
                          {channel.game || "No game"}
                          {channel.dropsEnabled ? " · Drops enabled" : " · Drops unavailable"}
                        </span>
                      </>
                    }
                    endContent={
                      <Stack direction="horizontal" gap={3} align="center">
                        <span className={cx("channel-viewers")}>
                          <strong>
                            {channel.viewers == null
                              ? "—"
                              : Number(channel.viewers).toLocaleString()}
                          </strong>
                          <small>viewers</small>
                        </span>
                        <Button
                          size="sm"
                          variant={channel.watching ? "primary" : "secondary"}
                          data-channel={channel.id}
                          isDisabled={!channel.watchable || channel.watching}
                          onClick={() => void switchChannel(channel.id)}
                          label={
                            channel.watching
                              ? "Watching"
                              : channel.watchable
                                ? "Switch"
                                : "Unavailable"
                          }
                        />
                      </Stack>
                    }
                  />
                ))}
              </List>
            ) : (
              <EmptyState
                title="No eligible live channels"
                description="The miner will keep checking automatically."
                headingLevel={3}
              />
            )}
          </Stack>
        </Stack>
      </Stack>
    </Page>
  );
}
