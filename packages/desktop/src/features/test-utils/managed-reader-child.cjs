// Isolated subprocess: production modules are transpiled by the owning test.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const [compiled, action, home, target] = process.argv.slice(2);
const original = os.userInfo;
os.userInfo = () => ({ ...original(), homedir: home });
const policy = require(path.join(compiled, "managed-desktop-policy.js"));
const bundle = require(path.join(compiled, "managed-bundle.js"));
if (action === "policy-growth") {
  const fstat = fs.fstatSync;
  // Simulate a size-valid initial observation followed by a growing regular file.
  let first = true;
  fs.fstatSync = (...args) => {
    const stat = fstat(...args);
    if (first) {
      first = false;
      stat.size = 1;
    }
    return stat;
  };
}
if (action === "bundle-swap") {
  const open = fs.openSync;
  fs.openSync = (file, ...args) => {
    if (file === path.join(target, "regular")) {
      fs.unlinkSync(file);
      const made = require("node:child_process").spawnSync("mkfifo", [file], { timeout: 1000 });
      if (made.status !== 0) throw new Error("FIFO fixture creation failed");
    }
    return open(file, ...args);
  };
}
if (action === "archive-growth") {
  const read = fs.readSync;
  let first = true;
  fs.readSync = (...args) => {
    if (first) {
      first = false;
      fs.appendFileSync(target, "growing input");
    }
    return read(...args);
  };
}
try {
  if (action.startsWith("policy")) policy.readManagedDesktopPolicy();
  else if (action.startsWith("bundle")) bundle.bundleSha256(target);
  else bundle.stableFileSha256(target);
  process.stderr.write("reader unexpectedly accepted invalid input");
  process.exitCode = 1;
} catch (error) {
  process.stdout.write(error.message);
}
