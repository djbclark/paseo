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


class LoaderTraversalTests(unittest.TestCase):
    """Virtual pathname observations; these never prove a real namespace/loader."""

    def setUp(self):
        self.nodes = {}
        self.links = {}
        for path in ("/", "/declared", "/declared/lib", "/usr", "/usr/lib",
                     "/retained", "/retained/runtime", "/retained/lib", "/other", "/other/inner"):
            self.directory(path)
        self.file("/usr/lib/libx-real.so")
        self.distribution = ns.Distribution.__new__(ns.Distribution)
        self.distribution.root = "/retained"
        self.distribution.external = {"/usr/lib/libx-real.so": {"retainedPath": "system-closure/elf/usr/lib/libx-real.so"}}
        self.distribution.directories = ["/declared/lib", "/retained/lib"]
        self.distribution.aliases = {}
        self.distribution.layout_snapshot = {}
        self.distribution.absent_selection = set()
        self.distribution.needed = {"libx.so"}
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(mock.patch.object(ns.os, "lstat", side_effect=self.inspect))
        stack.enter_context(mock.patch.object(ns.os, "readlink", side_effect=lambda path:
            self.links[self.resolve(path, follow_leaf=False)]))
        stack.enter_context(mock.patch.object(ns.os.path, "realpath", side_effect=self.resolve))
        stack.enter_context(mock.patch.object(ns.os, "scandir", side_effect=lambda path:
            contextlib.nullcontext(iter(types.SimpleNamespace(name=name) for name in self.children(path)))))
        stack.enter_context(mock.patch.object(ns.os.path, "lexists", side_effect=lambda path:
            self.resolve(path, follow_leaf=False) in self.nodes))

    def add(self, path, kind, uid=0, mode=0o755):
        self.nodes[path] = types.SimpleNamespace(st_dev=1, st_ino=len(self.nodes) + 1,
            st_mode=kind | mode, st_uid=uid, st_gid=0, st_size=0, st_nlink=1,
            st_mtime_ns=1, st_ctime_ns=1)

    def directory(self, path, uid=0, mode=0o755):
        self.add(path, stat.S_IFDIR, uid, mode)

    def file(self, path):
        self.add(path, stat.S_IFREG, mode=0o444)

    def link(self, path, link_text, target, declared=True):
        self.add(path, stat.S_IFLNK, mode=0o777)
        self.links[path] = link_text
        if declared:
            self.distribution.aliases[path] = {"path": path, "target": target, "linkText": link_text}

    def resolve(self, path, follow_leaf=True):
        # Virtual kernel-path behavior for source observations only; production
        # always uses the actual filesystem and independently walks every route.
        parts = path.split("/")[1:]
        resolved = []
        links = 0
        while parts:
            part = parts.pop(0)
            if part in ("", "."):
                continue
            if part == "..":
                resolved = resolved[:-1]
                continue
            candidate = "/" + "/".join([*resolved, part])
            if candidate in self.links and (parts or follow_leaf):
                links += 1
                if links > 40:
                    raise OSError("virtual link bound")
                target = self.links[candidate]
                if target.startswith("/"):
                    resolved = []
                parts = target.split("/") + parts
            else:
                resolved.append(part)
        return "/" + "/".join(resolved)

    def inspect(self, path):
        physical = self.resolve(path, follow_leaf=False)
        if physical not in self.nodes:
            raise FileNotFoundError(path)
        return self.nodes[physical]

    def children(self, path):
        prefix = self.resolve(path).rstrip("/") + "/"
        return [candidate[len(prefix):] for candidate in self.nodes
                if candidate.startswith(prefix) and "/" not in candidate[len(prefix):]]

    def test_writable_empty_ordinary_hwcaps_child_refuses(self):
        for variant in ("glibc-hwcaps", "tls"):
            with self.subTest(variant=variant):
                base = "/declared/lib/" + variant
                self.directory(base)
                self.directory(base + "/ordinary", uid=1001)
                self.distribution.directories += [base, base + "/ordinary"]
                with self.assertRaisesRegex(ns.Hold, "unprotected-loader-layout"):
                    self.distribution.verify_search([])
                self.nodes[base + "/ordinary"].st_uid = 0
                self.distribution.layout_snapshot.clear()

    def test_symlinked_hwcaps_base_through_writable_bridge_refuses(self):
        self.directory("/user", uid=1001)
        self.directory("/other/hwcaps")
        self.link("/user/bridge", "/other/hwcaps", "/other/hwcaps", declared=False)
        self.link("/declared/lib/glibc-hwcaps", "/user/bridge", "/other/hwcaps")
        self.distribution.directories.append("/other/hwcaps")
        with self.assertRaisesRegex(ns.Hold, "unprotected-loader-layout"):
            self.distribution.verify_search([])

    def test_declared_alias_link_text_through_writable_bridge_refuses(self):
        self.directory("/user", uid=1001)
        self.link("/user/bridge", "/usr/lib/libx-real.so", "/usr/lib/libx-real.so", declared=False)
        self.link("/declared/lib/alias.so", "/user/bridge", "/usr/lib/libx-real.so")
        with self.assertRaisesRegex(ns.Hold, "unprotected-loader-layout"):
            self.distribution.check_path_aliases("/declared/lib/alias.so")

    def test_unlisted_known_needed_alias_refuses(self):
        self.link("/declared/lib/libx.so", "/usr/lib/libx-real.so", "/usr/lib/libx-real.so", declared=False)
        with self.assertRaisesRegex(ns.Hold, "undeclared-path-alias"):
            self.distribution.verify_search([])

    def test_rpath_symlink_parent_traversal_refuses_before_normalization(self):
        self.link("/declared/link", "/other/inner", "/other/inner")
        row = {"member": "runtime/node", "rpath": ["/declared/link/../lib"], "runpath": []}
        with self.assertRaisesRegex(ns.Hold, "symlink-parent-traversal-unsupported"):
            self.distribution.verify_search([row])

    def test_protected_layout_recursive_aliases_and_plain_origin_parent_work(self):
        self.link("/declared/bridge.so", "/usr/lib/libx-real.so", "/usr/lib/libx-real.so")
        self.link("/declared/lib/libx.so", "../bridge.so", "/usr/lib/libx-real.so")
        self.directory("/declared/lib/glibc-hwcaps")
        self.directory("/declared/lib/glibc-hwcaps/ordinary")
        self.distribution.directories += ["/declared/lib/glibc-hwcaps",
                                         "/declared/lib/glibc-hwcaps/ordinary"]
        row = {"member": "runtime/node", "rpath": [], "runpath": ["$ORIGIN/../lib"]}
        self.distribution.verify_search([row])
        self.assertEqual(self.distribution.check_path_aliases("/declared/lib/libx.so"), "/usr/lib/libx-real.so")
        self.distribution.check_layout()

    def directory_alias_layout(self):
        self.link("/alias-one", "/declared/lib", "/declared/lib")
        self.link("/alias-two", "/alias-one", "/declared/lib")
        self.link("/declared/lib/libx.so", "/usr/lib/libx-real.so", "/usr/lib/libx-real.so", declared=False)
        self.distribution.aliases["/alias-one/libx.so"] = {"path": "/alias-one/libx.so",
            "linkText": "/usr/lib/libx-real.so", "target": "/usr/lib/libx-real.so"}
        self.distribution.directories += ["/alias-one", "/alias-two"]

    def test_logical_leaf_alias_under_multiple_directory_aliases_is_same_stable_inode(self):
        self.directory_alias_layout()
        for path in ("/alias-one/libx.so", "/alias-two/libx.so", "/declared/lib/libx.so"):
            self.assertEqual(self.distribution.check_path_aliases(path), "/usr/lib/libx-real.so")
        self.distribution.verify_search([])
        self.distribution.check_layout()
        self.nodes["/declared/lib/libx.so"].st_ino += 100
        with self.assertRaisesRegex(ns.Hold, "loader-route-changed-before-exec"):
            self.distribution.check_layout()

    def test_logical_leaf_missing_or_changed_declaration_refuses(self):
        self.directory_alias_layout()
        row = self.distribution.aliases.pop("/alias-one/libx.so")
        with self.assertRaisesRegex(ns.Hold, "undeclared-path-alias"):
            self.distribution.check_path_aliases("/alias-two/libx.so")
        for change in ({"linkText": "/wrong/text"}, {"target": "/other/inner"}):
            self.distribution.aliases[row["path"]] = {**row, **change}
            with self.subTest(change=change), self.assertRaises(ns.Hold):
                self.distribution.check_path_aliases("/alias-two/libx.so")

    def test_conflicting_logical_rows_for_one_physical_alias_refuse(self):
        self.directory_alias_layout()
        row = self.distribution.aliases["/alias-one/libx.so"]
        self.distribution.aliases["/alias-two/libx.so"] = {**row,
            "path": "/alias-two/libx.so", "target": "/other/inner"}
        with self.assertRaisesRegex(ns.Hold, "conflicting-physical-alias"):
            self.distribution.check_path_aliases("/alias-one/libx.so")

    def test_logical_parent_through_writable_or_undeclared_bridge_refuses(self):
        self.directory_alias_layout()
        self.directory("/bridge-base", uid=1001)
        self.link("/bridge-base/link", "/declared/lib", "/declared/lib", declared=False)
        self.links["/alias-one"] = "/bridge-base/link"
        self.distribution.aliases["/alias-one"]["linkText"] = "/bridge-base/link"
        for owner in (1001, 0):
            self.nodes["/bridge-base"].st_uid = owner
            self.distribution.layout_snapshot.clear()
            with self.subTest(owner=owner), self.assertRaises(ns.Hold):
                self.distribution.check_path_aliases("/alias-two/libx.so")

    def test_undeclared_empty_protected_selection_child_refuses(self):
        self.directory("/declared/lib/tls")
        self.directory("/declared/lib/tls/ordinary")
        self.distribution.directories.append("/declared/lib/tls")
        with self.assertRaisesRegex(ns.Hold, "undeclared-or-cyclic-selection-directory"):
            self.distribution.verify_search([])

    def test_rechecks_traversed_identity_and_absent_selection_before_exec(self):
        self.distribution.verify_search([])
        self.nodes["/declared/lib"].st_ino += 100
        with self.assertRaisesRegex(ns.Hold, "loader-route-changed-before-exec"):
            self.distribution.check_layout()
        self.nodes["/declared/lib"].st_ino -= 100
        self.file("/declared/lib/libx.so")
        with self.assertRaisesRegex(ns.Hold, "loader-selection-appeared"):
            self.distribution.check_layout()


