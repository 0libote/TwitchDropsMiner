/**
 * Overview: what is being earned right now, what happens next, and what
 * happened recently.
 *
 * The active reward owns the page; session facts sit in a quieter rail, and
 * the mining plan plus activity feed sit underneath as rows.
 */

import {Card} from "@astryxdesign/core/Card";
import {Button} from "@astryxdesign/core/Button";
import {Link} from "@astryxdesign/core/Link";
import {ProgressBar} from "@astryxdesign/core/ProgressBar";
import {StatusDot} from "@astryxdesign/core/StatusDot";
import {EmptyState} from "@astryxdesign/core/EmptyState";
import {Heading, Text} from "@astryxdesign/core/Text";
import {Stack} from "@astryxdesign/core/Stack";
import {List, ListItem} from "@astryxdesign/core/List";
import {MetadataList, MetadataListItem} from "@astryxdesign/core/MetadataList";
import {Page, PageHeader, SectionTitle, Artwork, MoreLink} from "../shell/parts";
import {useAction} from "../core/actions";
import {ArrowIcon, CheckIcon, GiftIcon, PauseIcon, PlayIcon, RefreshIcon} from "../core/icons";
import {
  formatClockTime,
  formatDate,
  formatDuration,
  formatMinutes,
  percent,
  priorityLabels,
  safeUrl,
} from "../core/format";
import {useStore} from "../core/store";
import {cx} from "../core/util";

