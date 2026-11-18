import { execFile, type ChildProcess } from "node:child_process";
import { builtinExecCallback, collectBuiltinExecFile } from "./builtin-exec-collector.js";
import { promisify } from "node:util";
import { acquirePluginHelper, type PluginHelperOperation } from "./activity.js";

function describeExecFile(args: readonly unknown[]): PluginHelperOperation {
  const file = args[0];
  if (typeof file !== "string") throw new TypeError("Builtin execFile requires a string file");
  const argv = Array.isArray(args[1]) ? args[1] : [];
  if (!argv.every((value) => typeof value === "string"))
    throw new TypeError("Builtin execFile requires string arguments");
  const value = Array.isArray(args[1]) ? args[2] : args[1];
  const options = value && typeof value === "object" ? Object.assign({}, value) : {};
  return { kind: "execFile", command: file, args: argv, options };
}

// Binding preserves Node's overload type without changing its global function or
// nonconfigurable promisify symbol. The proxy owns its separate scoped custom path.
const nativeExecFile = execFile.bind(undefined);
const promisifiedExecFile = (...args: unknown[]) => {
  let child: ChildProcess | undefined;
  const promise = new Promise<{ stdout: unknown; stderr: unknown }>((resolve, reject) => {
    child = Reflect.apply(execQualifiedBuiltinFile, undefined, [
      ...args,
      (error: Error | null, stdout: unknown, stderr: unknown) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
        } else resolve({ stdout, stderr });
      },
    ]);
  });
  Object.defineProperty(promise, "child", {
    value: child,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return promise;
};

/** Fixed builtin evaluator facade only; public directory plugin bindings stay unchanged. */
export const execQualifiedBuiltinFile = new Proxy(nativeExecFile, {
  apply(target, thisArgument, args: unknown[]): ChildProcess {
    const operation = describeExecFile(args);
    const helper = acquirePluginHelper(operation);
    let child: ChildProcess | undefined;
    try {
      const spawned: ChildProcess = helper.builtinExecFile
        ? collectBuiltinExecFile(helper.builtinExecFile, operation, builtinExecCallback(args))
        : Reflect.apply(target, thisArgument, args);
      child = spawned;
      spawned.once("close", helper.release);
      spawned.once("error", helper.failed);
      helper.bind(spawned);
      return spawned;
    } catch (error) {
      helper.failed(error);
      if (!child) helper.release();
      throw error;
    }
  },
  get(target, key, receiver) {
    if (key === promisify.custom) return promisifiedExecFile;
    return Reflect.get(target, key, receiver);
  },
});