class ExistingNamespaceReadOnlyTests(unittest.TestCase):
    """Orchestration doubles only, never actual mount/execution qualification."""

    def fixture(self):
        root = "/retained"
        digest = ns.hashlib.sha256(b"{}").hexdigest()
        before = (1, 20, stat.S_IFREG | 0o444, 0, 0, 4, 1, 1, 1)
        def source(data=b"", observed=before):
            return types.SimpleNamespace(data=data, before=observed, check=mock.Mock(), close=mock.Mock())
        manifest = source(b"{}")
        bootstrap = source()
        backing = source()
        cache_backing = source()
        actual = source()
        actual_cache = source()
        row = {"retainedPath": "system-closure/elf/usr/lib/libx.so", "mode": 0o444,
               "size": 4, "sha256": "a" * 64}
        cache = {**row, "path": "/etc/ld.so.cache", "retainedPath": "system-closure/loader/ld.so.cache"}
        state = types.SimpleNamespace(external={"/usr/lib/libx.so": row},
            loader={"cache": cache, "elf": []}, absent_selection=set(),
            opened={"system-closure/namespace-bootstrap.py": bootstrap,
                    row["retainedPath"]: backing, cache["retainedPath"]: cache_backing},
            verify_layout=mock.Mock(), verify_search=mock.Mock(), check_sources=mock.Mock(),
            check_layout=mock.Mock())
        state.open_member = state.opened.__getitem__
        class SourceDistribution:
            def __init__(self, _root, _manifest):
                self.__dict__.update(state.__dict__)
        rows = [{"path": path, "options": {"ro", "nosuid", "nodev"}}
                for path in ("/usr/lib/libx.so", "/etc/ld.so.cache")]
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(mock.patch.object(ns, "__file__", root + "/system-closure/namespace-bootstrap.py"))
        stack.enter_context(mock.patch.object(ns, "Distribution", SourceDistribution))
        checked = stack.enter_context(mock.patch.object(ns, "checked_file", side_effect=[manifest, actual, actual_cache]))
        namespace = stack.enter_context(mock.patch.object(ns, "namespace_identity", return_value=(1, 7)))
        mounts = stack.enter_context(mock.patch.object(ns, "verify_private_mounts", return_value=rows))
        effects = [stack.enter_context(mock.patch.object(ns, "Admin"))]
        for name in ("execve", "setresuid", "setresgid", "setgroups", "chdir", "umask"):
            effects.append(stack.enter_context(mock.patch.object(ns.os, name)))
        return types.SimpleNamespace(root=root, digest=digest, manifest=manifest, bootstrap=bootstrap,
            backing=backing, cache_backing=cache_backing, actual=actual, actual_cache=actual_cache,
            state=state, checked=checked, namespace=namespace, mounts=mounts, effects=effects, rows=rows)

    def test_readonly_orchestration_rechecks_and_closes_without_administrative_effects(self):
        f = self.fixture()
        self.assertIsNone(ns.verify_existing_namespace(f.root, f.digest))
        f.state.verify_layout.assert_called_once_with()
        f.state.verify_search.assert_called_once_with([])
        f.state.check_sources.assert_called_once_with()
        f.state.check_layout.assert_called_once_with()
        self.assertIn("/etc/ld.so.preload", f.state.absent_selection)
        for observed in (f.manifest, f.bootstrap, f.backing, f.cache_backing, f.actual, f.actual_cache):
            observed.close.assert_called_once_with()
        for effect in f.effects:
            effect.assert_not_called()

    def test_manifest_mismatch_refuses_before_namespace_or_payload_observation(self):
        f = self.fixture()
        with self.assertRaisesRegex(ns.Hold, "unapproved-manifest"):
            ns.verify_existing_namespace(f.root, "b" * 64)
        f.namespace.assert_not_called()
        f.mounts.assert_not_called()
        f.manifest.close.assert_called_once_with()
        self.assertEqual(f.checked.call_count, 1)

    def test_same_bytes_different_inode_is_not_a_retained_bind(self):
        f = self.fixture()
        f.actual.before = (1, 999, *f.backing.before[2:])
        with self.assertRaisesRegex(ns.Hold, "existing-bind-inode-mismatch"):
            ns.verify_existing_namespace(f.root, f.digest)
        f.actual.close.assert_called_once_with()

    def test_readwrite_target_mount_refuses(self):
        f = self.fixture()
        f.rows[0]["options"].remove("ro")
        with self.assertRaisesRegex(ns.Hold, "readonly-bind-unproved"):
            ns.verify_existing_namespace(f.root, f.digest)
        self.assertEqual(f.checked.call_count, 1)

    def test_duplicate_target_mount_or_shared_propagation_refuses(self):
        f = self.fixture()
        f.rows.append(f.rows[0])
        with self.assertRaisesRegex(ns.Hold, "readonly-bind-unproved"):
            ns.verify_existing_namespace(f.root, f.digest)

    def test_shared_propagation_refuses_before_distribution_observation(self):
        f = self.fixture()
        f.mounts.side_effect = ns.Hold("shared-mount-propagation")
        with self.assertRaisesRegex(ns.Hold, "shared-mount-propagation"):
            ns.verify_existing_namespace(f.root, f.digest)
        self.assertEqual(f.checked.call_count, 1)

    def test_namespace_or_mount_mutation_at_final_recheck_refuses(self):
        f = self.fixture()
        f.namespace.side_effect = [(1, 7), (1, 8)]
        with self.assertRaisesRegex(ns.Hold, "existing-namespace-changed"):
            ns.verify_existing_namespace(f.root, f.digest)

    def test_mount_table_change_at_final_recheck_refuses(self):
        f = self.fixture()
        f.mounts.side_effect = [f.rows, [*f.rows, {"path": "/new", "options": {"ro"}}]]
        with self.assertRaisesRegex(ns.Hold, "existing-namespace-changed"):
            ns.verify_existing_namespace(f.root, f.digest)

    def test_current_path_absence_or_source_uncertainty_never_returns_success(self):
        f = self.fixture()
        f.state.check_layout.side_effect = ns.Hold("loader-selection-appeared")
        with self.assertRaisesRegex(ns.Hold, "loader-selection-appeared"):
            ns.verify_existing_namespace(f.root, f.digest)
        for effect in f.effects:
            effect.assert_not_called()

    def test_fixed_import_member_and_descriptor_close_failure_refuse(self):
        f = self.fixture()
        with mock.patch.object(ns, "__file__", "/other/namespace-bootstrap.py"):
            with self.assertRaisesRegex(ns.Hold, "unexpected-verifier-member"):
                ns.verify_existing_namespace(f.root, f.digest)
        f.checked.assert_not_called()
        f.actual.close.side_effect = OSError("source unit close failure")
        with self.assertRaisesRegex(ns.Hold, "readonly-descriptor-close-failed"):
            ns.verify_existing_namespace(f.root, f.digest)
        f.cache_backing.close.assert_called_once_with()


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
