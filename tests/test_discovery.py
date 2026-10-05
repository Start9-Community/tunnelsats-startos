"""Server discovery (GET /api/servers) and the inbound reachability check
(POST /api/reachability).

Both make outbound calls to the TunnelSats API on the operator's behalf, so
they are bounded: the server list is cached for SERVERS_CACHE_TTL and served
stale while the API fails; the reachability check is limited process-wide,
takes only the operator's node public key, and builds the probed host and
port on this server from the stored configuration (a TunnelSats hostname and
the explicit forwarded-port marker). These tests run the real functions and
the real HTTP handler; only the network (urllib.request.urlopen) and the
clock are replaced.
"""
import io
import json
import os
import sys
import threading
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import bridge
from test_dashboard import DashboardStateTestBase, LoopbackServerTestBase

NODE_PUBKEY = "02" + "ab" * 32

LIVE_SERVERS = {
    "servers": [
        {"id": "eu-de", "country": "Germany", "city": "Nuremberg", "flag": "🇩🇪", "status": "online",
         "domain": "de2.tunnelsats.com", "authToken": "AUTH_DE2", "managerUrl": "https://x/manager/"},
        {"id": "us-east", "country": "USA", "city": "Ashburn", "flag": "🇺🇸", "status": "online"},
        {"id": "../etc", "country": "X", "city": "Y", "flag": "", "status": "online"},
        {"id": "oc-au", "country": "Australia" * 20, "city": 7, "flag": "🇦🇺", "status": "<b>up</b>"},
        "not-an-object",
    ]
}


def response(payload, status=200):
    resp = MagicMock()
    resp.status = status
    resp.read.return_value = json.dumps(payload).encode()
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def http_error(code, payload=None):
    body = io.BytesIO(json.dumps(payload or {}).encode())
    return urllib.error.HTTPError("https://tunnelsats.com", code, "error", {}, body)


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class DiscoveryTestBase(DashboardStateTestBase):
    def setUp(self):
        super().setUp()
        bridge._reset_discovery_state()
        self.clock = Clock()
        self._clock = patch("bridge.time.monotonic", side_effect=self.clock)
        self._clock.start()

    def tearDown(self):
        self._clock.stop()
        bridge._reset_discovery_state()
        super().tearDown()