export function Overview() {
  const {state, connected, settings} = useStore();
  const {run, pending} = useAction();

  const drop = state.activeDrop;
  const campaign = state.campaigns.find((item) =>
    item.drops.some((itemDrop) => itemDrop.id === drop?.id),
  );
  const channel = state.channels.find((item) => item.watching) ?? null;
  const paused = state.paused === true;
  const mining = connected && !paused && ["active", "pickaxe"].includes(state.activity);
  const canAct = Boolean(state.canLogout);

  const statusKind: "success" | "warning" | "error" = !connected
    ? "error"
    : state.activity === "error"
      ? "error"
      : mining
        ? "success"
        : "warning";
  const statusLabel = !connected
    ? "Connection interrupted"
    : paused
      ? "Paused"
      : state.activity === "error"
        ? "Miner needs attention"
        : mining && drop
          ? "Currently mining"
          : "Waiting for drops";

  const heading = paused ? "Mining is paused" : drop?.rewards || "Ready for the next drop";
  const explanation = paused
    ? "Your progress is saved. Resume whenever you’re ready."
    : drop
      ? drop.name
      : "Waiting for an eligible campaign and a live channel. The miner will keep checking.";

  const plan =
    state.miningPlan ??
    state.settings.priority.map((game) => ({
      game,
      campaignId: null,
      image: null,
      reason: "Priority preference; selection details unavailable",
      priority: true,
      watching: false,
      estimatedCompletionAt: null,
    }));

  const events = [
    ...(state.notifications ?? []).map((item) => ({
      title: item.title,
      text: item.message,
      time: item.time,
      notification: true,
    })),
    ...(state.messages ?? [])
      .slice(-8)
      .reverse()
      .map((item) => ({
        title: "Miner",
        text: item.message || String(item),
        time: item.time,
        notification: false,
      })),
  ]
    .sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0))
    .slice(0, 4);

  const stats = state.stats;
  const priorityOnly = settings.priorityMode === "PRIORITY_ONLY";

  return (
    <Page>
      <Stack gap={6}>
        <PageHeader
          title="Overview"
          description="Your drops, at a glance"
          actions={
            <>
              <Button
                variant="secondary"
                data-action={paused ? "resume" : "pause"}
                isDisabled={!canAct || pending !== null}
                icon={paused ? <PlayIcon /> : <PauseIcon />}
                label={paused ? "Resume mining" : "Pause mining"}
                onClick={() => run(paused ? "resume" : "pause", paused ? "Resume mining" : "Pause mining")}
              />
              <Button
                variant="secondary"
                data-action="reload"
                isDisabled={!canAct || pending !== null}
                icon={<RefreshIcon />}
                label="Refresh"
                onClick={() => run("reload", "Refresh")}
              />
            </>
          }
        />

        <div className="overview-grid">
          <Card className="now-card">
            <Stack gap={5}>
              <Stack direction="horizontal" justify="between" align="center" gap={3} className="now-status">
                <Stack direction="horizontal" gap={2} align="center">
                  <StatusDot variant={statusKind} label={statusLabel} />
                  <Text type="label" color="secondary">
                    {statusLabel}
                  </Text>
                </Stack>
                {campaign ? (
                  <Link href={`/campaigns/${encodeURIComponent(campaign.id)}`} data-route>
                    View campaign
                    <ArrowIcon />
                  </Link>
                ) : null}
              </Stack>

              <Stack direction="horizontal" gap={5} align="center" className="reward-stage">
                <Artwork
                  className="reward-art"
                  src={drop?.benefits?.[0]?.image}
                  alt={drop?.rewards ?? ""}
                />
                <Stack gap={2} className="reward-copy">
                  {campaign ? (
                    <Text type="label" color="accent" className="reward-game">
                      {campaign.game}
                    </Text>
                  ) : null}
                  <Heading level={2} id="now-heading">
                    {heading}
                  </Heading>
                  <Text color="secondary">{explanation}</Text>
                  <Text type="supporting" color="secondary" className="progress-health">
                    {state.progressHealth?.lastConfirmedAt
                      ? `Last confirmed progress ${formatDate(state.progressHealth.lastConfirmedAt, true)}. `
                      : "No confirmed progress yet. "}
                    {state.progressHealth?.recoveryReason ?? ""}
                    {state.progressHealth?.nextRecoveryInSeconds != null
                      ? ` Next recovery check in ${Math.ceil(
                          state.progressHealth.nextRecoveryInSeconds / 60,
                        )} min.`
                      : ""}
                  </Text>

                  {drop ? (
                    <Stack gap={2} className="reward-progress">
                      <div className="progress-numbers">
                        <strong>
                          {percent(drop.progress)}
                          <span>%</span>
                        </strong>
                        <span>{formatMinutes(drop.remainingMinutes)}</span>
                      </div>
                      <ProgressBar
                        value={percent(drop.progress)}
                        max={100}
                        label="Current drop progress"
                        isLabelHidden
                      />
                      <div className="progress-meta">
                        <span>
                          {drop.currentMinutes} of {drop.requiredMinutes} minutes watched
                        </span>
                        <span>{!connected || paused ? "Progress saved" : "Claims automatically"}</span>
                      </div>
                    </Stack>
                  ) : (
                    <Button
                      variant="secondary"
                      href="/campaigns"
                      label="Browse campaigns"
                      icon={<ArrowIcon />}
                      className="browse-button"
                    />
                  )}
                </Stack>
              </Stack>
            </Stack>

            {campaign ? (
              <Stack gap={3} id="reward-track" className="reward-track-block">
                <div className="reward-track-heading">
                  <Text type="supporting" color="secondary">
                    Campaign rewards
                  </Text>
                  <Text type="supporting" color="secondary">
                    {campaign.claimedDrops} of {campaign.totalDrops} claimed
                  </Text>
                </div>
                <ol className="reward-track">
                  {campaign.drops.slice(0, 4).map((reward, index) => (
                    <li
                      key={reward.id}
                      className={reward.claimed ? "claimed" : reward.id === drop?.id ? "current" : ""}
                    >
                      <span className="reward-step" aria-hidden="true">
                        {reward.claimed ? <CheckIcon /> : String(index + 1).padStart(2, "0")}
                      </span>
                      <div>
                        <strong>{reward.rewards || reward.name}</strong>
                        <small>
                          {reward.claimed
                            ? "Claimed"
                            : reward.id === drop?.id
                              ? paused
                                ? "Paused"
                                : "In progress"
                              : reward.claimable
                                ? "Ready to claim"
                                : `${reward.requiredMinutes} min watch time`}
                        </small>
                      </div>
                    </li>
                  ))}
                </ol>
                {campaign.drops.length > 4 ? (
                  <Link
                    href={`/campaigns/${encodeURIComponent(campaign.id)}`}
                    data-route
                    className="more-rewards"
                  >
                    View all {campaign.totalDrops} rewards
                    <ArrowIcon />
                  </Link>
                ) : null}
              </Stack>
            ) : null}
          </Card>

          <Stack gap={4} className="session-rail">
            <SectionTitle
              title="This session"
              action={<MoreLink href="/diagnostics">Details</MoreLink>}
            />
            <Stack direction="horizontal" gap={3} align="center" className="stream-summary">
              <span className="stream-avatar" aria-hidden="true">
                {channel?.name?.slice(0, 2).toUpperCase() || "—"}
              </span>
              <Stack gap={0.5}>
                <Text type="supporting" color="secondary">
                  {mining && channel ? "Watching on Twitch" : "Selected channel"}
                </Text>
                {channel ? (
                  <Link href={safeUrl(channel.url)} isExternalLink className="channel-link">
                    {channel.name}
                  </Link>
                ) : (
                  <Text weight="semibold">Finding a channel</Text>
                )}
              </Stack>
            </Stack>
            <Text type="supporting" color="secondary" className="stream-title">
              {channel ? channel.title || channel.game || "" : "Eligible live streams appear automatically."}
            </Text>

            <MetadataList id="stat-cards" columns={1}>
              <MetadataListItem label="Drops claimed">
                <span className="claimed-total">
                  {stats.session?.drops_claimed || 0}
                  <small>{stats.lifetime?.drops_claimed || 0} this installation</small>
                </span>
              </MetadataListItem>
              <MetadataListItem label="Time mining">
                {formatDuration((stats.session?.mining_minutes || 0) * 60)}
              </MetadataListItem>
              <MetadataListItem label="Session uptime">
                {formatDuration(stats.uptimeSeconds || 0)}
              </MetadataListItem>
              <MetadataListItem label="Selection rule">
                {priorityLabels[settings.priorityMode] ?? "Automatic"}
              </MetadataListItem>
            </MetadataList>
          </Stack>
        </div>

        <div className="overview-lower">
          <Stack gap={3}>
            <SectionTitle
              title="Your mining plan"
              description="Game selection order and availability."
              action={<MoreLink href="/mining">Edit queue</MoreLink>}
              id="queue-heading"
            />
            <Stack id="queue-preview" className="queue-preview">
              {plan.length ? (
                <List hasDividers>
                  {plan.slice(0, 5).map((item, index) => {
                    const isMining = mining && item.watching;
                    return (
                      <ListItem
                        key={`${item.game}-${index}`}
                        startContent={
                          <Stack direction="horizontal" gap={2} align="center">
                            <Text type="supporting" color="secondary" className="queue-number">
                              {String(index + 1).padStart(2, "0")}
                            </Text>
                            <Artwork className="queue-art" src={item.image} alt="" />
                          </Stack>
                        }
                        label={
                          item.campaignId ? (
                            <Link href={`/campaigns/${encodeURIComponent(item.campaignId)}`} data-route>
                              {item.game}
                            </Link>
                          ) : (
                            <Text weight="semibold">{item.game}</Text>
                          )
                        }
                        description={
                          <>
                            {item.reason}
                            {item.estimatedCompletionAt
                              ? ` · Earliest completion ${formatDate(item.estimatedCompletionAt)}`
                              : ""}
                          </>
                        }
                        endContent={
                          <span className={cx("queue-state", !isMining && "muted")}>
                            {isMining ? (
                              <StatusDot variant="success" label="Mining" className="live" />
                            ) : null}
                            {isMining
                              ? "Mining"
                              : item.priority
                                ? "Priority"
                                : "Automatic"}
                          </span>
                        }
                      />
                    );
                  })}
                </List>
              ) : (
                <EmptyState
                  title="No games selected for mining"
                  description="Check campaign availability, account links and your mining preferences."
                  icon={<GiftIcon />}
                  headingLevel={3}
                  actions={
                    <Button variant="secondary" href="/mining" label="Open mining plan" />
                  }
                />
              )}
            </Stack>
            <Text type="supporting" color="secondary" id="queue-rule">
              {plan.length > 5 ? `${plan.length - 5} more games in your plan. ` : ""}{" "}
              {priorityOnly
                ? "Only priority games will be mined."
                : "Automatic games follow the selection rule when priorities are unavailable."}{" "}
              Estimates assume uninterrupted eligible viewing; outages, pauses and prerequisites can
              delay completion.
            </Text>
          </Stack>

          <Stack gap={3}>
            <SectionTitle
              title="Recent activity"
              action={<MoreLink href="/diagnostics">All activity</MoreLink>}
              id="activity-heading"
            />
            <Stack id="activity-preview" className="activity-preview">
              {events.length ? (
                <List hasDividers>
                  {events.map((item, index) => (
                    <ListItem
                      key={`${item.title}-${item.time}-${index}`}
                      startContent={
                        <span
                          className={cx("activity-mark", item.notification && "notification")}
                          aria-hidden="true"
                        >
                          {item.notification ? <GiftIcon /> : <CheckIcon />}
                        </span>
                      }
                      label={
                        <span className="activity-heading">
                          <strong>{item.title}</strong>
                          {item.time ? (
                            <time dateTime={item.time} title={formatDate(item.time)}>
                              {formatClockTime(item.time)}
                            </time>
                          ) : null}
                        </span>
                      }
                      description={item.text}
                    />
                  ))}
                </List>
              ) : (
                <EmptyState
                  title="No activity yet"
                  description="Progress updates and claimed drops will appear here."
                  headingLevel={3}
                  isCompact
                />
              )}
            </Stack>
          </Stack>
        </div>
      </Stack>
    </Page>
  );
}
