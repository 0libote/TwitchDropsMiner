/**
 * Reward history: everything this miner has observed or recorded, searchable
 * and filterable, kept separate per Twitch account.
 */

import {useEffect, useState} from "react";
import {TextInput} from "@astryxdesign/core/TextInput";
import {Button} from "@astryxdesign/core/Button";
import {Card} from "@astryxdesign/core/Card";
import {EmptyState} from "@astryxdesign/core/EmptyState";
import {Spinner} from "@astryxdesign/core/Spinner";
import {Text} from "@astryxdesign/core/Text";
import {Stack} from "@astryxdesign/core/Stack";
import {List, ListItem} from "@astryxdesign/core/List";
import type {HistoryItem, HistoryResponse, HistorySummary} from "../../web/api-types";
import {Page, PageHeader, Artwork} from "../shell/parts";
import {request} from "../core/api";
import {formatDate} from "../core/format";
import {useStore} from "../core/store";

type Status = "loading" | "ready" | "error";

function sourceNote(item: HistoryItem): string {
  if (item.awardCount && item.awardCount > 1) return `${item.awardCount} awards recorded`;
  if (item.source === "local") return "Recorded by this miner";
  if (item.source === "both") return "Recorded locally and in Twitch inventory";
  return "Observed in Twitch inventory";
}

export function History() {
  const {accountKey} = useStore();
  const [query, setQuery] = useState("");
  const [game, setGame] = useState("");
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [games, setGames] = useState<Array<{id: string; name: string; rewardCount: number}>>([]);
  const [attempt, setAttempt] = useState(0);
  const [lastError, setLastError] = useState("");
  useEffect(() => {
    // A new account must not show the previous account's filters or rows.
    setQuery("");
    setGame("");
    setOffset(0);
    setAttempt((value) => value + 1);
  }, [accountKey]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    const params = new URLSearchParams({game, q: query, offset: String(offset)});
    request<HistoryResponse>(`/api/history?${params}`)
      .then((data) => {
        if (cancelled) return;
        setItems(data.items ?? []);
        setTotal(data.total ?? 0);
        const nextSummary = data.summary ?? null;
        setSummary(nextSummary);
        setGames(
          (nextSummary?.games ?? [])
            .filter((entry) => entry.id && entry.id !== "unknown")
            .map((entry) => ({
              id: entry.id as string,
              name: entry.name,
              rewardCount: entry.rewardCount,
            })),
        );
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setItems([]);
        setTotal(0);
        setSummary(null);
        setStatus("error");
        setLastError(error instanceof Error ? error.message : "History temporarily unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, game, query, offset]);

  const search = (nextQuery: string, nextGame: string) => {
    setQuery(nextQuery);
    setGame(nextGame);
    setOffset(0);
    setAttempt((value) => value + 1);
  };

  return (
    <Page>
      <Stack gap={5}>
        <PageHeader
          title="Reward history"
          description="Saved rewards across your Twitch campaigns"
        />

        <form
          id="history-filters"
          className="history-filters"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            search(String(form.get("q") ?? ""), String(form.get("game") ?? ""));
          }}
        >
          <TextInput
            type="text"
            label="Search rewards"
            htmlName="q"
            placeholder="Reward or campaign name"
            value={query}
            onChange={setQuery}
            data-testid="history-query"
          />
          <Stack gap={1.5} className="field">
            <label className="field-label" htmlFor="history-game">
              Game
            </label>
            <select
              id="history-game"
              className="select"
              name="game"
              value={game}
              onChange={(event) => setGame(event.target.value)}
            >
              <option value="">All games</option>
              <option value="unknown">Unknown game</option>
              {games.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} ({entry.rewardCount})
                </option>
              ))}
            </select>
          </Stack>
          <Button variant="secondary" type="submit" label="Search" />
        </form>

        <Stack gap={2} id="history-summary">
          <Text type="supporting" color="secondary">
            {summary?.rewardCount ?? 0} saved reward{(summary?.rewardCount ?? 0) === 1 ? "" : "s"} ·{" "}
            {summary?.gameCount ?? 0} game{(summary?.gameCount ?? 0) === 1 ? "" : "s"} ·{" "}
            {summary?.localClaimCount ?? 0} claims recorded by this miner
            {summary?.dailyClaims
              ? ` · ${summary.dailyClaims.reduce(
                  (sum, day) => sum + (Number(day.count) || 0),
                  0,
                )} in the last 30 days (UTC)`
              : ""}
          </Text>
          <Text type="supporting" color="secondary">
            {summary?.coverage ??
              "Includes rewards observed by this miner and returned by Twitch. Twitch may not provide every historical reward or its claim date."}
            {summary?.lastSyncedAt
              ? ` Last synced ${formatDate(summary.lastSyncedAt)}.`
              : " No history sync yet."}
          </Text>
        </Stack>

        <div id="history-results" aria-live="polite">
          {status === "loading" ? (
            <Stack direction="horizontal" gap={2} align="center" role="status">
              <Spinner size="sm" />
              <Text type="supporting" color="secondary">
                Loading saved rewards…
              </Text>
            </Stack>
          ) : status === "error" ? (
            <EmptyState
              title="Could not load reward history"
              description={lastError}
              headingLevel={3}
              actions={
                <Button
                  variant="secondary"
                  data-history-retry
                  label="Try again"
                  onClick={() => setAttempt((value) => value + 1)}
                />
              }
            />
          ) : items.length ? (
            <Card padding={0} className="history-list">
              <List hasDividers>
                {items.map((item) => (
                  <ListItem
                    key={`${item.benefitId}-${item.observedAt}`}
                    className="history-row"
                    startContent={<Artwork className="history-art" src={item.imageUrl} alt="" />}
                    label={
                      <Stack gap={0.5}>
                        <Text weight="semibold">{item.name}</Text>
                        <Text type="supporting" color="secondary">
                          <button
                            type="button"
                            className="history-game-link"
                            data-history-game={item.gameId || "unknown"}
                            onClick={() => search("", item.gameId || "unknown")}
                          >
                            {item.gameName || "Unknown game"}
                          </button>
                          {item.campaignName ? ` · ${item.campaignName}` : ""}
                        </Text>
                      </Stack>
                    }
                    endContent={
                      <Stack gap={0.5} align="end" className="history-date">
                        <Text type="supporting">
                          {item.lastAwardedAt
                            ? formatDate(item.lastAwardedAt)
                            : ["local", "both"].includes(item.source) && item.observedAt
                              ? `Recorded ${formatDate(item.observedAt)}`
                              : "Claim date unavailable"}
                        </Text>
                        <Text type="supporting" color="secondary">
                          {sourceNote(item)}
                        </Text>
                      </Stack>
                    }
                  />
                ))}
              </List>
            </Card>
          ) : (
            <EmptyState
              title="No saved rewards found"
              description="Try a different search or game. Rewards are saved when Twitch inventory is refreshed and when the miner claims them."
              headingLevel={3}
            />
          )}
        </div>

        {status === "ready" && items.length ? (
          <Stack direction="horizontal" justify="between" align="center" className="history-pagination">
            <Button
              variant="secondary"
              size="sm"
              data-history-page="previous"
              isDisabled={offset === 0}
              label="Previous"
              onClick={() => setOffset((value) => Math.max(0, value - 50))}
            />
            <Text type="supporting" color="secondary">
              {offset + 1}–{offset + items.length} of {total}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              data-history-page="next"
              isDisabled={offset + items.length >= total}
              label="Next"
              onClick={() => setOffset((value) => value + 50)}
            />
          </Stack>
        ) : null}
      </Stack>
    </Page>
  );
}
