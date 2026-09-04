from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from aiohttp.test_utils import TestClient, TestServer
from yarl import URL

from history import History
from webui import WebUI


def miner_settings():
    return SimpleNamespace(priority=['Original'], exclude=set(),
        priority_mode=None, connection_quality=1, tray_notifications=True,
        enable_badges_emotes=False, available_drops_check=False, keep_awake=False,
        autostart_tray=False, proxy=URL(), webhook_url='', save=Mock())


class WebControlTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.miner = SimpleNamespace(settings=miner_settings(), change_state=Mock(),
            pause=Mock(), resume=Mock(), close=Mock())
        self.ui = WebUI(self.miner)
        self.client = TestClient(TestServer(self.ui._build_app()))
        await self.client.start_server()
        self.token = (await (await self.client.get('/api/csrf')).json())['token']
        self.headers = {'X-CSRF-Token': self.token}

    async def asyncTearDown(self):
        await self.client.close()

    async def test_actions_require_token_and_reject_foreign_origin(self):
        for headers in ({}, {'Origin': 'https://other.example'},
                        {**self.headers, 'Origin': 'https://other.example'}):
            response = await self.client.post('/api/actions/pause', headers=headers)
            self.assertEqual(response.status, 403)
        self.miner.pause.assert_not_called()
        response = await self.client.post('/api/actions/pause', headers=self.headers)
        self.assertEqual(response.status, 200)
        self.miner.pause.assert_called_once()
        response = await self.client.post('/api/actions/resume', headers=self.headers)
        self.assertEqual(response.status, 200)
        self.miner.resume.assert_called_once()

    async def test_local_host_validation_and_explicit_proxy_origin(self):
        response = await self.client.get('/api/csrf', headers={'Host': 'untrusted.example'})
        self.assertEqual(response.status, 403)
        with patch.dict('os.environ', {'TDM_PUBLIC_URL': 'https://miner.example'}):
            response = await self.client.post('/api/actions/pause',
                headers={**self.headers, 'Origin': 'https://miner.example'})
        self.assertEqual(response.status, 200)

    async def test_rejected_settings_are_unchanged(self):
        for invalid in ({'priorityMode': 'INVALID'}, {'connectionQuality': '3'},
                        {'trayNotifications': 'false'}, {'proxy': 'http://localhost'},
                        {'webhookUrl': 'file:///tmp/example'}, {'exclude': 'game'}):
            response = await self.client.put('/api/settings',
                json={'priority': ['Changed'], **invalid}, headers=self.headers)
            self.assertEqual(response.status, 400)
            self.assertEqual(self.miner.settings.priority, ['Original'])
        self.miner.settings.save.assert_not_called()
        self.miner.change_state.assert_not_called()

    async def test_storage_failure_rolls_back_memory(self):
        self.miner.settings.save.side_effect = OSError('disk unavailable')
        with self.assertLogs('TwitchDrops', level='ERROR'):
            response = await self.client.put('/api/settings',
                json={'priority': ['Changed']}, headers=self.headers)
        self.assertEqual(response.status, 500)
        self.assertEqual(self.miner.settings.priority, ['Original'])
        self.miner.change_state.assert_not_called()

    async def test_import_uses_same_validation(self):
        response = await self.client.post('/api/import',
            json={'settings': {'priority': ['Changed'], 'keepAwake': 'false'}}, headers=self.headers)
        self.assertEqual(response.status, 400)
        self.assertEqual(self.miner.settings.priority, ['Original'])
        response = await self.client.put('/api/settings',
            json={'priority': ['Changed'], 'keepAwake': True}, headers=self.headers)
        self.assertEqual(response.status, 200)
        self.assertTrue(self.miner.settings.keep_awake)
        self.miner.settings.save.assert_called_once()

    async def test_history_is_scoped_to_current_account(self):
        with tempfile.TemporaryDirectory() as directory:
            history = History(Path(directory) / 'history.sqlite3')
            self.miner.history = history
            try:
                history.ingest_inventory('1', [{'id': 'reward-1', 'name': 'First'}])
                history.ingest_inventory('2', [{'id': 'reward-2', 'name': 'Second'}])
                self.assertEqual((await self.client.get('/api/history')).status, 409)
                self.ui.login_state['userId'] = '1'
                self.miner._auth_state = SimpleNamespace(user_id='1')
                response = await self.client.get('/api/history?account=2')
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
                data = await response.json()
                self.assertEqual([row['benefitId'] for row in data['items']], ['reward-1'])
                self.assertEqual(data['summary']['rewardCount'], 1)
            finally:
                history.close()
