"""The cross-runtime metadata lock (#94).

The TypeScript actions cannot flock, so they hold bridge.py's meta_lock
through `bridge.py meta-lock`: the holder takes the same lock file, prints
`locked`, and keeps the lock until its stdin reaches EOF or its lease runs
out. These tests run the real holder, as a subprocess for the CLI and in
process for the timeouts."""
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import bridge

BRIDGE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'bridge.py'))


def lock_is_free(lock_path):
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False
    finally:
        os.close(fd)


class MetaLockBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = self._tmp.name
        self.meta_path = os.path.join(self.data_dir, "tunnelsats-meta.json")
        self.lock_path = self.meta_path + ".lock"
        self._orig = bridge.META_FILE_PATH
        bridge.META_FILE_PATH = self.meta_path
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                p.kill()
            p.wait()
            for stream in (p.stdin, p.stdout, p.stderr):
                if stream:
                    stream.close()
        bridge.META_FILE_PATH = self._orig
        self._tmp.cleanup()

    def spawn(self, *args):
        env = dict(os.environ, DATA_DIR=self.data_dir)
        p = subprocess.Popen([sys.executable, BRIDGE, *args], env=env,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True)
        self.procs.append(p)
        return p


class TestMetaLockHolder(MetaLockBase):
    def test_holds_meta_lock_until_stdin_closes(self):
        holder = self.spawn("meta-lock")
        self.assertEqual(holder.stdout.readline().strip(), "locked")
        self.assertFalse(lock_is_free(self.lock_path))
        holder.stdin.close()
        self.assertEqual(holder.stdout.readline().strip(), "released")
        self.assertEqual(holder.wait(timeout=10), 0)
        self.assertTrue(lock_is_free(self.lock_path))

    def test_a_bridge_writer_waits_for_the_holder(self):
        with open(self.meta_path, "w") as f:
            json.dump({"payTasksToClear": ["a", "b"]}, f)
        holder = self.spawn("meta-lock")
        self.assertEqual(holder.stdout.readline().strip(), "locked")
        writer = self.spawn("settle-ack", "a")
        time.sleep(0.5)
        self.assertIsNone(writer.poll(), "settle-ack must block on meta_lock while it is held")
        # The holder's owner writes while it holds the lock.
        with open(self.meta_path, "w") as f:
            json.dump({"payTasksToClear": ["a", "b", "c"]}, f)
        holder.stdin.close()
        self.assertEqual(holder.wait(timeout=10), 0)
        self.assertEqual(writer.wait(timeout=10), 0)
        with open(self.meta_path) as f:
            self.assertEqual(json.load(f)["payTasksToClear"], ["b", "c"])

    def test_a_killed_owner_releases_the_lock(self):
        # The owner (the TypeScript runtime) dies: its end of the pipe closes.
        holder = self.spawn("meta-lock")
        self.assertEqual(holder.stdout.readline().strip(), "locked")
        holder.stdin.close()
        holder.wait(timeout=10)
        self.assertTrue(lock_is_free(self.lock_path))


class TestHoldMetaLockTimeouts(MetaLockBase):
    def test_acquire_timeout_fails_without_printing_locked(self):
        fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        r, w = os.pipe()
        out = tempfile.TemporaryFile("w+")
        try:
            started = time.monotonic()
            code = bridge.hold_meta_lock(r, out, acquire_timeout=0.3, lease=5)
            self.assertEqual(code, bridge.META_LOCK_EXIT_BUSY)
            self.assertLess(time.monotonic() - started, 3)
            out.seek(0)
            printed = out.read()
            self.assertNotIn("locked\n", printed)
            self.assertIn("error", json.loads(printed.strip()))
        finally:
            os.close(fd)
            os.close(r)
            os.close(w)
            out.close()

    def test_lease_expiry_releases_a_leaked_lock(self):
        r, w = os.pipe()  # the write end stays open: nobody releases
        out = tempfile.TemporaryFile("w+")
        try:
            code = bridge.hold_meta_lock(r, out, acquire_timeout=1, lease=0.3)
            self.assertEqual(code, bridge.META_LOCK_EXIT_LEASE)
            out.seek(0)
            self.assertEqual(out.readline(), "locked\n")
            self.assertTrue(lock_is_free(self.lock_path))
        finally:
            os.close(r)
            os.close(w)
            out.close()

    def test_heartbeats_renew_the_lease(self):
        r, w = os.pipe()
        out = tempfile.TemporaryFile("w+")
        result = {}

        def hold():
            result["code"] = bridge.hold_meta_lock(r, out, acquire_timeout=1, lease=0.3)

        t = threading.Thread(target=hold)
        t.start()
        try:
            # Held well past one lease while heartbeats keep coming.
            for _ in range(10):
                time.sleep(0.1)
                os.write(w, b"\n")
            self.assertTrue(t.is_alive())
            self.assertFalse(lock_is_free(self.lock_path))
            # Silence ends the hold after one lease.
            t.join(timeout=5)
            self.assertEqual(result["code"], bridge.META_LOCK_EXIT_LEASE)
            self.assertTrue(lock_is_free(self.lock_path))
        finally:
            t.join()
            os.close(r)
            os.close(w)
            out.close()

    def test_waits_for_a_python_writer_then_locks(self):
        released = threading.Event()
        r, w = os.pipe()

        def python_writer():
            with bridge.meta_lock():
                time.sleep(0.3)
            released.set()
            os.close(w)  # EOF once the holder can take the lock

        t = threading.Thread(target=python_writer)
        t.start()
        time.sleep(0.05)
        out = tempfile.TemporaryFile("w+")
        try:
            code = bridge.hold_meta_lock(r, out, acquire_timeout=5, lease=5)
            self.assertTrue(released.is_set())
            self.assertEqual(code, 0)
            out.seek(0)
            self.assertEqual(out.read(), "locked\nreleased\n")
        finally:
            t.join()
            os.close(r)
            out.close()

    def test_disconnected_owner_stops_polling_before_acquire_timeout(self):
        fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        r, w = os.pipe()
        os.close(w)  # Owner already disconnected while the lock is busy
        out = tempfile.TemporaryFile("w+")
        try:
            started = time.monotonic()
            code = bridge.hold_meta_lock(r, out, acquire_timeout=10, lease=5)
            self.assertEqual(code, 0)
            self.assertLess(time.monotonic() - started, 1)
            out.seek(0)
            self.assertEqual(out.read(), "")
        finally:
            os.close(fd)
            os.close(r)
            out.close()


if __name__ == "__main__":
    unittest.main()
