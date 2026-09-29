"""Monthly bandwidth quota fields: the limit, the resets used this month and
the monthly reset allowance from GET subscription/status.

lazy_sync is the only writer. The fields are bound to the key they were
confirmed for: they drop on a key change and when the key is declared
unknown, and a confirmed answer that no longer carries a valid value drops
the stored one instead of keeping a stale number. The dashboard shows usage
and resets only for the current key and only from a sync in the current UTC
month (both reset on the 1st). These tests run the real lazy_sync,
get_status and get_dashboard against state files in a temporary directory.
"""
import json
import os
import sys
import unittest
from datetime import timedelta
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import bridge
from test_dashboard import DashboardStateTestBase, new_keypair
from test_expiry_provenance import ProvenanceTestBase, api_response

QUOTA_FIELDS = ("bandwidth_limit_gb", "bandwidth_resets_this_month", "max_resets_per_month")


def status_payload(**overrides):
    payload = {
        "expiry": "2099-12-31T23:59:59Z",
        "server_domain": "de2.tunnelsats.com",
        "bandwidth_used_gb": 71.5,
        "bandwidth_limit_gb": 150,
        "bandwidth_resets_this_month": 1,
        "max_resets_per_month": 3,
    }
    payload.update(overrides)
    return {k: v for k, v in payload.items() if v is not ...}


class TestLazySyncQuotaFields(ProvenanceTestBase):
    @patch('urllib.request.urlopen')
    def test_confirmed_sync_persists_quota_fields(self, mock_urlopen):
        mock_urlopen.return_value = api_response(status_payload())
        self.assertEqual(bridge.lazy_sync("pk_current"), "confirmed")
        meta = self.read_meta()
        self.assertEqual(meta["bandwidth_limit_gb"], 150)
        self.assertEqual(meta["bandwidth_resets_this_month"], 1)
        self.assertEqual(meta["max_resets_per_month"], 3)
        self.assertEqual(meta["bandwidth_used_gb"], 71.5)

    @patch('urllib.request.urlopen')
    def test_invalid_values_are_not_stored(self, mock_urlopen):
        cases = [
            {"bandwidth_limit_gb": 0, "bandwidth_resets_this_month": -1, "max_resets_per_month": True},
            {"bandwidth_limit_gb": "150", "bandwidth_resets_this_month": 1.5, "max_resets_per_month": "3"},
            {"bandwidth_limit_gb": float("inf"), "bandwidth_resets_this_month": None,
             "max_resets_per_month": -2},
            {"bandwidth_limit_gb": True, "bandwidth_resets_this_month": False, "max_resets_per_month": 10**9},
        ]
        for case in cases:
            with self.subTest(case=case):
                self.write_meta({})
                mock_urlopen.return_value = api_response(status_payload(**case))
                self.assertEqual(bridge.lazy_sync("pk_current"), "confirmed")
                meta = self.read_meta()
                for field in QUOTA_FIELDS:
                    self.assertNotIn(field, meta)

    @patch('urllib.request.urlopen')
    def test_zero_resets_and_zero_allowance_are_valid(self, mock_urlopen):
        mock_urlopen.return_value = api_response(
            status_payload(bandwidth_resets_this_month=0, max_resets_per_month=0, bandwidth_limit_gb=99.5))
        bridge.lazy_sync("pk_current")
        meta = self.read_meta()
        self.assertEqual(meta["bandwidth_resets_this_month"], 0)
        self.assertEqual(meta["max_resets_per_month"], 0)
        self.assertEqual(meta["bandwidth_limit_gb"], 99.5)

    @patch('urllib.request.urlopen')
    def test_confirmed_answer_without_a_field_drops_the_stored_value(self, mock_urlopen):
        self.write_meta({"publicKey": "pk_current", "bandwidth_limit_gb": 150,
                         "bandwidth_resets_this_month": 2, "max_resets_per_month": 2})
        mock_urlopen.return_value = api_response(status_payload(
            bandwidth_limit_gb=..., bandwidth_resets_this_month=..., max_resets_per_month="x"))
        self.assertEqual(bridge.lazy_sync("pk_current"), "confirmed")
        meta = self.read_meta()
        for field in QUOTA_FIELDS:
            self.assertNotIn(field, meta)

    @patch('urllib.request.urlopen')
    def test_confirmed_answer_without_usage_drops_the_stored_usage(self, mock_urlopen):
        # Last month's figure must not survive a sync that refreshes lastSync
        # without confirming usage; it would read as this month's.
        for bad in (..., None, "71.5x", -1, float("nan"), True):
            with self.subTest(usage=bad):
                self.write_meta({"publicKey": "pk_current", "bandwidth_used_gb": 140.0,
                                 "lastSync": "2026-08-31T23:00:00+00:00"})
                mock_urlopen.return_value = api_response(status_payload(bandwidth_used_gb=bad))
                self.assertEqual(bridge.lazy_sync("pk_current"), "confirmed")
                meta = self.read_meta()
                self.assertNotIn("bandwidth_used_gb", meta)
                self.assertEqual(meta["bandwidth_limit_gb"], 150)

    @patch('bridge.time.sleep')
    @patch('urllib.request.urlopen', side_effect=OSError("unreachable"))
    def test_failed_sync_keeps_the_values_for_the_same_key(self, _urlopen, _sleep):
        self.write_meta({"publicKey": "pk_current", "bandwidth_limit_gb": 150,
                         "bandwidth_resets_this_month": 2, "max_resets_per_month": 2})
        self.assertEqual(bridge.lazy_sync("pk_current"), "failed")
        meta = self.read_meta()
        self.assertEqual(meta["bandwidth_limit_gb"], 150)
        self.assertEqual(meta["bandwidth_resets_this_month"], 2)
        self.assertEqual(meta["max_resets_per_month"], 2)

    @patch('bridge.time.sleep')
    @patch('urllib.request.urlopen', side_effect=OSError("unreachable"))
    def test_key_change_drops_quota_fields(self, _urlopen, _sleep):
        self.configured_key = "pk_new"
        self.write_meta({"publicKey": "pk_old", "bandwidth_limit_gb": 150,
                         "bandwidth_resets_this_month": 2, "max_resets_per_month": 2})
        bridge.lazy_sync("pk_new")
        meta = self.read_meta()
        self.assertEqual(meta["publicKey"], "pk_new")
        for field in QUOTA_FIELDS:
            self.assertNotIn(field, meta)

    def test_quota_fields_are_confirmed_fields(self):
        # Declaring a key unknown and saving a new configuration drop every
        # confirmed field; the quota fields must be among them.
        for field in QUOTA_FIELDS:
            self.assertIn(field, bridge.CONFIRMED_META_FIELDS)
            self.assertIn(field, bridge.KEY_BOUND_META_FIELDS)


