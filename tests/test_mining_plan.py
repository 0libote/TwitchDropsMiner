from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from constants import State
from utils import AwaitableValue
from webui import WebUI


class MiningPlanTests(unittest.TestCase):
    def setUp(self) -> None:
        self.game = SimpleNamespace(id='game', name='Game')
        self.channel = SimpleNamespace(id=1, game=self.game)
        self.miner = SimpleNamespace(
            wanted_games=[self.game], inventory=[], channels={1: self.channel},
            watching_channel=AwaitableValue(), paused=False,
            settings=SimpleNamespace(priority=[], exclude=set()),
            can_watch=lambda _: True, get_active_campaign=Mock(return_value=None),
        )
        self.ui = WebUI(self.miner)

    def campaign(self, name: str, minutes: int, *, game=None, live=True):
        campaign = SimpleNamespace(
            id=name, name=name, game=game or self.game, finished=False,
            eligible=True, expired=False, linked=True, image_url='',
            remaining_minutes=minutes, ends_at=datetime.now(timezone.utc) + timedelta(days=1),
            can_earn=lambda channel: live and channel.game == (game or self.game),
        )
        self.miner.inventory.append(campaign)
        return campaign

    def test_current_campaign_comes_from_engine_selection(self) -> None:
        self.campaign('long', 100)
        current = self.campaign('short', 10)
        self.miner.watching_channel.set(self.channel)
        self.miner.get_active_campaign.return_value = current
        plan = self.ui._mining_plan()
        self.assertEqual(plan[0]['campaignId'], 'short')
        self.assertEqual(plan[0]['reasonCode'], 'mining')
        self.assertIsNotNone(plan[0]['estimatedCompletionAt'])
        self.miner.get_active_campaign.assert_called_once_with(self.channel)

    def test_other_campaign_live_channel_does_not_make_blocked_campaign_live(self) -> None:
        self.campaign('blocked', 1, live=False)
        self.campaign('eligible', 20)
        plan = self.ui._mining_plan()
        self.assertEqual(plan[0]['campaignId'], 'eligible')
        self.assertIsNone(plan[0]['estimatedCompletionAt'])

    def test_current_fallback_precedes_unavailable_priority_without_eta_delay(self) -> None:
        blocked_game = SimpleNamespace(id='blocked', name='Blocked')
        self.miner.wanted_games.insert(0, blocked_game)
        self.campaign('blocked', 100, game=blocked_game, live=False)
        current = self.campaign('current', 10)
        self.miner.watching_channel.set(self.channel)
        self.miner.get_active_campaign.return_value = current
        plan = self.ui._mining_plan()
        self.assertEqual([row['campaignId'] for row in plan], ['current', 'blocked'])
        remaining = datetime.fromisoformat(plan[0]['estimatedCompletionAt']) - datetime.now(timezone.utc)
        self.assertAlmostEqual(remaining.total_seconds(), 600, delta=2)
        self.assertIsNone(plan[1]['estimatedCompletionAt'])

    def test_pause_and_expiring_campaign_suppress_estimates(self) -> None:
        campaign = self.campaign('short', 10)
        self.miner.paused = True
        self.assertIsNone(self.ui._mining_plan()[0]['estimatedCompletionAt'])
        self.miner.paused = False
        campaign.ends_at = datetime.now(timezone.utc) + timedelta(minutes=1)
        self.assertIsNone(self.ui._mining_plan()[0]['estimatedCompletionAt'])

    def test_ambiguous_current_game_suppresses_later_game_eta(self) -> None:
        current = self.campaign('current', 10)
        self.campaign('other', 20)
        next_game = SimpleNamespace(id='next', name='Next')
        self.miner.wanted_games.append(next_game)
        self.campaign('next', 5, game=next_game)
        self.miner.channels[2] = SimpleNamespace(id=2, game=next_game)
        self.miner.watching_channel.set(self.channel)
        self.miner.get_active_campaign.return_value = current
        self.assertIsNone(self.ui._mining_plan()[1]['estimatedCompletionAt'])


class WatchdogTests(unittest.IsolatedAsyncioTestCase):
    async def run_ticks(self, elapsed):
        miner = SimpleNamespace(seconds_without_progress=Mock(return_value=elapsed), change_state=Mock())
        ui = SimpleNamespace(_twitch=miner, last_watchdog=0.0, recovery_reason=None,
                             print=Mock(), send_webhook=Mock())
        with patch('webui.monotonic', side_effect=[1000, 1060, 1120]), patch(
            'webui.asyncio.sleep', new=AsyncMock(side_effect=[None, None, asyncio.CancelledError()])
        ), self.assertRaises(asyncio.CancelledError):
            await WebUI._clock_monitor(ui)
        return ui, miner

    async def test_stalled_progress_refreshes_once_during_cooldown(self) -> None:
        ui, miner = await self.run_ticks(1000)
        miner.change_state.assert_called_once_with(State.INVENTORY_FETCH)
        ui.send_webhook.assert_called_once()

    async def test_paused_or_not_watching_does_not_trigger_watchdog(self) -> None:
        ui, miner = await self.run_ticks(None)
        miner.change_state.assert_not_called()
        ui.send_webhook.assert_not_called()
