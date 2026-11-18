#!/usr/bin/env python3
"""Disposable Linux CI bootstrap, never a daemon permission/install service.

The administrator is deliberately replaced by a fresh retained Node after the
mount set is sealed. Existing processes cannot acquire execution provenance by
entering this namespace. No setup subprocess runs against partially bound libs.
"""

import argparse
import ctypes
import errno
import grp
import hashlib
import json
import os
import pathlib
import pwd
import re
import select
import stat
import struct
import sys
from dataclasses import dataclass


class Hold(Exception):
    """Bounded, non-secret refusal; underlying exceptions never reach stderr."""


def require(condition, reason):
    if not condition:
        raise Hold(reason)


def integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def text(value, maximum=4096):
    if not isinstance(value, str) or "\x00" in value:
        return False
    try:
        return len(value.encode("utf-8")) <= maximum
    except UnicodeError:
        return False


def exact(value, keys, optional=()):
    require(type(value) is dict, "object-required")
    require(set(keys) <= value.keys() <= set(keys) | set(optional), "unknown-or-missing-field")
    return value


def absolute(value):
    require(text(value) and value.startswith("/") and not value.startswith("//") and value != "/", "invalid-absolute-path")
    require(str(pathlib.PurePosixPath(value)) == value, "noncanonical-path")
    require(".." not in pathlib.PurePosixPath(value).parts, "parent-path")
    return value


def relative(value):
    require(text(value) and value and not value.startswith("/"), "invalid-relative-path")
    require(str(pathlib.PurePosixPath(value)) == value, "noncanonical-member")
    require(".." not in pathlib.PurePosixPath(value).parts, "parent-member")
    return value


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_nlink, info.st_mtime_ns, info.st_ctime_ns)


def protected_ancestors(path):
    current = pathlib.Path(path).parent
    observed = []
    while True:
        info = os.lstat(current)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
                not info.st_mode & 0o022, "unprotected-ancestor")
        observed.append((str(current), identity(info)))
        if current == current.parent:
            return tuple(observed)
        current = current.parent


@dataclass
class CheckedFile:
    path: str
    fd: int
    before: tuple
    data: bytes
    ancestors: tuple

    def check(self):
        require(protected_ancestors(self.path) == self.ancestors, "file-ancestor-changed")
        require(identity(os.fstat(self.fd)) == self.before and
                identity(os.lstat(self.path)) == self.before, "file-changed")

    def close(self):
        os.close(self.fd)


