import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";

type JsonResultReturn = NonNullable<ChannelMessageActionAdapter["handleAction"]> extends (
  ...args: unknown[]
) => Promise<infer TResult>
  ? TResult
  : never;

declare module "openclaw/plugin-sdk/channel-actions" {
  export function jsonResult(payload: unknown): JsonResultReturn;
}
