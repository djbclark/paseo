#!/usr/bin/env python3
"""Source-unit tests only: syscall doubles are never namespace/qualification proof.

The producer's privileged disposable Linux acquisition fixture owns real mount,
fresh exec, host-unchanged and mapped-inode evidence. Do not run these locally.
"""

import importlib.util
import contextlib
import io
import os
import pathlib
import stat
import struct
import sys
import tempfile
import types
import unittest
from unittest import mock


SOURCE = pathlib.Path(__file__).with_name("qualified-system-namespace.py")
SPEC = importlib.util.spec_from_file_location("qualified_system_namespace", SOURCE)
ns = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ns
SPEC.loader.exec_module(ns)


def elf_bytes(dynamic_tag=None):
    data = bytearray(512)
    data[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HHI", data, 16, 3, 62, 1)
    struct.pack_into("<Q", data, 32, 64)
    struct.pack_into("<HH", data, 54, 56, 1 if dynamic_tag is None else 2)
    struct.pack_into("<IIQQQQQQ", data, 64, 1, 5, 0, 0x400000, 0, 512, 512, 4096)
    if dynamic_tag is not None:
        struct.pack_into("<IIQQQQQQ", data, 120, 2, 6, 192, 0x4000C0, 0, 64, 64, 8)
        for index, entry in enumerate(((5, 0x400140), (10, 32), (dynamic_tag, 0), (0, 0))):
            struct.pack_into("<qQ", data, 192 + index * 16, *entry)
        data[320:330] = b"libc.so.6\x00"
    return bytes(data)


def cache_bytes(hwcap=0):
    names = b"libc.so.6\x00/usr/lib/libc.so.6\x00"
    data = bytearray(72 + len(names))
    data[:20] = b"glibc-ld.so.cache1.1"
    struct.pack_into("<II", data, 20, 1, len(names))
    data[28] = 2
    struct.pack_into("<iIIIQ", data, 48, 0x303, 72, 82, 0, hwcap)
    data[72:] = names
    return bytes(data)


class SchemaTests(unittest.TestCase):
    def test_json_duplicates_and_nonfinite_values_refuse(self):
        for data in (b'{"a":1,"a":2}', b'{"a":NaN}', b'\xff', b'{'):
            with self.subTest(data=data), self.assertRaises(ns.Hold):
                ns.decode_json(data)

    def test_paths_never_become_mount_instruction_language(self):
        for path in ("relative", "/", "//usr/lib/x", "/usr/../lib/x", "/usr/./lib/x", "/x\x00"):
            with self.subTest(path=path), self.assertRaises(ns.Hold):
                ns.absolute(path)
        for path in ("/absolute", "../x", "a/../x", "a//x", "a/./x", ""):
            with self.subTest(path=path), self.assertRaises(ns.Hold):
                ns.relative(path)

    def test_retained_rows_require_normalized_mode_and_exact_mapping(self):
        row = {"path": "/usr/lib/loader.so", "retainedPath": "system-closure/elf/usr/lib/loader.so",
               "mode": 0o555, "size": 10, "sha256": "a" * 64}
        self.assertEqual(ns.file_row(row, retained=True), row)
        for changed in ({**row, "mode": 0o755}, {**row, "size": True},
                        {**row, "retainedPath": "system-closure/elf/../other"},
                        {**row, "approved": True}, {**row, "sha256": "bad"}):
            with self.subTest(changed=changed), self.assertRaises(ns.Hold):
                ns.file_row(changed, retained=True)

    def test_real_elf_fields_come_from_bytes_not_the_json(self):
        row = ns.elf_metadata(elf_bytes(1), "runtime/node")
        self.assertEqual(row["machine"], 62)
        self.assertEqual(row["needed"], ["libc.so.6"])
        for data in (b"not ELF", elf_bytes(0x6FFFFEFC), elf_bytes(0x7FFFFFFF)):
            with self.subTest(data=data[:16]), self.assertRaises(ns.Hold):
                ns.elf_metadata(data, "runtime/node")
        malformed = bytearray(elf_bytes())
        struct.pack_into("<Q", malformed, 32, 999999)
        with self.assertRaises(ns.Hold):
            ns.elf_metadata(bytes(malformed), "runtime/node")

    def test_actual_cache_format_and_hwcaps_are_checked(self):
        with mock.patch.object(ns.os.path, "realpath", side_effect=lambda value: value):
            rows = ns.cache_entries(cache_bytes(), {"libc.so.6"}, 62)
            self.assertEqual(rows, [{"soname": "libc.so.6", "path": "/usr/lib/libc.so.6",
                                     "target": "/usr/lib/libc.so.6", "flags": 0x303, "hwcap": "0"}])
            with self.assertRaises(ns.Hold):
                ns.cache_entries(cache_bytes(1), {"libc.so.6"}, 62)
        with self.assertRaises(ns.Hold):
            ns.cache_entries(b"", {"libc.so.6"}, 62)
        malformed = bytearray(cache_bytes())
        struct.pack_into("<I", malformed, 52, 2**31)
        with self.assertRaises(ns.Hold):
            ns.cache_entries(bytes(malformed), {"libc.so.6"}, 62)

    def test_recipe_is_fixed_node_harness_and_derived_account(self):
        with tempfile.TemporaryDirectory() as directory:
            root = str(pathlib.Path(directory).resolve())
            bootstrap = pathlib.Path(root, "system-closure", "namespace-bootstrap.py")
            bootstrap.parent.mkdir()
            bootstrap.write_text("source unit only")
            caller = types.SimpleNamespace(uid=1001, gid=1001, groups=(1001, 1002),
                                           home="/home/fixture", name="fixture")
            recipe = {"schemaVersion": 1, "profile": "linux-ci-qualified-system-namespace-v1",
                      "distributionRoot": root, "manifestSha256": "a" * 64,
                      "bootstrap": {"path": str(bootstrap), "sha256": "b" * 64, "size": 16},
                      "harness": {"path": "/opt/protected/probe.mjs", "sha256": "c" * 64, "size": 10},
                      "arguments": ["--mode", "probe"], "environment": {"CI": "true"}}
            with mock.patch.object(ns, "__file__", str(bootstrap)):
                environment = ns.launch_recipe(recipe, root, "a" * 64, caller)
                self.assertEqual(environment, {"CI": "true", "HOME": caller.home,
                                                "USER": "fixture", "LOGNAME": "fixture"})
                changes = ({"environment": {"LD_PRELOAD": "/candidate.so"}},
                           {"environment": {"HOME": "/root"}},
                           {"environment": {"QUALIFIED_DAEMON_ROOT": "/other"}},
                           {"arguments": ["x"] * 31}, {"command": "sudo"},
                           {"caller": {"uid": 0, "gid": 0, "groups": [], "home": "/root"}},
                           {"harness": {**recipe["harness"], "path": root + "/candidate.mjs"}})
                for change in changes:
                    with self.subTest(change=change), self.assertRaises(ns.Hold):
                        ns.launch_recipe({**recipe, **change}, root, "a" * 64, caller)

    def test_unknown_cli_arguments_are_bounded_and_redacted(self):
        with mock.patch.object(ns.sys, "stderr", new_callable=io.StringIO) as error:
            self.assertEqual(ns.main(["--arbitrary-secret", "not-for-logs"]), 1)
            self.assertIn("QUALIFIED_NAMESPACE_HOLD", error.getvalue())
            self.assertNotIn("not-for-logs", error.getvalue())

    def test_fifo_link_or_writable_authority_is_rejected_before_open(self):
        for mode, owner, links in ((stat.S_IFIFO | 0o444, 0, 1),
                                   (stat.S_IFLNK | 0o777, 0, 1),
                                   (stat.S_IFREG | 0o666, 0, 1),
                                   (stat.S_IFREG | 0o444, 1001, 1),
                                   (stat.S_IFREG | 0o444, 0, 2)):
            info = types.SimpleNamespace(st_mode=mode, st_uid=owner, st_nlink=links, st_size=0)
            with self.subTest(mode=mode, owner=owner, links=links), \
                    mock.patch.object(ns, "protected_ancestors", return_value=()), \
                    mock.patch.object(ns.os, "lstat", return_value=info), \
                    mock.patch.object(ns.os, "open") as open_file:
                with self.assertRaises(ns.Hold):
                    ns.checked_file("/opt/protected/file", 4096)
                open_file.assert_not_called()

    def test_alias_cycles_and_unlisted_endpoints_never_create_targets(self):
        cyclic = [{"path": "/lib/a", "target": "/lib/b", "linkText": "b"},
                  {"path": "/lib/b", "target": "/lib/a", "linkText": "a"}]
        unknown = [{"path": "/lib/a", "target": "/unlisted/object", "linkText": "/unlisted/object"}]
        for aliases in (cyclic, unknown):
            distribution = ns.Distribution.__new__(ns.Distribution)
            distribution.loader = {"searchDirectories": [], "aliases": aliases}
            distribution.external = {}
            distribution.interpreters = {}
            with self.subTest(aliases=aliases), mock.patch.object(ns.os.path, "lexists", return_value=False), \
                    mock.patch.object(ns.os, "lstat") as inspect, \
                    mock.patch.object(ns.os, "mkdir") as create:
                with self.assertRaises(ns.Hold):
                    distribution.verify_layout()
                inspect.assert_not_called()
                create.assert_not_called()

    def test_proc_reader_consumes_short_reads_and_refuses_oversize(self):
        with mock.patch.object(ns.os, "open", return_value=7), \
                mock.patch.object(ns.os, "close"), \
                mock.patch.object(ns.os, "read", side_effect=[b"first", b"second", b""]):
            self.assertEqual(ns.bounded_proc("/proc/self/mountinfo", 20), "firstsecond")
        with mock.patch.object(ns.os, "open", return_value=7), \
                mock.patch.object(ns.os, "close"), \
                mock.patch.object(ns.os, "read", return_value=b"x" * 11):
            with self.assertRaises(ns.Hold):
                ns.bounded_proc("/proc/self/mountinfo", 10)


class AdministrativeOrderingTests(unittest.TestCase):
    def admin(self):
        value = ns.Admin.__new__(ns.Admin)
        value.libc = types.SimpleNamespace(unshare=mock.Mock(return_value=0),
                                           mount=mock.Mock(return_value=0))
        value.private = False
        value.sealed = False
        value.namespace = (1, 10)
        return value

    def test_private_propagation_is_established_before_bind(self):
        admin = self.admin()
        events = mock.Mock()
        events.attach_mock(admin.libc.unshare, "unshare")
        events.attach_mock(admin.libc.mount, "mount")
        with mock.patch.object(ns, "verify_private_mounts", return_value=[]), \
                mock.patch.object(ns.os, "stat", side_effect=[types.SimpleNamespace(st_dev=1, st_ino=10),
                                                             types.SimpleNamespace(st_dev=1, st_ino=11)]):
            admin.private_namespace()
        self.assertEqual(events.mock_calls, [mock.call.unshare(ns.Admin.CLONE_NEWNS),
                         mock.call.mount(None, b"/", None, ns.Admin.MS_REC | ns.Admin.MS_PRIVATE, None)])
        self.assertTrue(admin.private)
        source = mock.Mock()
        with self.assertRaises(ns.Hold):
            self.admin().bind(source, "/usr/lib/libc.so.6")
        source.check.assert_not_called()
        admin.sealed = True
        with self.assertRaises(ns.Hold):
            admin.bind(source, "/usr/lib/libc.so.6")

    def test_bind_has_separate_readonly_remount_and_actual_inode_check(self):
        admin = self.admin()
        admin.private = True
        target = "/usr/lib/libc.so.6"
        original = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0)
        bound = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o444, st_uid=0, st_dev=11, st_ino=22)
        source = types.SimpleNamespace(fd=7, before=(11, 22, bound.st_mode), check=mock.Mock())
        rows = [{"path": "/", "options": {"rw"}}]
        mounted = [{"path": target, "options": {"ro", "nosuid", "nodev"}}]
        with mock.patch.object(ns.os, "stat", side_effect=[original, bound]), \
                mock.patch.object(ns, "namespace_identity", return_value=(1, 10)), \
                mock.patch.object(ns, "verify_private_mounts", side_effect=[rows, mounted]):
            admin.bind(source, target)
        self.assertEqual(admin.libc.mount.call_args_list, [
            mock.call(b"/proc/self/fd/7", target.encode(), None, ns.Admin.MS_BIND, None),
            mock.call(None, target.encode(), None, ns.Admin.MS_BIND | ns.Admin.MS_REMOUNT |
                      ns.Admin.MS_RDONLY | ns.Admin.MS_NOSUID | ns.Admin.MS_NODEV, None)])

    def test_missing_readonly_proof_never_seals_or_executes(self):
        admin = self.admin()
        admin.private = True
        original = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0)
        source = types.SimpleNamespace(fd=7, before=(11, 22, original.st_mode), check=mock.Mock())
        rows = [{"path": "/", "options": {"rw"}}]
        with mock.patch.object(ns.os, "stat", return_value=original), \
                mock.patch.object(ns, "namespace_identity", return_value=(1, 10)), \
                mock.patch.object(ns, "verify_private_mounts", side_effect=[rows, rows]), \
                mock.patch.object(ns.os, "execve") as execute:
            with self.assertRaises(ns.Hold):
                admin.bind(source, "/usr/lib/libc.so.6")
            execute.assert_not_called()
        self.assertFalse(admin.sealed)

    def test_noop_unshare_cannot_make_host_mount_tree_private(self):
        admin = self.admin()
        with mock.patch.object(ns.os, "stat", return_value=types.SimpleNamespace(st_dev=1, st_ino=10)):
            with self.assertRaises(ns.Hold):
                admin.private_namespace()
        admin.libc.mount.assert_not_called()
        self.assertFalse(admin.private)

    def test_failure_at_each_stage_prevents_fresh_exec(self):
        for failure in ("private", "bind", "check", "seal", "drop"):
            with self.subTest(failure=failure):
                events = []
                def stage(name):
                    def invoke(*_arguments):
                        events.append(name)
                        if name == failure:
                            raise ns.Hold("injected-source-unit-failure")
                    return invoke
                caller = types.SimpleNamespace(check_alive=stage("caller"), home="/home/fixture")
                admin = types.SimpleNamespace(private_namespace=stage("private"),
                                               seal=stage("seal"), drop=stage("drop"))
                distribution = types.SimpleNamespace(check_sources=stage("check"), bind_all=stage("bind"))
                with mock.patch.object(ns.os, "execve") as execute:
                    with self.assertRaises(ns.Hold):
                        ns.execute_namespace(distribution, admin, caller, [], "/retained/runtime/node",
                                             ["/retained/runtime/node", "/protected/probe.mjs"], {})
                    execute.assert_not_called()
                self.assertNotIn("drop", events[:events.index(failure)])

    def test_privilege_drop_clears_all_sets_and_checks_failed_syscalls(self):
        caller = types.SimpleNamespace(uid=1001, gid=1002, groups=(1002, 1003), check_alive=mock.Mock())
        rows = [{"path": "/", "options": {"ro"}}]
        status = "".join(key + ":\t0\n" for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"))
        status += "NoNewPrivs:\t1\n"
        for failure in (None, "setresuid", "capset", "ambient"):
            with self.subTest(failure=failure), contextlib.ExitStack() as stack:
                admin = self.admin()
                admin.sealed = True
                admin.mount_snapshot = rows
                admin.cap_last = 2
                admin.libc.prctl = mock.Mock(return_value=0)
                admin.libc.capset = mock.Mock(return_value=-1 if failure == "capset" else 0)
                stack.enter_context(mock.patch.object(ns, "mount_rows", return_value=rows))
                stack.enter_context(mock.patch.object(ns, "namespace_identity", return_value=(1, 10)))
                stack.enter_context(mock.patch.object(ns, "bounded_proc", return_value=
                    status.replace("CapAmb:\t0", "CapAmb:\t1") if failure == "ambient" else status))
                stack.enter_context(mock.patch.object(ns.os, "getresuid", return_value=(1001,) * 3))
                stack.enter_context(mock.patch.object(ns.os, "getresgid", return_value=(1002,) * 3))
                stack.enter_context(mock.patch.object(ns.os, "getgroups", return_value=list(caller.groups)))
                stack.enter_context(mock.patch.object(ns.os, "setgroups"))
                stack.enter_context(mock.patch.object(ns.os, "setresgid"))
                stack.enter_context(mock.patch.object(ns.os, "setresuid", side_effect=
                    OSError("source unit failure") if failure == "setresuid" else None))
                stack.enter_context(mock.patch.object(ns, "process_record", return_value=
                    (777, 1, 1, (1001,) * 4, (1002,) * 4, caller.groups, (10, 20))))
                if failure:
                    with self.assertRaises((ns.Hold, OSError)):
                        admin.drop(caller)
                else:
                    admin.drop(caller)
                    admin.libc.capset.assert_called_once()
                    for capability in range(3):
                        self.assertIn(mock.call(24, capability, 0, 0, 0), admin.libc.prctl.call_args_list)
                    self.assertIn(mock.call(38, 1, 0, 0, 0), admin.libc.prctl.call_args_list)


class CallerAncestryTests(unittest.TestCase):
    def test_only_bounded_actual_root_sudo_ancestors_are_accepted(self):
        sudo_file = types.SimpleNamespace(st_dev=11, st_ino=22,
                                         st_mode=stat.S_IFREG | 0o4755, st_uid=0)
        original = (777, 1, 888, (0,) * 4, (0,) * 4, (0,), (10, 20))
        monitor = (888, 2, 42, (0,) * 4, (0,) * 4, (0,), (10, 20))
        for failure in (None, "cycle", "uid", "namespace", "executable", "depth"):
            with self.subTest(failure=failure), contextlib.ExitStack() as stack:
                records = {777: original, 888: monitor}
                if failure == "cycle":
                    records[888] = (888, 2, 888, *monitor[3:])
                if failure == "uid":
                    records[888] = (888, 2, 42, (1001, 0, 0, 0), *monitor[4:])
                if failure == "namespace":
                    records[888] = (*monitor[:6], (10, 99))
                if failure == "depth":
                    records[777] = (777, 1, 900, *original[3:])
                    for pid in range(900, 909):
                        records[pid] = (pid, pid, pid + 1 if pid < 908 else 42, *monitor[3:])
                stack.enter_context(mock.patch.object(ns.os, "getpid", return_value=777))
                stack.enter_context(mock.patch.object(ns, "process_record", side_effect=records.__getitem__))
                changed_file = types.SimpleNamespace(st_dev=11, st_ino=99)
                stack.enter_context(mock.patch.object(ns.os, "stat", side_effect=lambda path, **_kwargs:
                    changed_file if failure == "executable" and path.startswith("/proc/") else sudo_file))
                stack.enter_context(mock.patch.object(ns.os, "readlink", return_value="/usr/bin/sudo"))
                if failure:
                    with self.assertRaises(ns.Hold):
                        ns.ancestor_chain(42)
                else:
                    self.assertEqual(ns.ancestor_chain(42), (monitor,))


if __name__ == "__main__":
    unittest.main()
