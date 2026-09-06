from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from constants import State
from twitch import Twitch


class PauseTests(unittest.TestCase):
    def setUp(self) -> None:
        with patch('twitch.Stats'), patch('twitch.History'), patch('twitch.WebsocketPool'):
            self.miner = Twitch(SimpleNamespace(), ui_factory=lambda _: Mock())
        self.channel = Mock(id=1, name='test', online=True)

    def test_pause_stops_immediately_and_blocks_background_transitions(self) -> None:
        self.miner.watch(self.channel, update_status=False)
        self.miner.pause()
        self.assertIsNone(self.miner.watching_channel.get_with_default(None))
        for state in (State.INVENTORY_FETCH, State.GAMES_UPDATE, State.CHANNEL_SWITCH):
            self.miner.change_state(state)
            self.assertEqual(self.miner._state, State.IDLE)
        self.miner.watch(self.channel, update_status=False)
        self.assertIsNone(self.miner.watching_channel.get_with_default(None))

    def test_channel_coming_online_cannot_resume_a_pause(self) -> None:
        self.miner.pause()
        self.miner.can_watch = Mock(return_value=True)
        self.miner.on_channel_update(self.channel, None, Mock())
        self.assertIsNone(self.miner.watching_channel.get_with_default(None))
        self.channel.display.assert_called_once()

    def test_resume_fetches_fresh_inventory_and_allows_watching(self) -> None:
        self.miner.pause()
        self.miner.resume()
        self.assertFalse(self.miner.paused)
        self.assertEqual(self.miner._state, State.INVENTORY_FETCH)
        self.miner.watch(self.channel, update_status=False)
        self.assertIs(self.miner.watching_channel.get_with_default(None), self.channel)

    def test_pause_does_not_prevent_restart_or_exit(self) -> None:
        self.miner.pause()
        self.miner.change_state(State.RESTART)
        self.assertEqual(self.miner._state, State.RESTART)
        self.assertTrue(self.miner.paused)
        self.miner.close()
        self.assertEqual(self.miner._state, State.EXIT)

    def test_only_increasing_confirmed_progress_resets_stall_time(self) -> None:
        drop = SimpleNamespace(real_current_minutes=3)
        drop.update_minutes = lambda minutes: setattr(drop, 'real_current_minutes', minutes)
        with patch('twitch.monotonic', return_value=100):
            self.miner.watch(self.channel, update_status=False)
        with patch('twitch.monotonic', return_value=200):
            self.miner._update_confirmed_minutes(drop, 3)
            self.assertEqual(self.miner.seconds_without_progress(), 100)
            self.miner._update_confirmed_minutes(drop, 4)
            self.assertEqual(self.miner.seconds_without_progress(), 0)
        with patch('twitch.monotonic', return_value=250):
            self.miner._update_confirmed_minutes(drop, 3)
            self.assertEqual(self.miner.seconds_without_progress(), 50)
        self.miner.pause()
        self.assertIsNone(self.miner.seconds_without_progress())


class InFlightPauseTests(unittest.IsolatedAsyncioTestCase):
    async def test_pause_during_watch_request_does_not_restore_progress(self) -> None:
        import asyncio
        from unittest.mock import AsyncMock

        with patch('twitch.Stats'), patch('twitch.History'), patch('twitch.WebsocketPool'):
            miner = Twitch(SimpleNamespace(), ui_factory=lambda _: Mock())
        finished_request = asyncio.Event()

        async def send_watch() -> bool:
            miner.pause()
            finished_request.set()
            return True

        channel = Mock(id=1, online=True)
        channel.send_watch = AsyncMock(side_effect=send_watch)
        miner.watch(channel, update_status=False)
        task = asyncio.create_task(miner._watch_loop())
        try:
            await asyncio.wait_for(finished_request.wait(), timeout=1)
            await asyncio.sleep(0)
            self.assertTrue(miner.paused)
            self.assertIsNone(miner.watching_channel.get_with_default(None))
            miner.gui.progress.minute_almost_done.assert_not_called()
            channel.send_watch.assert_awaited_once()
        finally:
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