def checked_file(path, limit, expected=None, immutable=True):
    absolute(path)
    ancestors = protected_ancestors(path)
    before = os.lstat(path)
    require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and
            before.st_nlink == 1 and not before.st_mode & (0o222 if immutable else 0o022) and
            0 <= before.st_size <= limit, "unprotected-file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        require(identity(os.fstat(fd)) == identity(before), "file-open-race")
        chunks = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(fd, min(remaining, 1024 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        require(len(data) == before.st_size and len(data) <= limit, "file-size-changed")
        result = CheckedFile(path, fd, identity(before), data, ancestors)
        result.check()
        if expected is not None:
            require(before.st_size == expected["size"] and
                    stat.S_IMODE(before.st_mode) == expected["mode"] and
                    hashlib.sha256(data).hexdigest() == expected["sha256"], "file-identity-mismatch")
        return result
    except BaseException:
        os.close(fd)
        raise


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate-json-key")
        result[key] = value
    return result


def decode_json(data):
    def invalid_constant(_value):
        raise Hold("nonfinite-json")
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=unique_object,
                          parse_constant=invalid_constant)
    except (UnicodeError, ValueError, RecursionError) as error:
        raise Hold("invalid-json") from error


def bounded_proc(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        chunks = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(fd, min(remaining, 65536))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        require(len(data) <= limit, "oversized-proc-record")
        return data.decode("ascii")
    finally:
        os.close(fd)


def process_record(pid):
    base = f"/proc/{pid}"
    raw = bounded_proc(base + "/stat", 16384)
    closing = raw.rfind(")")
    require(closing > 0 and raw.split(" ", 1)[0] == str(pid), "invalid-proc-stat")
    fields = raw[closing + 2:].split()
    require(len(fields) >= 20 and fields[0] not in ("Z", "X", "x"), "exited-caller")
    values = {}
    for line in bounded_proc(base + "/status", 262144).splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            require(key not in values, "duplicate-proc-field")
            values[key] = value.strip()
    def numbers(key):
        raw_numbers = values.get(key, "").split()
        require(raw_numbers and all(item.isdecimal() for item in raw_numbers), "invalid-proc-identity")
        return tuple(int(item) for item in raw_numbers)
    require(numbers("Pid") == (pid,) and numbers("Tgid") == (pid,), "not-process-leader")
    parent = int(fields[1])
    require(numbers("PPid") == (parent,), "proc-parent-race")
    uids, gids = numbers("Uid"), numbers("Gid")
    require(len(uids) == len(gids) == 4, "invalid-proc-credentials")
    groups = tuple(int(value) for value in values.get("Groups", "").split())
    require(len(groups) <= 256 and len(groups) == len(set(groups)) and
            all(integer(group, 0, 2**32 - 2) for group in groups), "invalid-proc-groups")
    namespaces = tuple(os.stat(base + "/ns/" + kind).st_ino for kind in ("user", "pid"))
    return (pid, int(fields[19]), parent, uids, gids, tuple(sorted(groups)), namespaces)


@dataclass
class Caller:
    record: tuple
    chain: tuple
    pidfd: int
    name: str
    home: str
    passwd: CheckedFile
    home_inode: tuple
    ancestor_fds: tuple = ()

    @property
    def uid(self):
        return self.record[3][0]

    @property
    def gid(self):
        return self.record[4][0]

    @property
    def groups(self):
        return self.record[5]

    def check_alive(self):
        ready, _, _ = select.select([self.pidfd, *self.ancestor_fds], [], [], 0)
        require(not ready and process_record(self.record[0]) == self.record, "caller-changed")
        require(ancestor_chain(self.record[0]) == self.chain, "caller-ancestry-changed")
        # No NSS operation after binds: its backend could load another administrative DSO.
        self.passwd.check()
        require(str(pathlib.Path(self.home).resolve(strict=True)) == self.home and
                (os.stat(self.home).st_dev, os.stat(self.home).st_ino) == self.home_inode,
                "caller-home-changed")


def ancestor_chain(caller_pid):
    own = process_record(os.getpid())
    current = own[2]
    chain = []
    sudo = os.stat("/usr/bin/sudo", follow_symlinks=False)
    require(stat.S_ISREG(sudo.st_mode) and sudo.st_uid == 0 and
            not sudo.st_mode & 0o022, "unprotected-sudo")
    while current != caller_pid:
        require(current > 1 and len(chain) < 8 and
                current not in (row[0] for row in chain), "invalid-caller-ancestry")
        row = process_record(current)
        require(row[3] == (0, 0, 0, 0) and row[4] == (0, 0, 0, 0) and
                row[6] == own[6], "untrusted-sudo-ancestor")
        executable = os.stat(f"/proc/{current}/exe")
        require((executable.st_dev, executable.st_ino) == (sudo.st_dev, sudo.st_ino) and
                os.readlink(f"/proc/{current}/exe") == "/usr/bin/sudo", "unknown-ancestor-executable")
        chain.append(row)
        current = row[2]
    require(chain, "missing-sudo-monitor")
    return tuple(chain)


def capture_caller(pid):
    require(integer(pid, 2, 2**31 - 1) and hasattr(os, "pidfd_open"), "invalid-caller-pid")
    fd = os.pidfd_open(pid, 0)
    passwd = None
    ancestor_fds = []
    try:
        row = process_record(pid)
        require(row[3][0] != 0 and len(set(row[3])) == len(set(row[4])) == 1 and
                row[4][0] != 0 and row[6] == process_record(os.getpid())[6], "invalid-original-account")
        account = pwd.getpwuid(row[3][0])
        home = absolute(account.pw_dir)
        require(str(pathlib.Path(home).resolve(strict=True)) == home, "noncanonical-home")
        grp.getgrgid(row[4][0])  # Load group/NSS administration before any library bind.
        passwd = checked_file("/etc/passwd", 262144, immutable=False)
        matches = [line.split(":") for line in passwd.data.decode("utf-8").splitlines()
                   if len(line.split(":")) == 7 and line.split(":")[2] == str(row[3][0])]
        require(len(matches) == 1 and matches[0][0] == account.pw_name and
                matches[0][5] == home, "nonlocal-or-ambiguous-caller-account")
        home_stat = os.stat(home)
        require(stat.S_ISDIR(home_stat.st_mode) and home_stat.st_uid == row[3][0], "invalid-home-owner")
        chain = ancestor_chain(pid)
        for ancestor in chain:
            ancestor_fds.append(os.pidfd_open(ancestor[0], 0))
        result = Caller(row, chain, fd, account.pw_name, home, passwd,
                        (home_stat.st_dev, home_stat.st_ino), tuple(ancestor_fds))
        result.check_alive()
        return result
    except BaseException:
        os.close(fd)
        for descriptor in ancestor_fds:
            os.close(descriptor)
        if passwd is not None:
            passwd.close()
        raise


def mount_rows():
    raw = bounded_proc("/proc/self/mountinfo", 4 * 1024 * 1024)
    rows = []
    for line in raw.splitlines():
        left, separator, right = line.partition(" - ")
        fields = left.split()
        require(separator and len(fields) >= 6 and right.split(), "invalid-mountinfo")
        def unescape(value):
            return re.sub(r"\\(040|011|012|134)", lambda match: chr(int(match[1], 8)), value)
        rows.append({"id": int(fields[0]), "path": unescape(fields[4]),
                     "options": set(fields[5].split(",")), "optional": fields[6:],
                     "filesystem": right.split()[0]})
    return rows


def verify_private_mounts():
    rows = mount_rows()
    require(rows and not any(option.startswith(("shared:", "master:", "propagate_from:"))
                             for row in rows for option in row["optional"]), "shared-mount-propagation")
    return rows


def namespace_identity():
    info = os.stat("/proc/self/ns/mnt")
    return (info.st_dev, info.st_ino)


class Admin:
    MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC = 1, 2, 4, 8
    MS_REMOUNT, MS_BIND, MS_REC, MS_PRIVATE = 32, 4096, 16384, 1 << 18
    CLONE_NEWNS = 0x00020000

    def __init__(self):
        require(sys.platform == "linux" and os.getresuid() == (0, 0, 0), "linux-ci-root-required")
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.unshare.argtypes = [ctypes.c_int]
        self.libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p,
                                   ctypes.c_ulong, ctypes.c_void_p]
        self.libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong,
                                   ctypes.c_ulong, ctypes.c_ulong]
        self.libc.capset.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        self.libc.capset.restype = ctypes.c_int
        self.private = False
        self.sealed = False
        self.cap_last = int(bounded_proc("/proc/sys/kernel/cap_last_cap", 32).strip())
        require(0 <= self.cap_last <= 63, "unsupported-capability-layout")
        hashlib.sha256(b"preload").digest()

    def call(self, function, *arguments):
        if function(*arguments) == -1:
            raise Hold("administrative-syscall-failed")

    def private_namespace(self):
        require(not self.private and not self.sealed, "namespace-order")
        before = namespace_identity()
        self.call(self.libc.unshare, self.CLONE_NEWNS)
        after = namespace_identity()
        require(before != after, "namespace-not-created")
        self.namespace = after
        self.call(self.libc.mount, None, b"/", None, self.MS_REC | self.MS_PRIVATE, None)
        verify_private_mounts()
        self.private = True

    def bind(self, source, target):
        require(self.private and not self.sealed, "bind-before-private-or-after-seal")
        require(namespace_identity() == self.namespace, "mount-namespace-changed")
        source.check()
        old = os.stat(target)
        require(stat.S_ISREG(old.st_mode) and old.st_uid == 0 and
                not old.st_mode & 0o022, "unsafe-existing-target")
        rows = verify_private_mounts()
        containing = max((row for row in rows if target == row["path"] or
                          target.startswith(row["path"].rstrip("/") + "/")),
                         key=lambda row: len(row["path"]))
        require("noexec" not in containing["options"], "existing-noexec-target")
        self.call(self.libc.mount, f"/proc/self/fd/{source.fd}".encode(), target.encode(),
                  None, self.MS_BIND, None)
        self.call(self.libc.mount, None, target.encode(), None,
                  self.MS_BIND | self.MS_REMOUNT | self.MS_RDONLY | self.MS_NOSUID | self.MS_NODEV,
                  None)
        mounted = [row for row in verify_private_mounts() if row["path"] == target]
        require(len(mounted) == 1 and {"ro", "nosuid", "nodev"} <= mounted[0]["options"], "readonly-bind-unproved")
        actual = os.stat(target)
        require((actual.st_dev, actual.st_ino) == source.before[:2] and
                stat.S_IMODE(actual.st_mode) == stat.S_IMODE(source.before[2]), "bind-inode-mismatch")
        source.check()

    def seal(self):
        require(self.private and not self.sealed, "seal-order")
        require(namespace_identity() == self.namespace, "mount-namespace-changed")
        rows = verify_private_mounts()
        self.mount_snapshot = rows
        self.sealed = True

    def drop(self, caller):
        require(self.sealed and namespace_identity() == self.namespace and
                mount_rows() == self.mount_snapshot, "unsealed-or-changed-mounts")
        caller.check_alive()
        self.call(self.libc.prctl, 47, 4, 0, 0, 0)  # PR_CAP_AMBIENT_CLEAR_ALL
        self.call(self.libc.prctl, 8, 0, 0, 0, 0)   # PR_SET_KEEPCAPS=0
        for capability in range(self.cap_last + 1):
            self.call(self.libc.prctl, 24, capability, 0, 0, 0)  # PR_CAPBSET_DROP
        self.call(self.libc.prctl, 38, 1, 0, 0, 0)  # PR_SET_NO_NEW_PRIVS
        os.setgroups(list(caller.groups))
        os.setresgid(caller.gid, caller.gid, caller.gid)
        os.setresuid(caller.uid, caller.uid, caller.uid)
        header = (ctypes.c_uint32 * 2)(0x20080522, 0)
        empty_sets = (ctypes.c_uint32 * 6)()
        self.call(self.libc.capset, ctypes.byref(header), ctypes.byref(empty_sets))
        require(os.getresuid() == (caller.uid,) * 3 and os.getresgid() == (caller.gid,) * 3 and
                tuple(sorted(os.getgroups())) == caller.groups, "privilege-drop-failed")
        values = dict(line.split(":", 1) for line in bounded_proc("/proc/self/status", 262144).splitlines()
                      if ":" in line)
        require(all(int(values[key].strip(), 16) == 0 for key in
                    ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")) and
                values["NoNewPrivs"].strip() == "1", "retained-capabilities")
        require(process_record(os.getpid())[3] == (caller.uid,) * 4 and
                process_record(os.getpid())[4] == (caller.gid,) * 4, "filesystem-identity-not-dropped")
        require(namespace_identity() == self.namespace and mount_rows() == self.mount_snapshot,
                "mount-set-changed-during-drop")


def sequence(value, maximum):
    require(type(value) is list and len(value) <= maximum, "invalid-array")
    return value


def sha256(value):
    require(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value), "invalid-sha256")
    return value


