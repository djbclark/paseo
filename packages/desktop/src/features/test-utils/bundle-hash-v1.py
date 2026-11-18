"""Contract v1 reference encoder used only by cross-language parity tests."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

root = Path(sys.argv[1]).resolve(strict=True)
rows = []
observed = []

def stamp(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns)

def visit(file, relative):
    before = file.lstat()
    mode = stat.S_IMODE(before.st_mode) & 0o777
    if file.is_symlink():
        file.resolve(strict=True).relative_to(root)
        target = os.readlink(file)
        target.encode("utf-8", errors="strict")
        rows.append((relative, ["l", relative, mode, target]))
    elif stat.S_ISDIR(before.st_mode):
        if relative:
            rows.append((relative, ["d", relative, mode]))
        for child in file.iterdir():
            name = child.name
            name.encode("utf-8", errors="strict")
            visit(child, relative + "/" + name if relative else name)
    elif stat.S_ISREG(before.st_mode):
        descriptor = os.open(file, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode) or stamp(opened) != stamp(before):
                raise ValueError("not a stable regular file")
            chunks = []
            total = 0
            while True:
                chunk = os.read(descriptor, min(1024 * 1024, before.st_size - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > before.st_size:
                    raise ValueError("file grew while reading")
                chunks.append(chunk)
            if stamp(os.fstat(descriptor)) != stamp(before):
                raise ValueError("unstable descriptor")
            data = b"".join(chunks)
        finally:
            os.close(descriptor)
        if len(data) != before.st_size:
            raise ValueError("unstable file")
        rows.append((relative, ["f", relative, mode, len(data), hashlib.sha256(data).hexdigest()]))
    else:
        raise ValueError("special entry")
    if stamp(file.lstat()) != stamp(before):
        raise ValueError("unstable entry")
    observed.append((file, before))

visit(root, "")
for file, before in observed:
    if stamp(file.lstat()) != stamp(before):
        raise ValueError("unstable snapshot")
encoded = "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for _, row in sorted(rows))
print(hashlib.sha256(encoded.encode("utf-8", errors="strict")).hexdigest())
