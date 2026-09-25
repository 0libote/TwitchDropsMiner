/**
 * Campaigns: the account's drop inventory, filterable and searchable.
 */

import {useState} from "react";
import {TextInput} from "@astryxdesign/core/TextInput";
import {SegmentedControl, SegmentedControlItem} from "@astryxdesign/core/SegmentedControl";
import {Badge} from "@astryxdesign/core/Badge";
import {Link} from "@astryxdesign/core/Link";
import {ProgressBar} from "@astryxdesign/core/ProgressBar";
import {EmptyState} from "@astryxdesign/core/EmptyState";
import {Text} from "@astryxdesign/core/Text";
import {Stack} from "@astryxdesign/core/Stack";
import {Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow} from "@astryxdesign/core/Table";
import {Button} from "@astryxdesign/core/Button";
import type {CampaignJson} from "../../web/api-types";
import {Page, PageHeader, Artwork} from "../shell/parts";
import {useAction} from "../core/actions";
import {RefreshIcon, SearchIcon} from "../core/icons";
import {formatDate} from "../core/format";
import {useStore} from "../core/store";

export type CampaignFilter = "available" | "active" | "upcoming" | "finished" | "all";

export function campaignBadge(campaign: CampaignJson): [string, "success" | "warning" | "error" | "neutral"] {
  if (campaign.finished) return ["Completed", "success"];
  if (!campaign.linked) return ["Account link needed", "error"];
  if (!campaign.eligible) return ["Unavailable", "error"];
  if (campaign.status === "active") return ["Active", "success"];
  if (campaign.status === "upcoming") return ["Upcoming", "warning"];
  if (campaign.status === "expired") return ["Expired", "neutral"];
  return ["Unavailable", "error"];
}

function feasibility(campaign: CampaignJson): boolean {
  if (campaign.finished || campaign.status !== "active" || !campaign.remainingMinutes) return false;
  const available = (new Date(campaign.endsAt).getTime() - Date.now()) / 60000;
  return available < campaign.remainingMinutes;
}

export function Campaigns() {
  const {state, settings} = useStore();
  const {run, pending} = useAction();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CampaignFilter>("all");

  const needle = query.trim().toLocaleLowerCase();
  const campaigns = state.campaigns
    .filter((campaign) => {
      const matchesQuery =
        !needle || `${campaign.name} ${campaign.game}`.toLocaleLowerCase().includes(needle);
      const matchesFilter =
        filter === "all" ||
        (filter === "available" &&
          campaign.status === "active" &&
          campaign.eligible &&
          !campaign.finished) ||
        (filter === "finished" && campaign.finished) ||
        filter === campaign.status;
      return matchesQuery && matchesFilter;
    })
    .sort(
      (a, b) =>
        Number(b.status === "active") - Number(a.status === "active") ||
        new Date(a.endsAt).getTime() - new Date(b.endsAt).getTime(),
    );

  return (
    <Page>
      <Stack gap={5}>
        <PageHeader
          title="Campaigns"
          description="Discover rewards and track your collection"
          actions={
            <Button
              variant="secondary"
              data-action="reload"
              icon={<RefreshIcon />}
              label="Refresh inventory"
              isDisabled={!state.canLogout || pending !== null}
              onClick={() => run("reload", "Refresh inventory")}
            />
          }
        />

        <Stack direction="horizontal" gap={3} align="center" className="campaign-toolbar">
          <TextInput
            type="text"
            label="Search campaigns"
            isLabelHidden
            placeholder="Search campaigns or games"
            startIcon={<SearchIcon />}
            hasClear
            value={query}
            onChange={setQuery}
            data-testid="campaign-search"
            width="100%"
          />
          <SegmentedControl
            label="Campaign filter"
            value={filter}
            onChange={(value) => setFilter(value as CampaignFilter)}
          >
            <SegmentedControlItem value="available" label="Available" />
            <SegmentedControlItem value="active" label="Active" />
            <SegmentedControlItem value="upcoming" label="Upcoming" />
            <SegmentedControlItem value="finished" label="Completed" />
            <SegmentedControlItem value="all" label="All" />
          </SegmentedControl>
        </Stack>

        <Text type="supporting" color="secondary" id="collection-summary">
          {campaigns.length} campaign{campaigns.length === 1 ? "" : "s"} · Ordered by end date,
          active first
        </Text>

        {campaigns.length ? (
          <Table
            id="campaign-list"
            density="balanced"
            hasHover
            dividers="rows"
            className="campaign-list"
          >
            <TableHeader>
              <TableRow isHeaderRow>
                <TableHeaderCell>Campaign</TableHeaderCell>
                <TableHeaderCell>Progress</TableHeaderCell>
                <TableHeaderCell>Window</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.map((campaign) => {
                const [label, variant] = campaignBadge(campaign);
                const prioritized = settings.priority.includes(campaign.game);
                const upcoming = campaign.status === "upcoming";
                return (
                  <TableRow key={campaign.id} className="campaign-row">
                    <TableCell className="campaign-name-cell">
                      <Stack direction="horizontal" gap={3} align="center">
                        <Artwork className="campaign-image" src={campaign.image} alt="" />
                        <Stack gap={0.5} className="campaign-name">
                          <Link href={`/campaigns/${encodeURIComponent(campaign.id)}`} data-route>
                            {campaign.name}
                          </Link>
                          <Text type="supporting" color="secondary">
                            {campaign.game}
                          </Text>
                        </Stack>
                      </Stack>
                    </TableCell>
                    <TableCell className="campaign-progress">
                      <Stack gap={1.5}>
                        <Text type="supporting" color="secondary">
                          {campaign.claimedDrops}/{campaign.totalDrops} drops ·{" "}
                          {Math.round(campaign.progress * 100)}%
                        </Text>
                        <ProgressBar
                          value={Math.round(campaign.progress * 100)}
                          max={100}
                          label={`${campaign.name} progress`}
                          isLabelHidden
                        />
                      </Stack>
                    </TableCell>
                    <TableCell className="campaign-time">
                      <Stack gap={0.5}>
                        <Text>
                          {upcoming ? "Starts" : "Ends"}{" "}
                          {formatDate(
                            upcoming ? campaign.startsAt : campaign.endsAt,
                            true,
                          )}
                        </Text>
                        <Text type="supporting" color="secondary">
                          {formatDate(upcoming ? campaign.startsAt : campaign.endsAt)}
                        </Text>
                      </Stack>
                    </TableCell>
                    <TableCell className="campaign-status">
                      <Stack gap={1} align="start">
                        <Badge variant={variant} label={label} />
                        {prioritized ? (
                          <Text type="supporting" color="secondary">
                            Prioritized
                          </Text>
                        ) : null}
                        {feasibility(campaign) ? (
                          <Text type="supporting" color="secondary">
                            May not finish in time
                          </Text>
                        ) : null}
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <EmptyState
            title="No matching campaigns"
            description="Try another search or filter."
            headingLevel={3}
          />
        )}
      </Stack>
    </Page>
  );
}
