import base64
import hashlib
import json
import os
import socket
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import bridge


def _build_test_bolt11(hrp_amount: str, payment_hash_hex: str, include_p_tag: bool = True) -> str:
    """Constructs a syntactically valid Bech32-encoded BOLT11 invoice with
    timestamp, optional 'p' tag (52 5-bit words for 256-bit payment_hash),
    104-word dummy signature, and valid 6-word Bech32 checksum."""
    hrp = f"lnbc{hrp_amount}"
    # 7 words of timestamp (e.g., all zeros)
    words = [0] * 7
    if include_p_tag:
        hash_int = int(payment_hash_hex, 16) << 4
        p_words = [(hash_int >> (5 * (51 - i))) & 31 for i in range(52)]
        # tag 'p' is 1 in bech32 charset; length 52 = (1 << 5) | 20
        words.extend([1, 52 >> 5, 52 & 31])
        words.extend(p_words)
    # 104 words of 65-byte secp256k1 recoverable signature
    words.extend([0] * 104)
    # Compute 6-word Bech32 checksum
    polymod = bridge._bech32_polymod(bridge._bech32_hrp_expand(hrp) + words + [0, 0, 0, 0, 0, 0]) ^ 1
    checksum = [(polymod >> (5 * (5 - i))) & 31 for i in range(6)]
    data_str = "".join(bridge._BECH32_CHARSET[w] for w in (words + checksum))
    return f"{hrp}1{data_str}"


