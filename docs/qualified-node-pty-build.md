# Qualified copied node-pty build

This build replaces a native addon in a disposable distribution copy. It does
not modify installed packages or qualify a daemon. A source-built output has
its own hash; it is not described as the published prebuild unless bytes match.

The fixed Linux-x64 recipe uses the original node-pty binding.gyp, the official
Node executable and matching headers/configuration, and the selected
node-addon-api exception configuration. The same official archive supplies
node-gyp and its surrounding npm dependencies. CI downloads and verifies the
public inputs before the helper runs. The helper runs offline without npm
lifecycle scripts, a header downloader, or a prebuild fallback.

## Build-only API

`buildQualifiedNodePtyCopy(root, options)` is exported by
`packages/server/scripts/build-qualified-node-pty.mjs`. Options have exactly
these keys:

| Key | Prepared input |
| --- | --- |
| runtime | Exact `root/runtime/node` |
| headersRoot | Verified official Node distribution with `include/node` |
| nodeGypRoot | Its `lib/node_modules/npm/node_modules/node-gyp` directory |
| toolchainRoot | `/usr` on the existing trusted Linux CI baseline |
| stagingRoot | Separate existing directory for this attempt's build evidence |

Paths must be canonical absolute paths without whitespace. Missing tools,
changed inputs, competing native loader candidates, malformed receipts, and
failed commands refuse the build. Staging evidence remains available on
failure. A partially written disposable copy must be discarded; failure never
produces a qualified fallback artifact.

The helper returns `addon` and `record` file identities. The fixed addon path is
`node_modules/node-pty/prebuilds/linux-x64/pty.node`. The record is
`native-provenance/node-pty-source-build.json`, with evidence below
`native-provenance/node-pty-source-build/`. Producer integration is separate:
after copying the selected runtime, invoke the helper before normal ELF/system
closure collection and final hashing. This source unit adds no manifest key,
runtime permission, qualification profile, or producer wiring.

## What the receipt establishes

The strict version-one record includes selected source/header/GYP identities,
measured tool identities and versions, actual wrapper/compiler argv, generated
Make/configuration files, compiler `-MD` dependencies including system headers,
linker map inputs, raw ELF reports, and actual output hashes. GCC save-temps
output is retained when emitted by the actual compilation. The original
prebuild is preserved as compressed data, never used as a success fallback.

Coverage is declared: measured tools and dependency/map inputs on the existing
CI baseline. There is no generic syscall/file-open tracer, hermetic toolchain,
compiler source bootstrap, or old-prebuild reproducibility claim. Tool versions
and hashes are evidence about the selected build, not a new trust authority.
Required unknown inputs fail. The record always states `qualification:false`.

Focused CI tests build the addon, verify receipt/input refusal paths, and load
the output through the original package loader under the same copied Node.
PTY open/resize/data/exit and explicit signal API regressions are ordinary
behavior tests. Signal termination is not natural cleanup or maintenance
quiescence proof. Node/V8 initialization, other JS evaluation, warning output,
external work, and terminal construction cleanup remain separate obligations.
