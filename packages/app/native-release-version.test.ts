import { describe, expect, it } from "vitest";

const {
  FDROID_ABI_VERSION_CODE_SUFFIXES,
  FORK_BUILD_MAX,
  getFdroidVersionCodes,
  getForkAndroidVersionCode,
  getNativeReleaseVersion,
} = require("./native-release-version");

describe("native release version", () => {
  it("reserves the final iOS build slot for a stable release", () => {
    expect(getNativeReleaseVersion("0.2.6")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006999",
    });
  });

  it("gives each beta a unique iOS build slot under the stable app version", () => {
    expect(getNativeReleaseVersion("0.2.6-beta.2")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006002",
    });
  });

  it("rejects beta numbers that consume the stable iOS build slot", () => {
    expect(() => getNativeReleaseVersion("0.2.6-beta.999")).toThrow(
      "iOS beta number must be between 1 and 998",
    );
  });

  it("derives one F-Droid version code per published ABI", () => {
    expect(FDROID_ABI_VERSION_CODE_SUFFIXES).toEqual({
      "armeabi-v7a": 1,
      "arm64-v8a": 2,
      x86: 3,
      x86_64: 4,
    });
    expect(getFdroidVersionCodes("0.5.0")).toEqual([
      { abi: "armeabi-v7a", versionCode: 50001 },
      { abi: "arm64-v8a", versionCode: 50002 },
      { abi: "x86", versionCode: 50003 },
      { abi: "x86_64", versionCode: 50004 },
    ]);
  });
});

describe("native fork release version", () => {
  it("derives base * 100 + fork build, ignoring the beta suffix", () => {
    expect(getForkAndroidVersionCode("0.17.0-beta.1", 1)).toBe(1_700_001);
    expect(getForkAndroidVersionCode("0.17.0", 1)).toBe(1_700_001);
    expect(getForkAndroidVersionCode("0.17.0", FORK_BUILD_MAX)).toBe(1_700_099);
  });

  it("always increases between fork builds of one base and across bases", () => {
    const codes = Array.from({ length: FORK_BUILD_MAX }, (_, i) =>
      getForkAndroidVersionCode("0.17.0-beta.1", i + 1),
    );
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
    expect(new Set(codes).size).toBe(FORK_BUILD_MAX);
    expect(getForkAndroidVersionCode("0.17.1", 1)).toBeGreaterThan(
      getForkAndroidVersionCode("0.17.0", FORK_BUILD_MAX),
    );
  });

  it("stays under the Android cap after the F-Droid single-ABI multiplier", () => {
    const largest = getForkAndroidVersionCode("1.999.999", FORK_BUILD_MAX);
    expect(largest * 10 + 9).toBeLessThanOrEqual(2_100_000_000);
    expect(() => getForkAndroidVersionCode("2.999.999", FORK_BUILD_MAX)).toThrow("out of range");
  });

  it.each([0, 100, 1.5, Number.NaN, "3", undefined])("rejects fork build %s", (forkBuild) => {
    expect(() => getForkAndroidVersionCode("0.17.0", forkBuild)).toThrow(
      "Fork build must be an integer between 1 and 99",
    );
  });
});
