/**
 * Campaign detail: one campaign's drops, availability and mining preference.
 */

import {Badge} from "@astryxdesign/core/Badge";
import {Button} from "@astryxdesign/core/Button";
import {Card} from "@astryxdesign/core/Card";
import {Heading, Text} from "@astryxdesign/core/Text";
import {Link} from "@astryxdesign/core/Link";
import {ProgressBar} from "@astryxdesign/core/ProgressBar";
import {EmptyState} from "@astryxdesign/core/EmptyState";
import {Stack} from "@astryxdesign/core/Stack";
import {List, ListItem} from "@astryxdesign/core/List";
import type {CampaignJson} from "../../web/api-types";
import {Page, Artwork} from "../shell/parts";
import {campaignBadge} from "./Campaigns";
import {ArrowLeftIcon, GiftIcon} from "../core/icons";
import {formatDate, formatMinutes, safeUrl} from "../core/format";
import {useStore} from "../core/store";

function dropBadge(drop: CampaignJson["drops"][number]): [string, "success" | "warning" | "neutral"] {
  if (drop.claimed) return ["Claimed", "success"];
  if (drop.claimable) return ["Ready to claim", "warning"];
  return [`${Math.round(drop.progress * 100)}%`, "neutral"];
}

export function CampaignDetail({campaign}: {campaign: CampaignJson | undefined}) {
  const {settings, save} = useStore();

  if (!campaign) {
    return (
      <Page>
        <Card className="not-found">
          <EmptyState
            title="Campaign not found"
            description="It may have disappeared during an inventory refresh."
            headingLevel={2}
            actions={<Button variant="secondary" href="/campaigns" label="Back to campaigns" />}
          />
        </Card>
      </Page>
    );
  }

  const [label, variant] = campaignBadge(campaign);
  const isPriority = settings.priority.includes(campaign.game);
  const isExcluded = settings.exclude.includes(campaign.game);

  const setPreference = (mode: "priority" | "exclude") => {
    const priority = settings.priority.filter((game) => game !== campaign.game);
    const exclude = settings.exclude.filter((game) => game !== campaign.game);
    if (mode === "priority") priority.unshift(campaign.game);
    else exclude.push(campaign.game);
    return save(
      {...settings, priority, exclude},
      mode === "priority" ? `${campaign.game} moved to the front` : `${campaign.game} excluded`,
    );
  };

  return (
    <Page>
      <Stack gap={5}>
        <Link href="/campaigns" data-route className="back-link">
          <ArrowLeftIcon />
          All campaigns
        </Link>

        <div className="campaign-detail">
          <Stack gap={5}>
            <Card>
              <Stack gap={4}>
                <Stack direction="horizontal" gap={4} align="center" className="campaign-summary">
                  <Artwork className="campaign-image large" src={campaign.image} alt="" />
                  <Stack gap={1.5}>
                    <Stack direction="horizontal" gap={2} align="center">
                      <Badge variant={variant} label={label} />
                      {isPriority ? <Badge variant="info" label="Prioritized" /> : null}
                      {isExcluded ? <Badge variant="warning" label="Excluded" /> : null}
                    </Stack>
                    <Heading level={1}>{campaign.name}</Heading>
                    <Text color="secondary">{campaign.game}</Text>
                  </Stack>
                </Stack>

                <Stack gap={2}>
                  <div className="progress-numbers">
                    <strong>
                      {Math.round(campaign.progress * 100)}
                      <span>%</span>
                    </strong>
                    <span>
                      {campaign.claimedDrops} of {campaign.totalDrops} drops claimed
                    </span>
                  </div>
                  <ProgressBar
                    value={Math.round(campaign.progress * 100)}
                    max={100}
                    label={`${campaign.name} completion`}
                    isLabelHidden
                  />
                </Stack>
              </Stack>
            </Card>

            <Card>
              <Stack gap={3}>
                <Heading level={2}>Drops</Heading>
                {campaign.drops.length ? (
                  <List hasDividers>
                    {campaign.drops.map((drop) => {
                      const benefit = drop.benefits?.[0];
                      const [dropLabel, dropVariant] = dropBadge(drop);
                      return (
                        <ListItem
                          key={drop.id}
                          startContent={
                            <Artwork className="drop-art" src={benefit?.image} alt="" />
                          }
                          label={
                            <Stack gap={0.5}>
                              <Text weight="semibold">{drop.rewards || drop.name}</Text>
                              <Text type="supporting" color="secondary">
                                {drop.name} · {drop.currentMinutes}/{drop.requiredMinutes} minutes
                              </Text>
                              {drop.prerequisites?.length ? (
                                <Text type="supporting" color="secondary">
                                  Requires:{" "}
                                  {drop.prerequisites
                                    .map(
                                      (item) =>
                                        `${item.name} (${item.claimed ? "claimed" : "not claimed"})`,
                                    )
                                    .join(", ")}
                                </Text>
                              ) : null}
                            </Stack>
                          }
                          endContent={
                            <Stack gap={1} align="end">
                              <Badge variant={dropVariant} label={dropLabel} />
                            </Stack>
                          }
                        />
                      );
                    })}
                  </List>
                ) : (
                  <EmptyState
                    title="No drops in this campaign"
                    headingLevel={3}
                    isCompact
                    icon={<GiftIcon />}
                  />
                )}
              </Stack>
            </Card>
          </Stack>

          <Stack gap={4} className="detail-rail">
            <Card>
              <Stack gap={2}>
                <Heading level={3}>Availability</Heading>
                <Text color="secondary">Starts {formatDate(campaign.startsAt)}</Text>
                <Text color="secondary">Ends {formatDate(campaign.endsAt)}</Text>
                <Text type="supporting" color="secondary">
                  {formatMinutes(campaign.remainingMinutes)} of eligible viewing. This excludes
                  waiting for live channels and earlier games in your plan.
                </Text>
              </Stack>
            </Card>

            {!campaign.linked && campaign.linkUrl ? (
              <Card variant="muted">
                <Stack gap={3}>
                  <Heading level={3}>Account connection required</Heading>
                  <Text type="supporting" color="secondary">
                    Connect the game account associated with this campaign before its rewards can be
                    earned.
                  </Text>
                  <Button
                    variant="primary"
                    size="sm"
                    href={safeUrl(campaign.linkUrl)}
                    target="_blank"
                    rel="noreferrer"
                    label="Open connection page"
                  />
                </Stack>
              </Card>
            ) : null}

            <Card>
              <Stack gap={3}>
                <Heading level={3}>Mining preference</Heading>
                <Text type="supporting" color="secondary">
                  The miner chooses games, so this preference applies to every eligible campaign for{" "}
                  {campaign.game}.
                </Text>
                <Stack direction="horizontal" gap={2} wrap="wrap">
                  <Button
                    variant={isPriority ? "secondary" : "primary"}
                    size="sm"
                    data-preference="priority"
                    data-game={campaign.game}
                    isDisabled={isPriority}
                    label={isPriority ? "Prioritized" : "Mine this game first"}
                    onClick={() => void setPreference("priority")}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    data-preference="exclude"
                    data-game={campaign.game}
                    isDisabled={isExcluded}
                    label={isExcluded ? "Excluded" : "Exclude game"}
                    onClick={() => void setPreference("exclude")}
                  />
                </Stack>
              </Stack>
            </Card>
          </Stack>
        </div>
      </Stack>
    </Page>
  );
}
