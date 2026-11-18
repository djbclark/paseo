import * as activity from "@getpaseo/plugin/internal/activity";
import * as shared from "@getpaseo/plugin";
import * as server from "@getpaseo/plugin/server";
import * as provider from "@getpaseo/plugin/server/provider";
import * as acp from "@getpaseo/plugin/server/acp";
import * as usage from "@getpaseo/plugin/server/usage";
import * as client from "@getpaseo/client";
import * as daemonClient from "@getpaseo/client/internal/daemon-client";
import * as protocol from "@getpaseo/protocol/binary-frames/index";
import * as zod from "zod";

/** The sealed bundle's actual evaluated objects; never a package.json reconstruction. */
export const qualifiedBindings: Readonly<Record<string, object>> = Object.freeze({
  "@getpaseo/plugin/internal/activity": activity,
  "@getpaseo/plugin": shared,
  "@getpaseo/plugin/server": server,
  "@getpaseo/plugin/server/provider": provider,
  "@getpaseo/plugin/server/acp": acp,
  "@getpaseo/plugin/server/usage": usage,
  "@getpaseo/client": client,
  "@getpaseo/client/internal/daemon-client": daemonClient,
  "@getpaseo/protocol/binary-frames/index": protocol,
  zod,
});