class _LoopbackNip47Server:
    """A real local loopback SOCKS5h + RFC 6455 WebSocket NIP-47 test server."""

    def __init__(self, wallet_secret_hex: str, handler):
        self.wallet_secret_hex = wallet_secret_hex
        self.wallet_pubkey_hex = bridge._nostr_pubkey_from_secret(wallet_secret_hex)
        self.handler = handler
        self.socks_requests = []
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(5)
        self.port = self._sock.getsockname()[1]
        self._closed = False
        self._thread = threading.Thread(target=self._AcceptLoop, daemon=True)
        self._thread.start()

    def close(self):
        self._closed = True
        try:
            self._sock.close()
        except Exception:
            pass

    def _AcceptLoop(self):
        while not self._closed:
            try:
                conn, _ = self._sock.accept()
            except Exception:
                break
            threading.Thread(target=self._HandleClient, args=(conn,), daemon=True).start()

    def _HandleClient(self, conn: socket.socket):
        try:
            conn.settimeout(5)
            # 1. SOCKS5 greeting
            greeting = bridge._recv_exact(conn, 3)
            if greeting != b"\x05\x01\x00":
                conn.close()
                return
            conn.sendall(b"\x05\x00")
            # 2. SOCKS5 CONNECT request (expect ATYP=3 domain name for SOCKS5h)
            ver, cmd, _rsv, atyp = bridge._recv_exact(conn, 4)
            if ver != 5 or cmd != 1 or atyp != 3:
                conn.sendall(b"\x05\x08\x00\x01\x00\x00\x00\x00\x00\x00")
                conn.close()
                return
            host_len = bridge._recv_exact(conn, 1)[0]
            target_host = bridge._recv_exact(conn, host_len).decode("ascii")
            target_port = int.from_bytes(bridge._recv_exact(conn, 2), "big")
            self.socks_requests.append((atyp, target_host, target_port))
            # Reply success
            conn.sendall(b"\x05\x00\x00\x01\x7f\x00\x00\x01\x1f\x90")

            # 3. WebSocket HTTP Upgrade handshake
            buf = bytearray()
            while b"\r\n\r\n" not in buf:
                chunk = conn.recv(256)
                if not chunk:
                    return
                buf.extend(chunk)
            headers = {}
            for line in buf.decode("latin1").split("\r\n")[1:]:
                if ":" in line:
                    k, _, v = line.partition(":")
                    headers[k.strip().lower()] = v.strip()
            ws_key = headers.get("sec-websocket-key", "")
            accept = base64.b64encode(
                hashlib.sha1((ws_key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
            ).decode("ascii")
            conn.sendall(
                (
                    "HTTP/1.1 101 Switching Protocols\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
                ).encode("ascii")
            )

            # 4. Read REQ and EVENT frames
            sub_id = None
            req_event = None
            for _ in range(2):
                opcode, payload = bridge._ws_recv_frame(conn)
                if opcode != 0x1:
                    continue
                msg = json.loads(payload.decode("utf-8"))
                if msg[0] == "REQ":
                    sub_id = msg[1]
                elif msg[0] == "EVENT":
                    req_event = msg[1]

            if not sub_id or not req_event:
                return

            shared_key = bridge._nip04_shared_secret(self.wallet_secret_hex, req_event["pubkey"])
            decrypted = json.loads(bridge._nip04_decrypt(shared_key, req_event["content"]))
            resp_body = self.handler(decrypted["method"], decrypted.get("params") or {})

            resp_content = bridge._nip04_encrypt(shared_key, json.dumps(resp_body, separators=(",", ":")))
            created_at = int(datetime.now(timezone.utc).timestamp())
            tags = [["p", req_event["pubkey"]], ["e", req_event["id"]]]
            commitment = json.dumps(
                [0, self.wallet_pubkey_hex, created_at, 23195, tags, resp_content],
                separators=(",", ":"),
                ensure_ascii=False,
            )
            event_id = hashlib.sha256(commitment.encode("utf-8")).digest()
            sig = bridge._schnorr_sign(self.wallet_secret_hex, event_id)
            resp_event = {
                "id": event_id.hex(),
                "pubkey": self.wallet_pubkey_hex,
                "created_at": created_at,
                "kind": 23195,
                "tags": tags,
                "content": resp_content,
                "sig": sig,
            }
            out_bytes = json.dumps(["EVENT", sub_id, resp_event]).encode("utf-8")
            # Server-to-client WebSocket frame (unmasked)
            header = bytearray([0x81])
            if len(out_bytes) < 126:
                header.append(len(out_bytes))
            else:
                header.append(126)
                header.extend(len(out_bytes).to_bytes(2, "big"))
            conn.sendall(bytes(header) + out_bytes)
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass


class TestNwcAutoRenew(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.meta_path = os.path.join(self.tmpdir.name, "tunnelsats-meta.json")
        self.wallet_path = os.path.join(self.tmpdir.name, "nwc-wallet.json")
        self.config_path = os.path.join(self.tmpdir.name, "wg0.conf")
        self.app_config_path = os.path.join(self.tmpdir.name, "config.json")
        self.settle_lock_path = os.path.join(self.tmpdir.name, "settle.lock")

        self.wallet_secret = "11" * 32
        self.client_secret = "22" * 32
        self.wallet_pubkey = bridge._nostr_pubkey_from_secret(self.wallet_secret)
        self.wg_private_key = base64.b64encode(bytes([51]) * 32).decode("ascii")
        self.wg_pubkey = bridge.derive_wg_pubkey(self.wg_private_key)
        with open(self.config_path, "w") as f:
            f.write(f"[Interface]\nPrivateKey = {self.wg_private_key}\n")
        bridge.atomic_write_json(self.app_config_path, {"enabled": True})
        self.payment_hash = "ab" * 32
        self.valid_invoice = _build_test_bolt11("45u", self.payment_hash)  # 45u BTC = 4,500 sats

        self.patchers = [
            patch.object(bridge, "META_FILE_PATH", self.meta_path),
            patch.object(bridge, "NWC_WALLET_FILE_PATH", self.wallet_path),
            patch.object(bridge, "CONFIG_PATH", self.config_path),
            patch.object(bridge, "APP_CONFIG_PATH", self.app_config_path),
        ]
        for p in self.patchers:
            p.start()

    def tearDown(self):
        for p in reversed(self.patchers):
            p.stop()
        self.tmpdir.cleanup()

    def test_parse_nwc_uri_and_redaction(self):
        uri = f"nostr+walletconnect://{self.wallet_pubkey}?relay=wss://relay.getalby.com/v1&secret={self.client_secret}"
        parsed = bridge.parse_nwc_uri(uri)
        self.assertEqual(parsed["walletPubkey"], self.wallet_pubkey)
        self.assertEqual(parsed["secret"], self.client_secret)
        self.assertEqual(parsed["relayHost"], "relay.getalby.com")
        self.assertFalse(parsed["hasOnionRelay"])

        onion_uri = f"nostr+walletconnect://{self.wallet_pubkey}?relay=ws://myhub.onion:8080/v1&secret={self.client_secret}"
        parsed_onion = bridge.parse_nwc_uri(onion_uri)
        self.assertTrue(parsed_onion["hasOnionRelay"])
        self.assertEqual(parsed_onion["relays"], ["ws://myhub.onion:8080/v1"])

        # Preserves relay query strings and bracketed IPv6 addresses
        query_ipv6_uri = (
            f"nostr+walletconnect://{self.wallet_pubkey}"
            f"?relay=wss%3A%2F%2F%5B2001%3Adb8%3A%3A1%5D%3A8443%2Fws%3Ftoken%3Dxyz&secret={self.client_secret}"
        )
        parsed_q = bridge.parse_nwc_uri(query_ipv6_uri)
        self.assertEqual(parsed_q["relays"], ["wss://[2001:db8::1]:8443/ws?token=xyz"])
        self.assertEqual(parsed_q["relayHost"], "[2001:db8::1]")

        with self.assertRaisesRegex(ValueError, r"only allowed for \.onion"):
            bridge.parse_nwc_uri(
                f"nostr+walletconnect://{self.wallet_pubkey}?relay=ws://relay.getalby.com/v1&secret={self.client_secret}"
            )

        redacted = bridge._redact_nwc_secrets(f"Failed for {uri} with secret {self.client_secret}", self.client_secret)
        self.assertNotIn(self.client_secret, redacted)
        self.assertNotIn("nostr+walletconnect://", redacted)

    def test_verify_bolt11_invoice_checks_amount_checksum_and_p_tag(self):
        sats = bridge._verify_bolt11_invoice(self.valid_invoice, self.payment_hash)
        self.assertEqual(sats, 4500)

        # Mismatched payment hash is rejected
        with self.assertRaisesRegex(bridge.NwcVerificationError, "does not match"):
            bridge._verify_bolt11_invoice(self.valid_invoice, "cd" * 32)

        # Invoice exceeding 500,000 sats safety ceiling is rejected
        huge_invoice = _build_test_bolt11("6m", self.payment_hash)  # 6m BTC = 600,000 sats
        with self.assertRaisesRegex(bridge.NwcVerificationError, "exceeds the NWC safety ceiling"):
            bridge._verify_bolt11_invoice(huge_invoice, self.payment_hash)

        # Corrupted Bech32 checksum is rejected
        corrupted = self.valid_invoice[:-1] + ("q" if self.valid_invoice[-1] != "q" else "p")
        with self.assertRaisesRegex(bridge.NwcVerificationError, "checksum verification failed"):
            bridge._verify_bolt11_invoice(corrupted, self.payment_hash)

    def test_nip04_and_bip340_schnorr_roundtrip(self):
        client_pub = bridge._nostr_pubkey_from_secret(self.client_secret)
        shared_a = bridge._nip04_shared_secret(self.client_secret, self.wallet_pubkey)
        shared_b = bridge._nip04_shared_secret(self.wallet_secret, client_pub)
        self.assertEqual(shared_a, shared_b)

        encrypted = bridge._nip04_encrypt(shared_a, '{"method":"get_budget","params":{}}')
        decrypted = bridge._nip04_decrypt(shared_b, encrypted)
        self.assertEqual(json.loads(decrypted), {"method": "get_budget", "params": {}})

        # Verify bit-for-bit interoperability against NIST FIPS-197 Appendix C.3 AES-256 test vector
        nist_key = bytes.fromhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
        nist_pt = bytes.fromhex("00112233445566778899aabbccddeeff")
        nist_ct = bytes.fromhex("8ea2b7ca516745bfeafc49904b496089")
        rk = bridge._aes256_expand_key(nist_key)
        self.assertEqual(bridge._aes256_encrypt_block(nist_pt, rk), nist_ct)
        self.assertEqual(bridge._aes256_decrypt_block(nist_ct, rk), nist_pt)

        req_event, shared_key = bridge._build_nip47_request_event(
            self.client_secret, self.wallet_pubkey, "pay_invoice", {"invoice": self.valid_invoice}, created_at=1700000000
        )
        self.assertEqual(req_event["kind"], 23194)
        self.assertTrue(bridge._schnorr_verify(client_pub, bytes.fromhex(req_event["id"]), req_event["sig"]))

    def test_socks5h_and_websocket_nip47_roundtrip(self):
        def handler(method, params):
            if method == "get_budget":
                return {"result_type": "get_budget", "result": {"remaining_budget": 25_000_000}}
            if method == "pay_invoice":
                return {"result_type": "pay_invoice", "result": {"preimage": "ef" * 32}}
            if method == "bad_pay":
                return {"result_type": "pay_invoice", "result": {}}
            return {"result_type": method, "result": {}}

        server = _LoopbackNip47Server(self.wallet_secret, handler)
        self.addCleanup(server.close)

        onion_uri = (
            f"nostr+walletconnect://{self.wallet_pubkey}"
            f"?relay=ws://testwallet.onion:8080/ws&secret={self.client_secret}"
        )
        parsed = bridge.parse_nwc_uri(onion_uri)

        with patch.object(bridge, "TOR_SOCKS_HOST", "127.0.0.1"), patch.object(bridge, "TOR_SOCKS_PORT", server.port):
            budget = bridge.nwc_execute_command(parsed, "get_budget", {}, route_via_tor=True, timeout=5)
            self.assertEqual(budget["remaining_budget"], 25_000_000)
            pay_res = bridge.nwc_execute_command(
                parsed, "pay_invoice", {"invoice": self.valid_invoice}, route_via_tor=True, timeout=5
            )
            self.assertEqual(pay_res["preimage"], "ef" * 32)
            # Verify SOCKS5h ATYP=3 (domain name resolution on proxy) was used for testwallet.onion
            self.assertEqual(server.socks_requests[0], (3, "testwallet.onion", 8080))

        # Verify fragmented WebSocket frames (with interleaved Ping) are reassembled cleanly
        s_a, s_b = socket.socketpair()
        self.addCleanup(s_a.close)
        self.addCleanup(s_b.close)
        # Send fragment 1 (FIN=0, opcode=1 text, "hello "), interleaved Ping (FIN=1, opcode=9), fragment 2 (FIN=1, opcode=0 cont, "world")
        s_a.sendall(b"\x01\x06hello \x89\x02hi\x80\x05world")
        opcode, assembled = bridge._ws_recv_frame(s_b)
        self.assertEqual(opcode, 0x1)
        self.assertEqual(assembled, b"hello world")

        # Verify fail-closed when SOCKS5 proxy is unreachable
        with patch.object(bridge, "TOR_SOCKS_HOST", "127.0.0.1"), patch.object(bridge, "TOR_SOCKS_PORT", 1):
            with self.assertRaisesRegex(bridge.NwcError, "Tor SOCKS5 proxy"):
                bridge.nwc_execute_command(parsed, "get_budget", {}, route_via_tor=True, timeout=1)

    def test_maybe_nwc_auto_renew_happy_path_and_idempotency(self):
        now = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)
        old_expiry = _iso_in(now, days=5)
        new_expiry = _iso_in(now, days=95)

        bridge.atomic_write_json(
            self.meta_path,
            {
                "publicKey": self.wg_pubkey,
                "expiresAt": old_expiry,
                "expirySource": "api",
                "lastDuration": 3,
                "lastAmountSats": 12000,
                "nwcConnected": True,
                "nwcRelayHost": "relay.getalby.com",
                "nwcRouteViaTor": False,
                "nwcAutoRenewDuration": "match",
                # Stale failure from an older expiry period should be cleared automatically
                "nwcAutoRenewState": {
                    "periodExpiry": "2026-06-01T00:00:00Z",
                    "fallbackTaskRaised": True,
                    "budgetWarning": True,
                    "attempts": 3,
                },
            },
        )
        bridge.atomic_write_json(
            self.wallet_path,
            {
                "uri": f"nostr+walletconnect://{self.wallet_pubkey}?relay=wss://relay.getalby.com/v1&secret={self.client_secret}",
                "relayHost": "relay.getalby.com",
                "routeViaTor": False,
                "autoRenewDuration": "match",
            },
        )

        # Verify cross-process nwc_renew_lock returns "busy" when already held
        with patch.object(bridge, "nwc_renew_lock") as fake_lock:
            from contextlib import contextmanager
            @contextmanager
            def busy_cm():
                yield False
            fake_lock.side_effect = busy_cm
            self.assertEqual(bridge.maybe_nwc_auto_renew(self.wg_pubkey, now=now)["result"], "busy")

        nwc_calls = []

        def fake_nwc_command(_parsed, method, params, route_via_tor=False, timeout=20):
            nwc_calls.append((method, params))
            if method == "get_budget":
                return {"remaining_budget": 50_000_000}
            if method == "get_balance":
                return {"balance": 100_000_000}
            if method == "pay_invoice":
                # Verify pendingRenewal was already persisted to disk BEFORE pay_invoice finished!
                persisted = bridge.read_meta().get("pendingRenewal")
                self.assertIsNotNone(persisted)
                self.assertEqual(persisted["paymentHash"], self.payment_hash)
                self.assertIsNotNone(persisted.get("nwcPayInFlightUntil"))
                return {"preimage": "00" * 32}
            return {}

        def fake_api_call(method, path, payload=None):
            if method == "POST" and path == "/subscription/renew":
                self.assertEqual(
                    payload,
                    {"serverId": "eu-de", "wgPublicKey": self.wg_pubkey, "duration": 3},
                )
                return 200, {
                    "renewalId": "ren-123",
                    "paymentHash": self.payment_hash,
                    "invoice": self.valid_invoice,
                    "newExpiry": new_expiry,
                }
            return 200, {}

        with (
            patch.object(bridge, "_api_call", side_effect=fake_api_call),
            patch.object(bridge, "nwc_execute_command", side_effect=fake_nwc_command),
            patch.object(bridge, "settle_pending", return_value={"outcomes": [], "clearPayTasks": [], "busy": False}),
        ):
            res = bridge.maybe_nwc_auto_renew(self.wg_pubkey, now=now)

        self.assertEqual(res["result"], "paid")
        self.assertEqual(res["paymentHash"], self.payment_hash)
        self.assertEqual(res["amountSats"], 4500)
        self.assertEqual([m for m, _ in nwc_calls], ["get_budget", "get_balance", "pay_invoice"])

        meta_after = bridge.read_meta()
        self.assertEqual(meta_after["lastDuration"], 3)
        self.assertEqual(meta_after["lastAmountSats"], 4500)
        self.assertEqual(meta_after["nwcAutoRenewState"]["lastPaidHash"], self.payment_hash)
        self.assertEqual(meta_after["nwcAutoRenewState"]["lastPaidDuration"], 3)
        # lastPaidNewExpiry is None until _clear_pending confirms the extended expiry!
        self.assertIsNone(meta_after["nwcAutoRenewState"]["lastPaidNewExpiry"])
        self.assertEqual(meta_after["pendingRenewal"]["paymentReceivedFor"], self.payment_hash)
        self.assertIsNone(meta_after["pendingRenewal"].get("nwcPayInFlightUntil"))

        # Calling maybe_nwc_auto_renew again while pendingRenewal has paymentReceivedFor is idempotent
        nwc_calls.clear()
        with patch.object(bridge, "settle_pending", return_value={"outcomes": [], "clearPayTasks": [], "busy": False}):
            res_again = bridge.maybe_nwc_auto_renew(self.wg_pubkey, now=now)
        self.assertEqual(res_again["result"], "already-paid")
        self.assertEqual(nwc_calls, [])

        # Once _finish_pending confirms the extended expiry, lastPaidNewExpiry is populated
        bridge._finish_pending("pendingRenewal", self.payment_hash, confirmed_expiry=new_expiry)
        self.assertEqual(bridge.read_meta()["nwcAutoRenewState"]["lastPaidNewExpiry"], new_expiry)

    def _seed_auto_renew_state(self, now, pending=None):
        meta = {
            "publicKey": self.wg_pubkey,
            "expiresAt": _iso_in(now, days=5),
            "expirySource": "api",
            "lastDuration": 1,
            "nwcConnected": True,
            "nwcRelayHost": "relay.getalby.com",
            "nwcAutoRenewDuration": "1m",
        }
        if pending is not None:
            meta["pendingRenewal"] = pending
        bridge.atomic_write_json(self.meta_path, meta)
        bridge.atomic_write_json(
            self.wallet_path,
            {
                "uri": f"nostr+walletconnect://{self.wallet_pubkey}?relay=wss://relay.getalby.com/v1&secret={self.client_secret}",
                "relayHost": "relay.getalby.com",
                "autoRenewDuration": "1m",
            },
        )

    def _pending(self, now, payment_hash, invoice, *, expires_in_minutes, **extra):
        entry = {
            "renewalId": payment_hash,
            "paymentHash": payment_hash,
            "invoice": invoice,
            "amountSats": 4500,
            "duration": 1,
            "publicKey": self.wg_pubkey,
            "targetNode": "lnd",
            "createdAt": bridge._iso(now - timedelta(hours=2)),
            "expiresAt": bridge._iso(now + timedelta(minutes=expires_in_minutes)),
            "paidViaNwc": False,
            "nwcAttempted": False,
        }
        entry.update(extra)
        return entry

    def _run_auto_renew(self, now, concurrent_write=None, during_preflight=None, payment_state="expired"):
        """Runs the real maybe_nwc_auto_renew (including the real settle_pending)
        with only API/NWC transport patched. concurrent_write, if given, is
        written as pendingRenewal while the /subscription/renew call is in
        flight (between the initial read and the meta_lock re-check);
        during_preflight, if given, is a callable run inside the NWC get_budget
        preflight (after the invoice is chosen, before pay_invoice)."""
        paid_invoices = []

        def fake_api_call(method, path, payload=None):
            if method == "POST" and path == "/subscription/renew":
                if concurrent_write is not None:
                    m = bridge.read_meta()
                    m["pendingRenewal"] = concurrent_write
                    bridge.atomic_write_json(self.meta_path, m)
                return 200, {"renewalId": "fresh", "paymentHash": self.payment_hash, "invoice": self.valid_invoice}
            return 200, {}

        def fake_nwc(_parsed, method, params, **_kw):
            if method == "get_budget":
                if during_preflight is not None:
                    during_preflight()
                return {"remaining_budget": 50_000_000}
            if method == "get_balance":
                return {"balance": 100_000_000}
            if method == "pay_invoice":
                paid_invoices.append(params["invoice"])
                return {"preimage": "00" * 32}
            return {}

        with (
            patch.object(bridge, "_api_call", side_effect=fake_api_call),
            patch.object(bridge, "_payment_state", return_value=payment_state),
            patch.object(bridge, "nwc_execute_command", side_effect=fake_nwc),
        ):
            res = bridge.maybe_nwc_auto_renew(self.wg_pubkey, now=now)
        return res, paid_invoices

    def test_auto_renew_replaces_expired_pending_renewal_instead_of_resurrecting_it(self):
        # QA R4.2: an expired pendingRenewal from an earlier session must never be paid.
        now = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)
        stale_hash = "cd" * 32
        stale_invoice = _build_test_bolt11("45u", stale_hash)
        self._seed_auto_renew_state(now, self._pending(now, stale_hash, stale_invoice, expires_in_minutes=-30))

        res, paid = self._run_auto_renew(now)

        self.assertEqual(res["result"], "paid")
        self.assertEqual(res["paymentHash"], self.payment_hash)
        self.assertEqual(paid, [self.valid_invoice])
        meta = bridge.read_meta()
        self.assertEqual(meta["pendingRenewal"]["paymentHash"], self.payment_hash)
        self.assertIn(bridge.pay_task_replay_id("renewal", "lnd", stale_hash), meta["payTasksToClear"])

    def test_auto_renew_does_not_reuse_concurrent_entry_equal_to_stale_or_expired(self):
        now = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)
        stale_hash = "cd" * 32
        stale_invoice = _build_test_bolt11("45u", stale_hash)
        stale = self._pending(now, stale_hash, stale_invoice, expires_in_minutes=-30)

        # Concurrent re-write of the same stale entry (even with a bogus future expiry) is not reused.
        self._seed_auto_renew_state(now, stale)
        res, paid = self._run_auto_renew(now, concurrent_write=dict(stale, expiresAt=bridge._iso(now + timedelta(minutes=30))))
        self.assertEqual(res["result"], "paid")
        self.assertEqual(paid, [self.valid_invoice])

        # A different but expired concurrent entry is replaced and its pay task is cleared.
        other_hash = "ef" * 32
        other = self._pending(now, other_hash, _build_test_bolt11("45u", other_hash), expires_in_minutes=-5)
        self._seed_auto_renew_state(now, stale)
        res, paid = self._run_auto_renew(now, concurrent_write=other)
        self.assertEqual(res["result"], "paid")
        self.assertEqual(paid, [self.valid_invoice])
        meta = bridge.read_meta()
        self.assertEqual(meta["pendingRenewal"]["paymentHash"], self.payment_hash)
        self.assertIn(bridge.pay_task_replay_id("renewal", "lnd", other_hash), meta["payTasksToClear"])

    def test_auto_renew_reuses_genuine_concurrent_unpaid_invoice(self):
        now = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)
        other_hash = "ef" * 32
        other_invoice = _build_test_bolt11("45u", other_hash)
        self._seed_auto_renew_state(now)

        res, paid = self._run_auto_renew(
            now, concurrent_write=self._pending(now, other_hash, other_invoice, expires_in_minutes=30)
        )

        self.assertEqual(res["result"], "paid")
        self.assertEqual(res["paymentHash"], other_hash)
        self.assertEqual(paid, [other_invoice])
        self.assertEqual(bridge.read_meta()["pendingRenewal"]["paymentHash"], other_hash)

    def test_auto_renew_skips_mismatched_duration_pending_renewal(self):
        now = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)
        other_hash = "ef" * 32
        other_invoice = _build_test_bolt11("45u", other_hash)
        manual_12m = self._pending(now, other_hash, other_invoice, expires_in_minutes=30, duration=12)

        # 1. Existing unpaid 12m pendingRenewal when NWC auto-renew resolves to 1m:
        # neither paid nor overwritten.
        self._seed_auto_renew_state(now, manual_12m)
        res, paid = self._run_auto_renew(now, payment_state="unpaid")
        self.assertEqual(res["result"], "manual-pending")
        self.assertEqual(res["paymentHash"], other_hash)
        self.assertEqual(paid, [])
        self.assertEqual(bridge.read_meta()["pendingRenewal"]["paymentHash"], other_hash)
        self.assertEqual(bridge.read_meta()["pendingRenewal"]["duration"], 12)

        # 2. Concurrent unpaid 12m pendingRenewal created while /subscription/renew is in flight:
        # neither paid nor overwritten.
        self._seed_auto_renew_state(now)
        res_conc, paid_conc = self._run_auto_renew(now, concurrent_write=manual_12m)
        self.assertEqual(res_conc["result"], "manual-pending")
        self.assertEqual(res_conc["paymentHash"], other_hash)
        self.assertEqual(paid_conc, [])
        self.assertEqual(bridge.read_meta()["pendingRenewal"]["paymentHash"], other_hash)
        self.assertEqual(bridge.read_meta()["pendingRenewal"]["duration"], 12)

    def test_auto_renew_does_not_pay_after_disable_during_preflight(self):
        now = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)
        self._seed_auto_renew_state(now)

        def disable():
            bridge.atomic_write_json(self.app_config_path, {"enabled": False})
            os.remove(self.config_path)

        res, paid = self._run_auto_renew(now, during_preflight=disable)

        self.assertEqual(res["result"], "disabled")
        self.assertEqual(paid, [])
        self.assertFalse(bridge.read_meta()["pendingRenewal"]["nwcAttempted"])

    def test_auto_renew_does_not_pay_after_key_change_during_preflight(self):
        now = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)
        self._seed_auto_renew_state(now)

        def replace_key():
            private_key = base64.b64encode(bytes([68]) * 32).decode("ascii")
            bridge.atomic_write_file(self.config_path, f"[Interface]\nPrivateKey = {private_key}\n")

        res, paid = self._run_auto_renew(now, during_preflight=replace_key)

        self.assertEqual(res["result"], "superseded")
        self.assertEqual(paid, [])
        self.assertFalse(bridge.read_meta()["pendingRenewal"]["nwcAttempted"])

    def test_auto_renew_rejects_invoice_above_duration_ceiling_and_raises_fallback(self):
        now = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)
        self._seed_auto_renew_state(now)
        # 2m BTC = 200,000 sats: below the 500k global cap, but above the 50,000-sat 1m ceiling
        overpriced_1m_invoice = _build_test_bolt11("2m", self.payment_hash)
        paid_invoices = []

        def fake_api_call(method, path, payload=None):
            if method == "POST" and path == "/subscription/renew":
                return 200, {"renewalId": "fresh", "paymentHash": self.payment_hash, "invoice": overpriced_1m_invoice}
            return 200, {}

        def fake_nwc(_parsed, method, params, **_kw):
            if method == "pay_invoice":
                paid_invoices.append(params["invoice"])
            return {}

        with (
            patch.object(bridge, "_api_call", side_effect=fake_api_call),
            patch.object(bridge, "_payment_state", return_value="expired"),
            patch.object(bridge, "nwc_execute_command", side_effect=fake_nwc),
        ):
            res = bridge.maybe_nwc_auto_renew(self.wg_pubkey, now=now)

        self.assertEqual(res["result"], "verification-failed")
        self.assertEqual(paid_invoices, [])
        meta = bridge.read_meta()
        self.assertTrue(meta["nwcAutoRenewState"]["fallbackTaskRaised"])
        self.assertTrue(meta["pendingRenewal"]["raisePayTask"])
        self.assertEqual(meta["pendingRenewal"]["paymentHash"], self.payment_hash)

    def test_auto_renew_never_overwrites_or_repays_concurrent_paid_renewal(self):
        now = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)
        other_hash = "ef" * 32
        other_invoice = _build_test_bolt11("45u", other_hash)
        self._seed_auto_renew_state(now)
        # Paid but not yet settled; invoice expiry already passed (paid invoices expire too).
        paid_entry = self._pending(now, other_hash, other_invoice, expires_in_minutes=-1, paymentReceivedFor=other_hash)

        res, paid = self._run_auto_renew(now, concurrent_write=paid_entry)

        self.assertEqual(res, {"result": "already-paid", "paymentHash": other_hash})
        self.assertEqual(paid, [])
        pending_after = bridge.read_meta()["pendingRenewal"]
        self.assertEqual(pending_after["paymentHash"], other_hash)
        self.assertEqual(pending_after["paymentReceivedFor"], other_hash)

    def test_auto_renew_does_not_pay_invoice_superseded_during_preflight(self):
        now = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)
        other_hash = "ef" * 32
        replacement = self._pending(now, other_hash, _build_test_bolt11("45u", other_hash), expires_in_minutes=30)

        def replace_pending():
            m = bridge.read_meta()
            m["pendingRenewal"] = replacement
            bridge.atomic_write_json(self.meta_path, m)

        def clear_pending():
            m = bridge.read_meta()
            m.pop("pendingRenewal", None)
            bridge.atomic_write_json(self.meta_path, m)

        for mutate in (replace_pending, clear_pending):
            with self.subTest(mutate=mutate.__name__):
                self._seed_auto_renew_state(now)
                res, paid = self._run_auto_renew(now, during_preflight=mutate)
                self.assertEqual(res["result"], "superseded")
                self.assertEqual(res["paymentHash"], self.payment_hash)
                self.assertEqual(paid, [])

    def test_maybe_nwc_auto_renew_preflight_budget_and_transient_retry_fallback(self):
        now = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)
        old_expiry = _iso_in(now, days=4)

        def reset_state():
            bridge.atomic_write_json(
                self.meta_path,
                {
                    "publicKey": self.wg_pubkey,
                    "expiresAt": old_expiry,
                    "expirySource": "api",
                    "nwcConnected": True,
                    "nwcRelayHost": "relay.getalby.com",
                },
            )
            bridge.atomic_write_json(
                self.wallet_path,
                {
                    "uri": f"nostr+walletconnect://{self.wallet_pubkey}?relay=wss://relay.getalby.com/v1&secret={self.client_secret}",
                    "relayHost": "relay.getalby.com",
                },
            )

        reset_state()
        fake_renew = lambda *_a, **_kw: (
            200,
            {"renewalId": "r1", "paymentHash": self.payment_hash, "invoice": self.valid_invoice},
        )

        # 1. Pre-flight budget check detects insufficient remaining_budget (2,000 sats < 4,500 sats)
        def low_budget_nwc(_parsed, method, _params, **_kw):
            if method == "get_budget":
                return {"remaining_budget": 2_000_000}
            raise AssertionError(f"Should not call {method} when budget is insufficient")

        with (
            patch.object(bridge, "_api_call", side_effect=fake_renew),
            patch.object(bridge, "nwc_execute_command", side_effect=low_budget_nwc),
        ):
            res = bridge.maybe_nwc_auto_renew(self.wg_pubkey, now=now)

        self.assertEqual(res["result"], "budget-insufficient")
        meta = bridge.read_meta()
        self.assertTrue(meta["nwcAutoRenewState"]["budgetWarning"])
        self.assertTrue(meta["nwcAutoRenewState"]["fallbackTaskRaised"])
        self.assertTrue(meta["pendingRenewal"]["raisePayTask"])
        # Because pay_invoice was never called, paidViaNwc is False so manual payment is not misattributed
        self.assertFalse(meta["pendingRenewal"]["paidViaNwc"])

        # Shortened or same expiry does not clear fallback state, only strictly later expiry does
        self.assertFalse(bridge._nwc_period_advanced(old_expiry, _iso_in(now, days=3)))
        self.assertFalse(bridge._nwc_period_advanced(old_expiry, old_expiry))
        self.assertTrue(bridge._nwc_period_advanced(old_expiry, _iso_in(now, days=30)))

        # Disconnecting wallet during budget preflight aborts before pay_invoice is called
        reset_state()
        pay_called = False

        def disconnect_during_preflight(_parsed, method, _params, **_kw):
            nonlocal pay_called
            if method == "get_budget":
                os.remove(self.wallet_path)
                m = bridge.read_meta()
                m["nwcConnected"] = False
                bridge.atomic_write_json(self.meta_path, m)
                return {"remaining_budget": 50_000_000}
            if method == "pay_invoice":
                pay_called = True
            return {}

        with (
            patch.object(bridge, "_api_call", side_effect=fake_renew),
            patch.object(bridge, "nwc_execute_command", side_effect=disconnect_during_preflight),
        ):
            res_disc = bridge.maybe_nwc_auto_renew(self.wg_pubkey, now=now)
        self.assertEqual(res_disc["result"], "disabled")
        self.assertFalse(pay_called)

        # 2. Transient errors retry up to K=3 attempts before raising fallback,
        # and an "unknown" payment status preserves the existing pending invoice
        reset_state()
        renew_api_calls = 0

        def counting_renew(*_a, **_kw):
            nonlocal renew_api_calls
            renew_api_calls += 1
            return 200, {"renewalId": "r1", "paymentHash": self.payment_hash, "invoice": self.valid_invoice}

        def transient_fail_nwc(_parsed, method, _params, **_kw):
            if method in ("get_budget", "get_balance", "lookup_invoice"):
                return {}
            raise bridge.NwcError("Relay timeout", code="INTERNAL", permanent=False)

        with (
            patch.object(bridge, "_api_call", side_effect=counting_renew),
            patch.object(bridge, "_payment_state", return_value="unpaid"),
            patch.object(bridge, "nwc_execute_command", side_effect=transient_fail_nwc),
        ):
            r1 = bridge.maybe_nwc_auto_renew(self.wg_pubkey, now=now)
            self.assertEqual(r1["result"], "retry-scheduled")
            self.assertEqual(renew_api_calls, 1)
            self.assertFalse(bridge.read_meta()["pendingRenewal"].get("raisePayTask"))

            # Within backoff window -> returns backoff
            r_backoff = bridge.maybe_nwc_auto_renew(self.wg_pubkey, now=now + timedelta(minutes=10))
            self.assertEqual(r_backoff["result"], "backoff")

            # If _payment_state returns "unknown" after an NWC attempt, existing invoice is preserved (no new /subscription/renew call)
            with patch.object(bridge, "_payment_state", return_value="unknown"):
                r_unk = bridge.maybe_nwc_auto_renew(self.wg_pubkey, now=now + timedelta(hours=1, minutes=1))
            self.assertEqual(r_unk["result"], "deferred-unknown-status")
            self.assertEqual(renew_api_calls, 1)

            # Attempt 2 after 1 hour (1h invoice TTL elapsed and API confirms unpaid -> fetches fresh invoice)
            r2 = bridge.maybe_nwc_auto_renew(self.wg_pubkey, now=now + timedelta(hours=1, minutes=1))
            self.assertEqual(r2["result"], "retry-scheduled")
            self.assertEqual(renew_api_calls, 2)
            self.assertFalse(bridge.read_meta()["pendingRenewal"].get("raisePayTask"))

            # Attempt 3 after another hour -> trips fallback!
            r3 = bridge.maybe_nwc_auto_renew(self.wg_pubkey, now=now + timedelta(hours=2, minutes=2))
            self.assertEqual(r3["result"], "fallback-raised")
            meta_after_3 = bridge.read_meta()
            self.assertTrue(meta_after_3["nwcAutoRenewState"]["fallbackTaskRaised"])
            self.assertTrue(meta_after_3["pendingRenewal"]["raisePayTask"])

    def test_post_restore_missing_wallet_and_dashboard_never_leaks_secret(self):
        now = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)
        bridge.atomic_write_json(
            self.meta_path,
            {
                "publicKey": self.wg_pubkey,
                "expiresAt": _iso_in(now, days=5),
                "expirySource": "api",
                "lastDuration": 3,
                "lastAmountSats": 10000,
                "nwcConnected": True,
                "nwcRelayHost": "relay.getalby.com",
                "nwcRouteViaTor": True,
                "nwcAutoRenewDuration": "match",
            },
        )
        # Note: self.wallet_path does NOT exist (simulating StartOS backup restore)
        res = bridge.maybe_nwc_auto_renew(self.wg_pubkey, now=now)
        self.assertEqual(res["result"], "restore-reconnect-needed")
        self.assertTrue(bridge.read_meta()["nwcAutoRenewState"]["restoreReconnectNeeded"])

        # Write wallet file with secret and verify get_dashboard() never leaks it
        bridge.atomic_write_json(
            self.wallet_path,
            {
                "uri": f"nostr+walletconnect://{self.wallet_pubkey}?relay=wss://relay.getalby.com/v1&secret={self.client_secret}",
                "relayHost": "relay.getalby.com",
            },
        )
        with patch.object(bridge, "get_status", return_value={"configured": True, "pubkey": self.wg_pubkey}):
            dash = bridge.get_dashboard()
        dash_json = json.dumps(dash)
        self.assertNotIn(self.client_secret, dash_json)
        self.assertNotIn("nostr+walletconnect://", dash_json)
        self.assertTrue(dash["nwc"]["connected"])
        self.assertEqual(dash["nwc"]["relayHost"], "relay.getalby.com")
        self.assertEqual(dash["nwc"]["recommendedBudgetSats"], 12000)
        self.assertEqual(dash["nwc"]["recommendedAnnualSats"], 48000)


def _iso_in(now: datetime, days: int) -> str:
    return (now + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


if __name__ == "__main__":
    unittest.main()
