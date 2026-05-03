import axios from "axios";
import * as https from "node:https";
import * as http from "node:http";
import type { AxiosInstance } from "axios";

export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

type AxiosInstanceWithGuards = AxiosInstance & {
  isAxiosError: typeof axios.isAxiosError;
};

// Opt-in IPv4-only mode for environments where IPv6 to DingTalk OAPI is
// reachable in DNS but unreachable via routing (e.g. some Aliyun ECS hosts
// where outbound to oapi.dingtalk.com's 240b:4000:f20::* range is blocked).
// In long-lived processes Node's Happy Eyeballs fallback can occasionally
// stall past the 10s axios timeout and surface as `AggregateError ETIMEDOUT`
// with empty err.message. Set OPENCLAW_DINGTALK_FORCE_IPV4=1 to bypass.
const forceIpv4 = process.env.OPENCLAW_DINGTALK_FORCE_IPV4 === "1";
const agentOpts = forceIpv4 ? { family: 4 as const, keepAlive: true } : undefined;
const httpsAgent = agentOpts ? new https.Agent(agentOpts) : undefined;
const httpAgent = agentOpts ? new http.Agent(agentOpts) : undefined;

// Centralize repo-level axios policy without mutating the global axios singleton
// that third-party dependencies may also share.
const httpClient = (
  typeof axios?.create === "function"
    ? axios.create({
        timeout: DEFAULT_HTTP_TIMEOUT_MS,
        ...(httpsAgent ? { httpsAgent } : {}),
        ...(httpAgent ? { httpAgent } : {}),
      })
    : axios
) as AxiosInstanceWithGuards;

httpClient.isAxiosError = axios.isAxiosError;

export default httpClient;
