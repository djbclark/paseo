"""Fixed CI layout probe. Observations never grant runtime qualification."""
import sys

assert sys.flags.isolated == 1
assert sys.flags.no_site == 1
assert sys.flags.dont_write_bytecode == 1
assert len(sys.argv) == 1

import argparse
import calendar
import contextlib
import ctypes
import dataclasses
import encodings
import fcntl
import importlib
import json
import math
import os
import pathlib
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sysconfig
import tempfile
import time
import typing


def canonical(value):
    return os.path.realpath(value)


def main():
    assert sys.implementation.name == "cpython"
    assert sys.version_info.major == 3
    assert sys.prefix == sys.base_prefix
    assert sys.exec_prefix == sys.base_exec_prefix
    modules = []
    for name, module in sorted(sys.modules.items()):
        spec = getattr(module, "__spec__", None)
        origin = getattr(spec, "origin", None)
        if origin is None:
            continue
        assert isinstance(origin, str)
        if origin not in ("built-in", "frozen"):
            assert os.path.isabs(origin)
            origin = canonical(origin)
        modules.append({"name": name, "origin": origin})
    assert len(modules) <= 512
    maps = set()
    with open("/proc/self/maps", encoding="ascii") as stream:
        for index, line in enumerate(stream):
            assert index < 4096
            assert len(line) <= 8192
            fields = line.rstrip("\n").split(None, 5)
            if len(fields) == 6 and fields[5].startswith("/"):
                assert not fields[5].endswith(" (deleted)")
                maps.add(canonical(fields[5]))
    assert len(maps) <= 256
    record = {
        "schemaVersion": 1,
        "qualification": False,
        "implementation": sys.implementation.name,
        "version": list(sys.version_info[:3]),
        "cacheTag": sys.implementation.cache_tag,
        "abiFlags": getattr(sys, "abiflags", ""),
        "platlibdir": sys.platlibdir,
        "executable": canonical(sys.executable),
        "prefix": canonical(sys.prefix),
        "execPrefix": canonical(sys.exec_prefix),
        "basePrefix": canonical(sys.base_prefix),
        "baseExecPrefix": canonical(sys.base_exec_prefix),
        "path": [canonical(item) for item in sys.path],
        "flags": {"isolated": 1, "noSite": 1, "dontWriteBytecode": 1},
        "stdlib": canonical(sysconfig.get_path("stdlib")),
        "platstdlib": canonical(sysconfig.get_path("platstdlib")),
        "extensionDirectory": canonical(sysconfig.get_config_var("DESTSHARED")),
        "modules": modules,
        "nativeMapFiles": sorted(maps),
        "build": {
            key: str(sysconfig.get_config_var(key))
            for key in ("SOABI", "EXT_SUFFIX", "CONFIG_ARGS", "MULTIARCH", "LDLIBRARY")
        },
    }
    diagnostic = {"kind": "retained-python-sysconfig-source-diagnostic", "qualification": False,
                  "LIBPL": str(sysconfig.get_config_var("LIBPL")),
                  "LIBDIR": str(sysconfig.get_config_var("LIBDIR"))}
    sys.stderr.write(json.dumps(diagnostic, separators=(",", ":")) + "\n")
    raw = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    assert len(raw.encode("ascii")) + 1 <= 65536
    sys.stdout.write(raw + "\n")


if __name__ == "__main__":
    main()