def file_row(value, retained=False):
    exact(value, ("path", "mode", "size", "sha256"), ("retainedPath",) if retained else ())
    require(integer(value["mode"], 0, 0o777) and value["mode"] in (0o444, 0o555) and
            integer(value["size"], 0, 512 * 1024 * 1024), "invalid-retained-file")
    sha256(value["sha256"])
    if retained:
        absolute(value["path"])
        require(value.get("retainedPath") == "system-closure/elf/" + value["path"][1:], "invalid-retained-mapping")
        relative(value["retainedPath"])
    else:
        relative(value["path"])
    return value


def nul_string(data, offset, end):
    require(0 <= offset < end <= len(data), "invalid-string-offset")
    closing = data.find(b"\x00", offset, min(end, offset + 4097))
    require(closing >= offset, "unterminated-loader-string")
    try:
        value = data[offset:closing].decode("utf-8")
    except UnicodeError as error:
        raise Hold("invalid-loader-string") from error
    require(text(value), "invalid-loader-string")
    return value


def elf_metadata(data, member):
    require(len(data) >= 64 and data[:7] == b"\x7fELF\x02\x01\x01" and
            data[7] in (0, 3), "unsupported-elf-format")
    kind, machine, version = struct.unpack_from("<HHI", data, 16)
    require(kind in (2, 3) and version == 1 and struct.unpack_from("<I", data, 48)[0] == 0,
            "unsupported-elf-abi")
    offset = struct.unpack_from("<Q", data, 32)[0]
    width, count = struct.unpack_from("<HH", data, 54)
    require(machine in (62, 183) and width == 56 and 0 < count <= 4096 and
            offset + width * count <= len(data), "unsupported-elf-headers")
    segments = [struct.unpack_from("<IIQQQQQQ", data, offset + width * index)
                for index in range(count)]
    require(all(row[2] + row[5] <= len(data) for row in segments), "elf-segment-outside-file")
    interpreters = [row for row in segments if row[0] == 3]
    dynamics = [row for row in segments if row[0] == 2]
    require(len(interpreters) <= 1 and len(dynamics) <= 1, "ambiguous-elf-loader")
    interpreter = None
    if interpreters:
        row = interpreters[0]
        interpreter = absolute(nul_string(data, row[2], row[2] + row[5]))
    values = []
    if dynamics:
        row = dynamics[0]
        require(row[5] % 16 == 0 and row[5] // 16 <= 65536, "invalid-dynamic-table")
        for position in range(row[2], row[2] + row[5], 16):
            tag, value = struct.unpack_from("<qQ", data, position)
            if tag == 0:
                break
            # Audit, dependency-audit, auxiliary and filter objects are outside v1.
            require(tag not in (0x6FFFFEFC, 0x6FFFFEFB, 0x7FFFFFFD, 0x7FFFFFFF), "unsupported-elf-loading")
            values.append((tag, value))
        else:
            raise Hold("unterminated-dynamic-table")
    by_tag = {}
    for tag, value in values:
        by_tag.setdefault(tag, []).append(value)
    names = []
    rpath, runpath, soname = [], [], None
    if values:
        require(len(by_tag.get(5, [])) == len(by_tag.get(10, [])) == 1, "invalid-dynamic-strings")
        address, length = by_tag[5][0], by_tag[10][0]
        containing = [row for row in segments if row[0] == 1 and
                      row[3] <= address and address + length <= row[3] + row[5]]
        require(len(containing) == 1, "ambiguous-dynamic-strings")
        string_start = containing[0][2] + address - containing[0][3]
        require(length <= len(data) - string_start, "invalid-dynamic-string-size")
        def strings(tag):
            return [nul_string(data, string_start + index, string_start + length)
                    for index in by_tag.get(tag, [])]
        names = strings(1)
        require(len(names) <= 128 and all(name for name in names), "invalid-needed-list")
        for tag in (14, 15, 29):
            require(len(by_tag.get(tag, [])) <= 1, "ambiguous-dynamic-search")
        soname = strings(14)[0] if 14 in by_tag else None
        rpath = strings(15)[0].split(":") if 15 in by_tag else []
        runpath = strings(29)[0].split(":") if 29 in by_tag else []
        require(len(rpath) <= 128 and len(runpath) <= 128 and
                all(item and text(item) for item in rpath + runpath), "empty-loader-search")
    return {"member": member, "machine": machine, "interpreter": interpreter,
            "needed": names, "rpath": rpath, "runpath": runpath, "soname": soname}


def cache_entries(data, needed, machine):
    # glibc sysdeps/generic/dl-cache.h: new-cache1.1 header 48, entries 24.
    require(len(data) >= 48 and data[:20] == b"glibc-ld.so.cache1.1", "unsupported-loader-cache")
    count, string_length = struct.unpack_from("<II", data, 20)
    require(data[28] in (0, 2) and count <= 65536 and
            48 + count * 24 + string_length <= len(data), "invalid-loader-cache")
    start, end = 48 + count * 24, 48 + count * 24 + string_length
    result = []
    expected_flags = 0x303 if machine == 62 else 0xA03
    for index in range(count):
        flags, key, value, _os_version, hwcap = struct.unpack_from("<iIIIQ", data, 48 + index * 24)
        require(start <= key < end and start <= value < end, "cache-string-outside-table")
        name = nul_string(data, key, end)
        if name not in needed or flags != expected_flags:
            continue
        path = absolute(nul_string(data, value, end))
        require(hwcap == 0, "relevant-cache-hwcaps")
        result.append({"soname": name, "path": path, "target": os.path.realpath(path),
                       "flags": flags, "hwcap": "0"})
    return sorted(result, key=lambda row: (row["soname"].encode(), row["path"].encode(), row["flags"]))


class Distribution:
    def __init__(self, root, manifest):
        self.root = absolute(root)
        require(str(pathlib.Path(root).resolve(strict=True)) == root, "noncanonical-distribution")
        protected_ancestors(root + "/member")
        exact(manifest, ("schemaVersion", "profile", "builtinPlugins", "builtinArtifacts",
                         "builtinModuleTable", "moduleTableSha256", "distributionBuildId",
                         "files", "runtime", "externalLibraries", "esbuild", "helperInventory",
                         "helperClosureSha256", "entries", "bindingKeys", "systemClosure",
                         "systemClosureSha256"))
        require(integer(manifest["schemaVersion"], 2, 2) and manifest["profile"] == "enclosing-daemon-v2", "unsupported-manifest")
        self.files = {}
        self.opened = {}
        self.layout_snapshot = {}
        self.absent_selection = set()
        for row in sequence(manifest["files"], 16384):
            file_row(row)
            require(row["path"] not in self.files, "duplicate-member")
            self.files[row["path"]] = row
        closure = exact(manifest["systemClosure"], ("schemaVersion", "profile", "loaderResolution"))
        require(integer(closure["schemaVersion"], 1, 1) and closure["profile"] == "linux-retained-system-closure-v1", "unsupported-system-closure")
        encoded = json.dumps(closure, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        require(hashlib.sha256(encoded).hexdigest() == sha256(manifest["systemClosureSha256"]), "system-closure-digest")
        self.external = {}
        total = 0
        external_rows = sequence(manifest["externalLibraries"], 128)
        require(external_rows == sorted(external_rows, key=lambda row: row["path"].encode()), "unsorted-external-objects")
        for row in external_rows:
            file_row(row, retained=True)
            require(row["path"] not in self.external, "duplicate-target")
            expected = {key: row[key] for key in ("mode", "size", "sha256")}
            member = self.files.get(row["retainedPath"])
            require(member == {"path": row["retainedPath"], **expected}, "retained-cross-reference")
            total += row["size"]
            self.external[row["path"]] = row
        require(self.external and total <= 512 * 1024 * 1024, "external-payload-bound")
        require(manifest["runtime"] == self.files.get("runtime/node"), "runtime-cross-reference")
        self.loader = closure["loaderResolution"]
        self.verify_loader()

    def open_member(self, member):
        relative(member)
        require(member in self.files, "undeclared-member")
        if member not in self.opened:
            self.opened[member] = checked_file(self.root + "/" + member, 512 * 1024 * 1024, self.files[member])
        return self.opened[member]

    def verify_loader(self):
        loader = exact(self.loader, ("schemaVersion", "policy", "elf", "interpreters", "aliases",
                                     "searchDirectories", "hwcaps", "cache", "preload"))
        require(integer(loader["schemaVersion"], 1, 1) and loader["policy"] == "glibc-pinned-cache-existing-layout-v1", "unsupported-loader-policy")
        require(exact(loader["hwcaps"], ("policy",)) == {"policy": "no-relevant-hwcaps-v1"}, "unsupported-hwcaps")
        require(exact(loader["preload"], ("path", "state")) ==
                {"path": "/etc/ld.so.preload", "state": "absent"}, "unsupported-preload")
        metadata = []
        for row in sequence(loader["elf"], 512):
            exact(row, ("member", "machine", "interpreter", "needed", "rpath", "runpath", "soname"))
            require(integer(row["machine"], 0, 65535), "invalid-elf-machine")
            actual = elf_metadata(self.open_member(row["member"]).data, row["member"])
            require(actual == row, "elf-metadata-mismatch")
            metadata.append(actual)
        require(metadata and len({row["member"] for row in metadata}) == len(metadata) and
                metadata == sorted(metadata, key=lambda row: row["member"].encode()), "invalid-elf-inventory")
        require(len({row["machine"] for row in metadata}) == 1, "mixed-elf-abi")
        self.machine = metadata[0]["machine"]
        measured = {row["member"] for row in metadata}
        retained_fds = measured | {"system-closure/loader/ld.so.cache", "system-closure/namespace-bootstrap.py"}
        for member in self.files:
            source = self.open_member(member)
            if source.data.startswith(b"\x7fELF"):
                require(len(source.data) >= 20, "truncated-elf-member")
                if struct.unpack_from("<H", source.data, 18)[0] == self.machine:
                    require(member in measured, "undeclared-target-elf")
            if member not in retained_fds:
                source.close()
                del self.opened[member]
        self.needed = {name for row in metadata for name in row["needed"]}
        require(all(text(name) and name and ("/" not in name or name in self.external)
                    for name in self.needed), "unsupported-needed-path")
        require({row["retainedPath"] for row in self.external.values()} <=
                {row["member"] for row in metadata}, "unmeasured-external-elf")
        require(any(row["member"] == "runtime/node" for row in metadata), "unmeasured-node")
        requests = sequence(loader["interpreters"], 512)
        require(requests == sorted(requests, key=lambda row: row["request"].encode()), "unsorted-interpreters")
        by_request = {}
        for row in requests:
            exact(row, ("request", "target"))
            absolute(row["request"])
            require(row["request"] not in by_request and row["target"] in self.external and
                    self.external[row["target"]]["mode"] == 0o555, "invalid-interpreter")
            by_request[row["request"]] = row["target"]
        require(set(by_request) == {row["interpreter"] for row in metadata if row["interpreter"]}, "interpreter-inventory-mismatch")
        self.interpreters = by_request
        self.verify_layout()
        cache = exact(loader["cache"], ("path", "retainedPath", "mode", "size", "sha256", "entries"))
        require(cache["path"] == "/etc/ld.so.cache" and
                cache["retainedPath"] == "system-closure/loader/ld.so.cache" and
                integer(cache["mode"], 0o444, 0o444),
                "invalid-cache-mapping")
        require(integer(cache["size"], 48, 16 * 1024 * 1024), "cache-size-bound")
        sha256(cache["sha256"])
        require(self.files.get(cache["retainedPath"]) ==
                {"path": cache["retainedPath"], **{key: cache[key] for key in ("mode", "size", "sha256")}}, "cache-cross-reference")
        entries = sequence(cache["entries"], 2048)
        for row in entries:
            exact(row, ("soname", "path", "target", "flags", "hwcap"))
            self.check_path_aliases(absolute(row["path"]))
            require(text(row["soname"]) and row["target"] in self.external and row["hwcap"] == "0" and
                    integer(row["flags"], 0, 2**31 - 1), "invalid-cache-entry")
        require(cache_entries(self.open_member(cache["retainedPath"]).data, self.needed, self.machine) == entries,
                "cache-resolution-mismatch")
        self.verify_search(metadata)
        resolved_names = {row["soname"] for row in entries}
        for name in self.needed:
            if "/" in name:
                require(name in self.external, "unretained-needed-path")
            else:
                require(name in resolved_names or any(os.path.lexists(directory + "/" + name)
                        for directory in self.directories), "unresolved-needed-name")
        declared = {row["retainedPath"] for row in self.external.values()} | {
            "system-closure/loader/ld.so.cache", "system-closure/namespace-bootstrap.py"}
        require({name for name in self.files if name.startswith("system-closure/")} == declared,
                "undeclared-system-payload")
        actual_members = set()
        base = self.root + "/system-closure"
        for ancestor, directories, files in os.walk(base, followlinks=False):
            protected_ancestors(ancestor + "/member")
            for name in directories:
                require(not os.path.islink(ancestor + "/" + name), "linked-system-directory")
            for name in files:
                path = ancestor + "/" + name
                require(stat.S_ISREG(os.lstat(path).st_mode), "nonregular-system-payload")
                actual_members.add(os.path.relpath(path, self.root))
                require(len(actual_members) <= 130, "system-payload-bound")
        require(actual_members == declared, "system-inventory-mismatch")

    def verify_layout(self):
        require(not os.path.lexists("/etc/ld.so.preload"), "existing-preload")
        directories = sequence(self.loader["searchDirectories"], 64)
        expected_order = sorted(directories, key=lambda row: (row["kind"], row["path"].encode()))
        require(directories == expected_order, "unsorted-search-directories")
        self.directories = []
        for row in directories:
            exact(row, ("kind", "path"))
            require(row["kind"] in ("system", "retained"), "invalid-search-kind")
            path = absolute(row["path"]) if row["kind"] == "system" else self.root + "/" + relative(row["path"])
            require(os.path.isdir(path) and path not in self.directories, "missing-or-duplicate-search-directory")
            self.directories.append(path)
        aliases = sequence(self.loader["aliases"], 512)
        require(aliases == sorted(aliases, key=lambda row: row["path"].encode()), "unsorted-aliases")
        self.aliases = {}
        for row in aliases:
            exact(row, ("path", "target", "linkText"))
            absolute(row["path"])
            absolute(row["target"])
            require(text(row["linkText"]) and row["path"] not in self.aliases, "invalid-alias")
            self.aliases[row["path"]] = row
        endpoints = set(self.external) | set(self.directories) | set(self.interpreters)
        for path, row in self.aliases.items():
            visited = {path}
            target = row["target"]
            while target in self.aliases:
                require(target not in visited, "alias-cycle")
                visited.add(target)
                target = self.aliases[target]["target"]
            require(target in endpoints, "undeclared-alias-target")
            info = os.lstat(path)
            require(stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and
                    os.readlink(path) == row["linkText"] and os.path.realpath(path) == row["target"], "alias-layout-mismatch")
        for path in list(self.external) + ["/etc/ld.so.cache"]:
            require(os.path.realpath(path) == path and stat.S_ISREG(os.lstat(path).st_mode), "missing-canonical-target")
            protected_ancestors(path)
        for request, target in self.interpreters.items():
            require(os.path.realpath(request) == target, "interpreter-layout-mismatch")
        for path in list(self.external) + self.directories + list(self.interpreters) + list(self.aliases):
            self.check_path_aliases(path)

    def check_path_aliases(self, path):
        # Walk literal components and each linkText route. realpath/normpath alone
        # would erase a writable bridge or a symlink followed by '..'.
        require(text(path) and path.startswith("/") and not path.startswith("//"), "invalid-loader-route")
        budget = {"steps": 0, "links": 0}
        bind_targets = set(self.external) | {"/etc/ld.so.cache"}
        # realpath is an index hint only. Every associated declaration's parent
        # is traversed below before the row can authorize the actual leaf inode.
        physical_aliases = {}
        for logical, row in self.aliases.items():
            parent = os.path.realpath(os.path.dirname(logical))
            physical = parent.rstrip("/") + "/" + os.path.basename(logical)
            rows = physical_aliases.setdefault(physical, [])
            require(all(previous["linkText"] == row["linkText"] and previous["target"] == row["target"]
                        for previous in rows), "conflicting-physical-alias")
            rows.append(row)

        def inspect(current):
            budget["steps"] += 1
            require(budget["steps"] <= 512, "loader-route-bound")
            try:
                info = os.lstat(current)
            except OSError as error:
                raise Hold("missing-loader-component") from error
            require(info.st_uid == 0 and (stat.S_ISLNK(info.st_mode) or not info.st_mode & 0o022),
                    "unprotected-loader-layout")
            if current not in bind_targets or not stat.S_ISREG(info.st_mode):
                previous = self.layout_snapshot.setdefault(current, identity(info))
                require(previous == identity(info), "loader-ancestor-or-alias-changed")
            return info

        def walk(raw, active):
            require(text(raw) and raw.startswith("/"), "invalid-link-route")
            resolved = []
            saw_link = False
            inspect("/")
            parts = raw.split("/")[1:]
            for index, part in enumerate(parts):
                if part in ("", "."):
                    continue
                if part == "..":
                    require(not saw_link, "symlink-parent-traversal-unsupported")
                    if resolved:
                        resolved.pop()
                    continue
                current = "/" + "/".join([*resolved, part])
                info = inspect(current)
                if stat.S_ISLNK(info.st_mode):
                    budget["links"] += 1
                    require(budget["links"] <= 40 and current not in active, "loader-link-cycle-or-bound")
                    rows = physical_aliases.get(current)
                    require(rows is not None, "undeclared-path-alias")
                    for declaration in rows:
                        parent = walk(os.path.dirname(declaration["path"]), {*active, current})
                        require(parent == os.path.dirname(current), "alias-parent-mismatch")
                        require(identity(inspect(declaration["path"])) == identity(info), "alias-inode-mismatch")
                    row = rows[0]
                    require(os.readlink(current) == row["linkText"], "undeclared-path-alias")
                    link = row["linkText"]
                    require(text(link) and link, "invalid-link-text")
                    # current's containing directory is already physically resolved.
                    target_raw = link if link.startswith("/") else os.path.dirname(current) + "/" + link
                    target = walk(target_raw, {*active, current})
                    require(target == row["target"], "alias-target-mismatch")
                    resolved = target.split("/")[1:]
                    info = inspect(target)
                    saw_link = True
                else:
                    resolved.append(part)
                if index < len(parts) - 1:
                    require(stat.S_ISDIR(info.st_mode), "nondirectory-loader-component")
            return "/" + "/".join(resolved)

        return walk(path, set())

    def verify_search(self, metadata):
        declared_directories = {self.check_path_aliases(directory) for directory in self.directories}
        for row in metadata:
            runtime_path = next((path for path, external in self.external.items()
                                 if external["retainedPath"] == row["member"]), self.root + "/" + row["member"])
            for value in row["rpath"] + row["runpath"]:
                expanded = re.sub(r"\$\{ORIGIN\}|\$ORIGIN(?=/|$)",
                                  lambda _match: os.path.dirname(runtime_path), value)
                require("$" not in expanded and expanded.startswith("/"), "undeclared-elf-search")
                # Inspect BEFORE any normalization; the kernel follows symlinks before '..'.
                require(self.check_path_aliases(expanded) in declared_directories, "undeclared-elf-search")

        visited_entries = 0
        def selection_tree(path, depth, active):
            nonlocal visited_entries
            require(depth <= 8, "selection-tree-depth")
            canonical = self.check_path_aliases(path)
            require(canonical in declared_directories and canonical not in active,
                    "undeclared-or-cyclic-selection-directory")
            require(stat.S_ISDIR(os.lstat(canonical).st_mode), "invalid-selection-directory")
            names = []
            with os.scandir(path) as entries:
                for entry in entries:
                    visited_entries += 1
                    require(visited_entries <= 4096 and text(entry.name) and "/" not in entry.name,
                            "selection-tree-bound")
                    names.append(entry.name)
            for name in sorted(names, key=lambda value: value.encode("utf-8")):
                require(name not in self.needed, "relevant-hwcaps-candidate")
                child = path + "/" + name
                # Empty ordinary directories are selection authority too.
                target = self.check_path_aliases(child)
                if stat.S_ISDIR(os.lstat(target).st_mode):
                    selection_tree(child, depth + 1, {*active, canonical})

        for directory in self.directories:
            for name in self.needed:
                if "/" in name:
                    continue
                candidate = directory + "/" + name
                if os.path.lexists(candidate):
                    require(self.check_path_aliases(candidate) in self.external, "unretained-search-candidate")
                else:
                    self.absent_selection.add(candidate)
            for variant in ("glibc-hwcaps", "tls"):
                base = directory + "/" + variant
                if os.path.lexists(base):
                    selection_tree(base, 0, set())
                else:
                    self.absent_selection.add(base)

    def check_layout(self):
        for path, expected in self.layout_snapshot.items():
            require(identity(os.lstat(path)) == expected, "loader-route-changed-before-exec")
        require(all(not os.path.lexists(path) for path in self.absent_selection), "loader-selection-appeared")

    def check_sources(self):
        for source in self.opened.values():
            source.check()

    def bind_all(self, admin):
        self.verify_layout()
        self.check_sources()
        for target, row in self.external.items():
            admin.bind(self.open_member(row["retainedPath"]), target)
        cache = self.loader["cache"]
        admin.bind(self.open_member(cache["retainedPath"]), cache["path"])
        self.verify_layout()
        self.verify_search(self.loader["elf"])
        self.check_sources()

    def close(self):
        for source in self.opened.values():
            source.close()


ENVIRONMENT = {"PATH", "PASEO_HOME", "GITHUB_ACTIONS", "CI", "LANG", "LC_ALL",
               "QUALIFIED_DAEMON_ROOT"}


def measured_script(row):
    exact(row, ("path", "sha256", "size"))
    absolute(row["path"])
    sha256(row["sha256"])
    require(integer(row["size"], 1, 16 * 1024 * 1024), "script-size-bound")
    source = checked_file(row["path"], 16 * 1024 * 1024, immutable=False)
    try:
        require(len(source.data) == row["size"] and
                hashlib.sha256(source.data).hexdigest() == row["sha256"], "script-identity-mismatch")
        return source
    except BaseException:
        source.close()
        raise


def launch_recipe(value, root, manifest_digest, caller):
    exact(value, ("schemaVersion", "profile", "distributionRoot", "manifestSha256", "bootstrap",
                  "harness", "arguments", "environment"), ("caller",))
    require(integer(value["schemaVersion"], 1, 1) and value["profile"] == "linux-ci-qualified-system-namespace-v1" and
            value["distributionRoot"] == root and value["manifestSha256"] == manifest_digest,
            "launch-recipe-mismatch")
    arguments = sequence(value["arguments"], 30)
    require(all(text(item) for item in arguments) and
            sum(len(item.encode()) for item in arguments) <= 64 * 1024, "argument-bound")
    environment = value["environment"]
    require(type(environment) is dict and len(environment) <= 32 and
            set(environment) <= ENVIRONMENT and
            all(text(item) for item in environment.values()) and
            sum(len(key.encode()) + len(item.encode()) for key, item in environment.items()) <= 64 * 1024,
            "environment-bound-or-loader-override")
    if "QUALIFIED_DAEMON_ROOT" in environment:
        require(environment["QUALIFIED_DAEMON_ROOT"] == root, "root-environment-override")
    if "caller" in value:
        expected = exact(value["caller"], ("uid", "gid", "groups", "home"))
        require(integer(expected["uid"], 1, 2**32 - 2) and integer(expected["gid"], 1, 2**32 - 2), "invalid-caller-assertion")
        groups = sequence(expected["groups"], 256)
        require(all(integer(group, 0, 2**32 - 2) for group in groups) and
                len(groups) == len(set(groups)) and expected["uid"] == caller.uid and
                expected["gid"] == caller.gid and tuple(sorted(groups)) == caller.groups and
                expected["home"] == caller.home, "caller-assertion-mismatch")
    # Prefix is fixed: no Node options, eval, custom loader or arbitrary root command.
    bootstrap = exact(value["bootstrap"], ("path", "sha256", "size"))
    harness = exact(value["harness"], ("path", "sha256", "size"))
    require(bootstrap.get("path") == root + "/system-closure/namespace-bootstrap.py" and
            str(pathlib.Path(__file__).resolve(strict=True)) == bootstrap["path"], "wrong-packaged-bootstrap")
    require(absolute(harness.get("path")) != root and
            not harness["path"].startswith(root + "/"), "candidate-controlled-harness")
    return {**environment, "HOME": caller.home, "USER": caller.name, "LOGNAME": caller.name}


def verify_existing_namespace(root: str, expected_manifest_sha256: str) -> None:
    """Read-only current-namespace recheck; no execution/owner qualification grant.

    The caller authenticates the sealed bytes before importing this fixed member.
    All exceptions are refusal. No Admin, privilege, mount or exec effects occur.
    """
    root = absolute(root)
    digest = sha256(expected_manifest_sha256)
    require(os.path.abspath(__file__) == root + "/system-closure/namespace-bootstrap.py",
            "unexpected-verifier-member")
    checks = []
    distribution = None
    try:
        manifest = checked_file(root + ".manifest.json", 4 * 1024 * 1024, immutable=False)
        checks.append(manifest)
        require(hashlib.sha256(manifest.data).hexdigest() == digest, "unapproved-manifest")
        namespace = namespace_identity()
        mounts = verify_private_mounts()
        # Keep the partially initialized object's descriptors reachable on refusal.
        distribution = Distribution.__new__(Distribution)
        distribution.__init__(root, decode_json(manifest.data))
        bootstrap = distribution.open_member("system-closure/namespace-bootstrap.py")
        require(stat.S_IMODE(bootstrap.before[2]) == 0o444, "unexpected-verifier-mode")
        distribution.absent_selection.add("/etc/ld.so.preload")
        targets = [(target, row["retainedPath"], row) for target, row in distribution.external.items()]
        cache = distribution.loader["cache"]
        targets.append((cache["path"], cache["retainedPath"], cache))
        for target, member, row in targets:
            source = distribution.open_member(member)
            mounted = [mount for mount in mounts if mount["path"] == target]
            require(len(mounted) == 1 and {"ro", "nosuid", "nodev"} <= mounted[0]["options"] and
                    "noexec" not in mounted[0]["options"], "readonly-bind-unproved")
            actual = checked_file(target, 512 * 1024 * 1024,
                                  {key: row[key] for key in ("mode", "size", "sha256")})
            checks.append(actual)
            require(actual.before == source.before, "existing-bind-inode-mismatch")
        distribution.verify_layout()
        distribution.verify_search(distribution.loader["elf"])
        for source in checks:
            source.check()
        distribution.check_sources()
        distribution.check_layout()
        require(namespace_identity() == namespace and verify_private_mounts() == mounts,
                "existing-namespace-changed")
    finally:
        close_failed = False
        sources = checks + list(getattr(distribution, "opened", {}).values())
        for source in sources:
            try:
                source.close()
            except OSError:
                close_failed = True
        require(not close_failed, "readonly-descriptor-close-failed")


def execute_namespace(distribution, admin, caller, checks, executable, arguments, environment):
    """Actual syscall seam; injectable source-unit doubles never establish proof."""
    caller.check_alive()
    for source in checks:
        source.check()
    distribution.check_sources()
    admin.private_namespace()
    distribution.bind_all(admin)
    for source in checks:
        source.check()
    distribution.check_sources()
    caller.check_alive()
    admin.seal()
    admin.drop(caller)
    distribution.check_sources()
    distribution.check_layout()
    os.chdir(caller.home)
    os.umask(0o077)
    # Only stdin/stdout/stderr survive, and no namespace/privileged descriptor leaks.
    # /proc is kernel state; no setup utility is run after library replacement.
    for entry in os.listdir("/proc/self/fd"):
        if entry.isdecimal() and int(entry) > 2:
            try:
                os.close(int(entry))
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise
    os.execve(executable, arguments, environment)
    raise Hold("exec-returned")


class StrictParser(argparse.ArgumentParser):
    def error(self, _message):
        raise Hold("invalid-arguments")


def main(arguments=None):
    parser = StrictParser(description=__doc__, add_help=False)
    parser.add_argument("--distribution", required=True)
    parser.add_argument("--expected-manifest", required=True)
    parser.add_argument("--expected-manifest-sha256", required=True)
    parser.add_argument("--launch-recipe", required=True)
    parser.add_argument("--caller-pid", required=True, type=int)
    opened = []
    distribution = None
    caller = None
    try:
        options = parser.parse_args(arguments)
        require(sys.flags.isolated == 1 and os.path.realpath(sys.executable) ==
                os.path.realpath("/usr/bin/python3"), "fixed-isolated-administrator-required")
        admin = Admin()  # Resolve libc/administrative dependencies before all binds.
        root = absolute(options.distribution)
        digest = sha256(options.expected_manifest_sha256)
        expected = checked_file(absolute(options.expected_manifest), 4 * 1024 * 1024, immutable=False)
        actual = checked_file(root + ".manifest.json", 4 * 1024 * 1024, immutable=False)
        recipe_file = checked_file(absolute(options.launch_recipe), 256 * 1024, immutable=False)
        opened.extend((expected, actual, recipe_file))
        require(hashlib.sha256(expected.data).hexdigest() == digest and actual.data == expected.data,
                "unapproved-manifest")
        caller = capture_caller(options.caller_pid)
        recipe = decode_json(recipe_file.data)
        environment = launch_recipe(recipe, root, digest, caller)
        bootstrap = measured_script(recipe["bootstrap"])
        harness = measured_script(recipe["harness"])
        opened.extend((bootstrap, harness))
        distribution = Distribution(root, decode_json(expected.data))
        require(distribution.open_member("system-closure/namespace-bootstrap.py").data == bootstrap.data,
                "bootstrap-manifest-mismatch")
        node = distribution.open_member("runtime/node")
        require(stat.S_IMODE(node.before[2]) == 0o555, "nonexecutable-retained-node")
        require(os.stat(node.path).st_dev == node.before[0] and
                os.stat(node.path).st_ino == node.before[1], "node-inode-changed")
        argv = [node.path, harness.path, *recipe["arguments"]]
        require(len(argv) <= 32 and sum(len(item.encode()) for item in argv) <= 64 * 1024, "argv-bound")
        execute_namespace(distribution, admin, caller, opened, node.path, argv, environment)
    except Exception as error:
        # Only fixed internal refusal names escape; never syscall text/recipes/environment/tracebacks.
        reason = str(error) if isinstance(error, Hold) else "administrative-failure"
        if not re.fullmatch(r"[a-z0-9-]{1,80}", reason):
            reason = "administrative-failure"
        sys.stderr.write(json.dumps({"error": {"code": "QUALIFIED_NAMESPACE_HOLD",
                         "message": "Namespace bootstrap refused", "reason": reason}}) + "\n")
        return 1
    finally:
        if distribution is not None:
            for source in distribution.opened.values():
                try:
                    os.close(source.fd)
                except OSError:
                    pass
        for source in opened:
            try:
                os.close(source.fd)
            except OSError:
                pass
        if caller is not None:
            for descriptor in (caller.pidfd, caller.passwd.fd, *caller.ancestor_fds):
                try:
                    os.close(descriptor)
                except OSError:
                    pass
    return 1


if __name__ == "__main__":
    sys.exit(main())
