# Saved reward history

The miner saves available Twitch reward inventory and newly observed successful claims in
`history.sqlite3` in its existing data directory. SQLite is included with Python; no server
or additional package is required. Keep this file with your data backups. Account records
are separated by Twitch user ID. Existing `stats.json` counters remain installation-wide:
there is no evidence to assign their old totals to particular accounts or games.

The existing Inventory GraphQL response includes `gameEventDrops`: benefit IDs and their
latest award timestamps. The miner imports those records during its normal inventory
refresh, without another authenticated endpoint. Names, images, games and counts are saved
when supplied; campaign metadata can enrich records when benefit and award period match
unambiguously. Unknown games stay explicit. Only selected reward metadata is persisted,
not authentication tokens or arbitrary response fields.

Repeated inventory refreshes update one summary per account and benefit. Missing records
are retained. `observedAt` means when this installation first saved a reward; it is separate
from Twitch's `lastAwardedAt`. Multiple awards of the same benefit do not provide a complete
timeline: Twitch's optional count and latest date cannot establish each award date.
Successful claims recorded locally have a separate event table, deduplicated by account,
campaign and drop. Reward summaries and local claim counts are different measurements and
must not be added together. Claimed also does not prove delivery inside the game.

## Historical coverage

This archive contains the history Twitch currently returns plus claims saved subsequently.
It cannot promise every drop ever claimed. There is no verified public retention guarantee
or lifetime pagination contract for this internal Inventory response. Older absent rewards
and their original campaigns cannot be reconstructed reliably from current campaigns.
The implementation tolerates missing optional fields rather than requiring an undocumented
schema. No live-account history request was used to establish these limits.

The official [Get Drops Entitlements API](https://dev.twitch.tv/docs/api/reference/#get-drops-entitlements)
is for organizations owning the games: the associated client must belong to the owning
organization even when using a user token. It is therefore not a general all-games viewer
history API. [Twitch's technical guide](https://dev.twitch.tv/docs/drops/technical-guide/)
describes that publisher fulfillment workflow. The current
[upstream miner source](https://raw.githubusercontent.com/DevilXD/TwitchDropsMiner/master/twitch.py)
uses the same Inventory benefit/timestamp lookup as this project. Sources checked September
4, 2026. Any future import from a Twitch data export needs verification of an actual export
format before claiming that it can recover additional history.

Local event timestamps record when a successful claim response was observed. Twitch can return
“already claimed” as success, so these timestamps are not presented as original award dates.
Only Twitch inventory supplies `lastAwardedAt`. The 30-day UTC counts and per-game local counts
measure recorded claim observations. The versioned SQLite schema rejects newer or unfamiliar
databases without overwriting them. Stop the miner before copying the database for a backup.