class TestServerDiscovery(DiscoveryTestBase):
    @patch("urllib.request.urlopen")
    def test_list_is_allow_listed_and_sanitized(self, urlopen):
        urlopen.return_value = response(LIVE_SERVERS)
        result = bridge.get_servers()
        self.assertFalse(result["stale"])
        self.assertEqual(result["servers"][0], {
            "id": "eu-de", "country": "Germany", "city": "Nuremberg", "flag": "🇩🇪", "status": "online",
        })
        self.assertEqual([s["id"] for s in result["servers"]], ["eu-de", "us-east", "oc-au"])
        au = result["servers"][2]
        self.assertLessEqual(len(au["country"]), 64)
        self.assertIsNone(au["city"])
        self.assertIsNone(au["status"])
        body = json.dumps(result)
        for leaked in ("de2.tunnelsats.com", "AUTH_DE2", "manager", "../etc"):
            self.assertNotIn(leaked, body)
        request = urlopen.call_args[0][0]
        self.assertEqual(request.full_url, f"{bridge.TUNNELSATS_API_URL}/servers")
        self.assertEqual(request.get_method(), "GET")

    @patch("urllib.request.urlopen")
    def test_list_is_cached_for_the_ttl(self, urlopen):
        urlopen.return_value = response(LIVE_SERVERS)
        bridge.get_servers()
        self.clock.t += bridge.SERVERS_CACHE_TTL - 1
        bridge.get_servers()
        self.assertEqual(urlopen.call_count, 1)
        self.clock.t += 2
        urlopen.return_value = response({"servers": [{"id": "eu-ch", "country": "Switzerland",
                                                       "city": "Zurich", "flag": "🇨🇭", "status": "online"}]})
        self.assertEqual([s["id"] for s in bridge.get_servers()["servers"]], ["eu-ch"])
        self.assertEqual(urlopen.call_count, 2)

    @patch("urllib.request.urlopen")
    def test_failure_serves_the_last_list_as_stale_and_backs_off(self, urlopen):
        urlopen.return_value = response(LIVE_SERVERS)
        fresh = bridge.get_servers()
        self.clock.t += bridge.SERVERS_CACHE_TTL + 1
        urlopen.side_effect = OSError("unreachable")
        stale = bridge.get_servers()
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["servers"], fresh["servers"])
        self.assertEqual(stale["fetchedAt"], fresh["fetchedAt"])
        # No new upstream call until the retry delay passed.
        calls = urlopen.call_count
        self.clock.t += bridge.SERVERS_RETRY_AFTER - 1
        self.assertTrue(bridge.get_servers()["stale"])
        self.assertEqual(urlopen.call_count, calls)
        self.clock.t += 2
        bridge.get_servers()
        self.assertEqual(urlopen.call_count, calls + 1)

    @patch("urllib.request.urlopen")
    def test_malformed_or_empty_answers_count_as_failures(self, urlopen):
        for payload in ({"servers": "x"}, {"nope": []}, ["eu-de"], {"servers": [{"id": "!!"}]}):
            with self.subTest(payload=payload):
                bridge._reset_discovery_state()
                urlopen.return_value = response(payload)
                with self.assertRaises(bridge.DiscoveryUnavailable):
                    bridge.get_servers()

    @patch("urllib.request.urlopen", side_effect=OSError("unreachable"))
    def test_no_list_at_all_is_unavailable(self, _urlopen):
        with self.assertRaises(bridge.DiscoveryUnavailable):
            bridge.get_servers()

    @patch("urllib.request.urlopen")
    def test_a_slow_refresh_never_delays_the_stale_list(self, urlopen):
        urlopen.return_value = response(LIVE_SERVERS)
        fresh = bridge.get_servers()
        self.clock.t += bridge.SERVERS_CACHE_TTL + 1
        entered, release = threading.Event(), threading.Event()
        updated = {"servers": [{"id": "eu-ch", "country": "Switzerland", "city": "Zurich",
                                "flag": "🇨🇭", "status": "online"}]}

        def slow_api(*_args, **_kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return response(updated)

        urlopen.side_effect = slow_api
        results = {}
        refresher = threading.Thread(target=lambda: results.update(refresher=bridge.get_servers()))
        refresher.start()
        try:
            self.assertTrue(entered.wait(5))
            # The refresh is still waiting on the API; another request gets
            # the cached list at once instead of queueing behind it.
            reader = threading.Thread(target=lambda: results.update(reader=bridge.get_servers()))
            reader.start()
            reader.join(2)
            self.assertFalse(reader.is_alive(), "a stale read waited for the API")
            self.assertTrue(results["reader"]["stale"])
            self.assertEqual(results["reader"]["servers"], fresh["servers"])
        finally:
            release.set()
            refresher.join(5)
        self.assertEqual([s["id"] for s in results["refresher"]["servers"]], ["eu-ch"])
        self.assertEqual(urlopen.call_count, 2)
        self.assertFalse(bridge.get_servers()["stale"])
        self.assertEqual(urlopen.call_count, 2)

    @patch("urllib.request.urlopen")
    def test_first_load_requests_share_one_fetch(self, urlopen):
        entered, release = threading.Event(), threading.Event()

        def slow_api(*_args, **_kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return response(LIVE_SERVERS)

        urlopen.side_effect = slow_api
        results = []
        threads = [threading.Thread(target=lambda: results.append(bridge.get_servers())) for _ in range(3)]
        threads[0].start()
        self.assertTrue(entered.wait(5))
        for t in threads[1:]:
            t.start()
        release.set()
        for t in threads:
            t.join(5)
        self.assertEqual(len(results), 3)
        self.assertTrue(all(not r["stale"] and len(r["servers"]) == 3 for r in results))
        self.assertEqual(urlopen.call_count, 1)


class TestReachability(DiscoveryTestBase):
    def configure_tunnel(self, server_line="# Server: de2.tunnelsats.com\n", port_line="# Port Forwarding: 24556\n"):
        priv, pub, conf = self.configure("lnd")
        conf = conf.replace("# Server: de2.tunnelsats.com\n", server_line)
        conf = conf.replace("# Port Forwarding: 24556\n", port_line)
        with open(bridge.CONFIG_PATH, "w") as f:
            f.write(conf)
        return pub

    @patch("urllib.request.urlopen")
    def test_probe_is_built_on_the_server_and_answer_is_allow_listed(self, urlopen):
        self.configure_tunnel()
        urlopen.return_value = response({"success": True, "latencyMs": 412, "nodeAlias": "alias",
                                         "channelCount": 12, "extra": "x"})
        status, body = bridge.check_reachability({"nodePubkey": NODE_PUBKEY.upper()})
        self.assertEqual(status, 200)
        self.assertEqual(body, {"success": True, "latencyMs": 412, "error": None,
                                "host": "de2.tunnelsats.com", "port": 24556})
        request = urlopen.call_args[0][0]
        self.assertEqual(request.full_url, f"{bridge.TUNNELSATS_API_URL}/ping/test")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(json.loads(request.data), {"socket": f"{NODE_PUBKEY}@de2.tunnelsats.com:24556"})

    @patch("urllib.request.urlopen")
    def test_failed_probe_reports_the_sanitized_error(self, urlopen):
        self.configure_tunnel()
        urlopen.return_value = response({"success": False, "error": "Connection refused " + "x" * 500,
                                         "latencyMs": "fast"})
        status, body = bridge.check_reachability({"nodePubkey": NODE_PUBKEY})
        self.assertEqual(status, 200)
        self.assertFalse(body["success"])
        self.assertIsNone(body["latencyMs"])
        self.assertTrue(body["error"].startswith("Connection refused"))
        self.assertLessEqual(len(body["error"]), 200)

    @patch("urllib.request.urlopen")
    def test_invalid_requests_are_refused_without_an_outbound_call(self, urlopen):
        self.configure_tunnel()
        for payload in (None, [], {}, {"nodePubkey": "04" + "ab" * 32}, {"nodePubkey": "02" + "ab" * 31},
                        {"nodePubkey": NODE_PUBKEY, "host": "evil.example"},
                        {"nodePubkey": NODE_PUBKEY, "port": 22}, {"nodePubkey": 2},
                        {"socket": f"{NODE_PUBKEY}@10.0.0.1:22"}):
            with self.subTest(payload=payload):
                status, body = bridge.check_reachability(payload)
                self.assertEqual(status, 400)
                self.assertIn("error", body)
        urlopen.assert_not_called()

    @patch("urllib.request.urlopen")
    def test_only_a_tunnelsats_host_and_an_explicit_port_are_probed(self, urlopen):
        cases = (
            ("# Server: 10.0.0.1\n", "# Port Forwarding: 24556\n"),
            ("# Server: evil.example\n", "# Port Forwarding: 24556\n"),
            ("# Server: tunnelsats.com.evil.example\n", "# Port Forwarding: 24556\n"),
            ("# Server: de2.tunnelsats.com\n", ""),
            ("# Server: de2.tunnelsats.com\n", "# Port Forwarding: 70000\n"),
        )
        for server_line, port_line in cases:
            with self.subTest(server=server_line, port=port_line):
                self.configure_tunnel(server_line, port_line)
                status, body = bridge.check_reachability({"nodePubkey": NODE_PUBKEY})
                self.assertEqual(status, 409)
                self.assertIn("error", body)
        os.remove(bridge.CONFIG_PATH)
        status, _ = bridge.check_reachability({"nodePubkey": NODE_PUBKEY})
        self.assertEqual(status, 409)
        urlopen.assert_not_called()

    @patch("urllib.request.urlopen")
    def test_process_wide_rate_limit(self, urlopen):
        self.configure_tunnel()
        urlopen.return_value = response({"success": True, "latencyMs": 100})
        for _ in range(bridge.REACHABILITY_LIMIT):
            self.assertEqual(bridge.check_reachability({"nodePubkey": NODE_PUBKEY})[0], 200)
        status, body = bridge.check_reachability({"nodePubkey": NODE_PUBKEY})
        self.assertEqual(status, 429)
        self.assertEqual(body["retryAfterSeconds"], bridge.REACHABILITY_WINDOW)
        self.assertEqual(urlopen.call_count, bridge.REACHABILITY_LIMIT)
        self.clock.t += 30
        self.assertEqual(bridge.check_reachability({"nodePubkey": NODE_PUBKEY})[1]["retryAfterSeconds"], 30)
        self.clock.t += 31
        self.assertEqual(bridge.check_reachability({"nodePubkey": NODE_PUBKEY})[0], 200)

    @patch("urllib.request.urlopen")
    def test_upstream_errors(self, urlopen):
        self.configure_tunnel()
        urlopen.side_effect = http_error(429, {"error": "Rate limited. Please wait a minute."})
        status, body = bridge.check_reachability({"nodePubkey": NODE_PUBKEY})
        self.assertEqual(status, 429)
        self.assertEqual(body["retryAfterSeconds"], 60)
        for failure in (http_error(503, {"error": "down"}), OSError("unreachable"), ValueError("bad json")):
            with self.subTest(failure=failure):
                bridge._reset_discovery_state()
                urlopen.side_effect = failure
                status, body = bridge.check_reachability({"nodePubkey": NODE_PUBKEY})
                self.assertEqual(status, 502)
                self.assertNotIn("success", body)
        urlopen.side_effect = None
        urlopen.return_value = response(["not", "an", "object"])
        bridge._reset_discovery_state()
        self.assertEqual(bridge.check_reachability({"nodePubkey": NODE_PUBKEY})[0], 502)


class TestDiscoveryEndpoints(LoopbackServerTestBase):
    """GET /api/servers and POST /api/reachability through the real handler."""

    def setUp(self):
        super().setUp()
        bridge._reset_discovery_state()

    def tearDown(self):
        bridge._reset_discovery_state()
        super().tearDown()

    def csrf_headers(self):
        return {"Content-Type": "application/json", "X-CSRF-Token": bridge.get_csrf_token()}

    @patch("urllib.request.urlopen")
    def test_get_servers(self, urlopen):
        urlopen.return_value = response(LIVE_SERVERS)
        status, headers, body = self.get("/api/servers")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assert_security_headers(headers)
        self.assertEqual([s["id"] for s in json.loads(body)["servers"]], ["eu-de", "us-east", "oc-au"])
        status, _, _ = self.get("/api/servers", {"Host": "attacker.example"})
        self.assertEqual(status, 403)

    @patch("urllib.request.urlopen", side_effect=OSError("unreachable"))
    def test_get_servers_unavailable(self, _urlopen):
        status, _, body = self.get("/api/servers")
        self.assertEqual(status, 503)
        self.assertIn("error", json.loads(body))

    @patch("urllib.request.urlopen")
    def test_reachability_requires_csrf_and_trusted_origin(self, urlopen):
        self.configure("lnd")
        payload = json.dumps({"nodePubkey": NODE_PUBKEY}).encode()
        status, _, _ = self.post("/api/reachability", payload, {"Content-Type": "application/json"})
        self.assertEqual(status, 403)
        status, _, _ = self.post("/api/reachability", payload,
                                 {**self.csrf_headers(), "Origin": "https://attacker.example"})
        self.assertEqual(status, 403)
        status, _, _ = self.post("/api/reachability", payload,
                                 {**self.csrf_headers(), "Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)
        status, _, _ = self.post("/api/reachability", b"x" * (bridge.REACHABILITY_MAX_BODY_BYTES + 1),
                                 self.csrf_headers())
        self.assertEqual(status, 400)
        urlopen.assert_not_called()

        urlopen.return_value = response({"success": True, "latencyMs": 250})
        status, headers, body = self.post("/api/reachability", payload, self.csrf_headers())
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(json.loads(body), {"success": True, "latencyMs": 250, "error": None,
                                            "host": "de2.tunnelsats.com", "port": 24556})


if __name__ == "__main__":
    unittest.main()
