import unittest
import os
import sys
import json
import io
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import bridge

class TestBridgeHealth(unittest.TestCase):
    @patch('bridge.is_enabled', return_value=False)
    @patch('sys.stdout', new_callable=io.StringIO)
    def test_health_disabled(self, mock_stdout, mock_enabled):
        with patch('sys.argv', ['bridge.py', 'health', 'subscription']):
            with self.assertRaises(SystemExit) as cm:
                bridge.main()
            self.assertEqual(cm.exception.code, 0)
            output = json.loads(mock_stdout.getvalue())
            self.assertEqual(output["result"], "disabled")
            self.assertIn("disabled", output["message"].lower())

    @patch('bridge.is_enabled', return_value=True)
    @patch('os.path.exists', return_value=False)
    @patch('sys.stdout', new_callable=io.StringIO)
    def test_health_unconfigured(self, mock_stdout, mock_exists, mock_enabled):
        with patch('sys.argv', ['bridge.py', 'health', 'subscription']):
            with self.assertRaises(SystemExit) as cm:
                bridge.main()
            self.assertEqual(cm.exception.code, 0)
            output = json.loads(mock_stdout.getvalue())
            self.assertEqual(output["result"], "ok")
            self.assertIn("Unconfigured", output["message"])

    @patch('bridge.is_enabled', return_value=True)
    @patch('os.path.exists', return_value=True)
    @patch('bridge.get_subscription_info')
    @patch('sys.stdout', new_callable=io.StringIO)
    def test_health_active_subscription(self, mock_stdout, mock_sub_info, mock_exists, mock_enabled):
        mock_sub_info.return_value = {
            "linked": True,
            "expiresAt": "2026-12-31T23:59:59Z",
            "daysRemaining": 130,
            "formatted": "Active (Expires in 130d 5h)",
            "isExpired": False,
            "lastSync": "2026-08-20T18:00:00Z",
            "syncError": None,
            "syncSuccess": True
        }
        with patch('sys.argv', ['bridge.py', 'health', 'subscription']):
            with self.assertRaises(SystemExit) as cm:
                bridge.main()
            self.assertEqual(cm.exception.code, 0)
            output = json.loads(mock_stdout.getvalue())
            self.assertEqual(output["result"], "ok")
            self.assertEqual(output["message"], "Active (Expires in 130d 5h)")

    @patch('bridge.is_enabled', return_value=True)
    @patch('os.path.exists', return_value=True)
    @patch('bridge.get_subscription_info')
    @patch('sys.stdout', new_callable=io.StringIO)
    def test_health_expired_subscription(self, mock_stdout, mock_sub_info, mock_exists, mock_enabled):
        mock_sub_info.return_value = {
            "linked": True,
            "expiresAt": "2026-01-01T00:00:00Z",
            "daysRemaining": 0,
            "formatted": "Expired on 2026-01-01",
            "isExpired": True,
            "lastSync": "2026-08-20T18:00:00Z",
            "syncError": None,
            "syncSuccess": True
        }
        with patch('sys.argv', ['bridge.py', 'health', 'subscription']):
            with self.assertRaises(SystemExit) as cm:
                bridge.main()
            self.assertEqual(cm.exception.code, 1)
            output = json.loads(mock_stdout.getvalue())
            self.assertEqual(output["result"], "failure")
            self.assertIn("expired", output["message"].lower())

    @patch('bridge.is_enabled', return_value=True)
    @patch('os.path.exists', return_value=True)
    @patch('bridge.get_subscription_info')
    @patch('sys.stdout', new_callable=io.StringIO)
    def test_health_sync_error_fails_closed(self, mock_stdout, mock_sub_info, mock_exists, mock_enabled):
        mock_sub_info.return_value = {
            "linked": False,
            "expiresAt": None,
            "daysRemaining": None,
            "formatted": "Sync failed: Connection refused",
            "isExpired": False,
            "lastSync": None,
            "syncError": "Connection refused",
            "syncSuccess": False
        }
        with patch('sys.argv', ['bridge.py', 'health', 'subscription']):
            with self.assertRaises(SystemExit) as cm:
                bridge.main()
            self.assertEqual(cm.exception.code, 1)
            output = json.loads(mock_stdout.getvalue())
            self.assertEqual(output["result"], "failure")
            self.assertIn("Connection refused", output["message"])

    @patch('bridge.is_enabled', return_value=True)
    @patch('os.path.exists', return_value=True)
    @patch('bridge.get_subscription_info')
    @patch('sys.stdout', new_callable=io.StringIO)
    def test_health_cached_expiry_with_sync_error_fails_closed(self, mock_stdout, mock_sub_info, mock_exists, mock_enabled):
        # Even if expiresAt is in the future, if the latest sync failed with syncError,
        # health check must report failure instead of masking with cached expiry.
        mock_sub_info.return_value = {
            "linked": True,
            "expiresAt": "2026-12-31T23:59:59Z",
            "daysRemaining": 130,
            "formatted": "Active (Expires in 130d)",
            "isExpired": False,
            "lastSync": "2026-08-19T18:00:00Z",
            "syncError": "503 Service Unavailable",
            "syncSuccess": False
        }
        with patch('sys.argv', ['bridge.py', 'health', 'subscription']):
            with self.assertRaises(SystemExit) as cm:
                bridge.main()
            self.assertEqual(cm.exception.code, 1)
            output = json.loads(mock_stdout.getvalue())
            self.assertEqual(output["result"], "failure")
            self.assertIn("503 Service Unavailable", output["message"])

    @patch('bridge.is_enabled', return_value=True)
    @patch('os.path.exists', return_value=True)
    @patch('bridge.get_subscription_info')
    @patch('bridge.get_wg_pubkey', return_value="Unknown")
    @patch('sys.stdout', new_callable=io.StringIO)
    def test_health_loading_until_live_sync(self, mock_stdout, mock_pubkey, mock_sub_info, mock_exists, mock_enabled):
        # When subscription info has static expiry but live API hasn't synced yet (lastSync is None, syncSuccess is False)
        # and no syncError has occurred, health check must report loading rather than ok prematurely.
        mock_sub_info.return_value = {
            "linked": False,
            "expiresAt": "2026-12-31T23:59:59Z",
            "daysRemaining": 130,
            "formatted": "Pending subscription synchronization (Expires in 130d)",
            "isExpired": False,
            "lastSync": None,
            "syncError": None,
            "syncSuccess": False
        }
        with patch('sys.argv', ['bridge.py', 'health', 'subscription']):
            with self.assertRaises(SystemExit) as cm:
                bridge.main()
            self.assertEqual(cm.exception.code, 0)
            output = json.loads(mock_stdout.getvalue())
            self.assertEqual(output["result"], "loading")
            self.assertIn("Synchronizing subscription status", output["message"])

    @patch('bridge.is_enabled', return_value=True)
    @patch('os.path.exists', return_value=True)
    @patch('bridge.get_subscription_info')
    @patch('bridge.get_wg_pubkey', return_value="Unknown")
    @patch('sys.stdout', new_callable=io.StringIO)
    def test_health_expired_subscription_without_sync_fails_closed(self, mock_stdout, mock_pubkey, mock_sub_info, mock_exists, mock_enabled):
        # Even if live API has never synced, a configuration that is known to be expired
        # must fail closed (result: failure, exit code 1) instead of returning loading.
        mock_sub_info.return_value = {
            "linked": False,
            "expiresAt": "2026-01-01T00:00:00Z",
            "daysRemaining": 0,
            "formatted": "Expired on 2026-01-01",
            "isExpired": True,
            "lastSync": None,
            "syncError": None,
            "syncSuccess": False
        }
        with patch('sys.argv', ['bridge.py', 'health', 'subscription']):
            with self.assertRaises(SystemExit) as cm:
                bridge.main()
            self.assertEqual(cm.exception.code, 1)
            output = json.loads(mock_stdout.getvalue())
            self.assertEqual(output["result"], "failure")
            self.assertIn("expired", output["message"].lower())

if __name__ == '__main__':
    unittest.main()