class TestDashboardQuota(DashboardStateTestBase):
    def state(self, last_sync=None, **meta_overrides):
        _, pub, _ = self.configure("lnd")
        meta = {
            "publicKey": pub,
            "expiresAt": self.iso(self.now + timedelta(days=20)),
            "expirySource": "api",
            "lastSync": self.iso(last_sync or self.now),
            "syncSuccess": True,
            "bandwidth_used_gb": 71.5,
            "bandwidth_limit_gb": 150,
            "bandwidth_resets_this_month": 1,
            "max_resets_per_month": 3,
        }
        meta.update(meta_overrides)
        self.write_json(bridge.META_FILE_PATH, meta)
        return pub

    def read_json(self, path):
        with open(path) as f:
            return json.load(f)

    def test_same_key_shows_the_quota(self):
        self.state()
        self.assertEqual(bridge.get_dashboard()["bandwidth"], {
            "usedGb": 71.5, "limitGb": 150, "resetsThisMonth": 1, "maxResetsPerMonth": 3,
            "resetThresholdPct": bridge.RESET_THRESHOLD_DEFAULT_PCT,
        })
        self.assertEqual(bridge.RESET_THRESHOLD_DEFAULT_PCT, 70)

    def test_previous_key_quota_is_not_shown(self):
        self.state()
        _, other_pub = new_keypair()
        meta = self.read_json(bridge.META_FILE_PATH)
        meta["publicKey"] = other_pub
        self.write_json(bridge.META_FILE_PATH, meta)
        self.assertEqual(bridge.get_dashboard()["bandwidth"], {
            "usedGb": None, "limitGb": bridge.BANDWIDTH_LIMIT_GB, "resetsThisMonth": None,
            "maxResetsPerMonth": None, "resetThresholdPct": 70,
        })

    def test_usage_and_resets_from_a_previous_month_are_not_shown(self):
        first_of_month = self.now.replace(day=1, hour=0, minute=0, second=0)
        self.state(last_sync=first_of_month - timedelta(minutes=1))
        bandwidth = bridge.get_dashboard()["bandwidth"]
        self.assertIsNone(bandwidth["usedGb"])
        self.assertIsNone(bandwidth["resetsThisMonth"])
        # Neither the limit nor the monthly allowance depend on the month.
        self.assertEqual(bandwidth["limitGb"], 150)
        self.assertEqual(bandwidth["maxResetsPerMonth"], 3)

    def test_usage_without_a_sync_time_is_not_shown(self):
        self.state()
        meta = self.read_json(bridge.META_FILE_PATH)
        meta["lastSync"] = "garbage"
        self.write_json(bridge.META_FILE_PATH, meta)
        bandwidth = bridge.get_dashboard()["bandwidth"]
        self.assertIsNone(bandwidth["usedGb"])
        self.assertIsNone(bandwidth["resetsThisMonth"])

    def test_tampered_values_are_sanitized(self):
        self.state(bandwidth_limit_gb="150", bandwidth_resets_this_month=True,
                   max_resets_per_month=-1)
        bandwidth = bridge.get_dashboard()["bandwidth"]
        self.assertEqual(bandwidth["limitGb"], bridge.BANDWIDTH_LIMIT_GB)
        self.assertIsNone(bandwidth["resetsThisMonth"])
        self.assertIsNone(bandwidth["maxResetsPerMonth"])

    def test_status_endpoint_reports_the_confirmed_limit(self):
        self.state()
        self.assertEqual(bridge.get_status()["bandwidth_limit_gb"], 150)
        meta = self.read_json(bridge.META_FILE_PATH)
        del meta["bandwidth_limit_gb"]
        self.write_json(bridge.META_FILE_PATH, meta)
        self.assertEqual(bridge.get_status()["bandwidth_limit_gb"], bridge.BANDWIDTH_LIMIT_GB)


if __name__ == "__main__":
    unittest.main()
