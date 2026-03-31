import axios from "axios";
import type { AxiosInstance } from "axios";

export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

type AxiosInstanceWithGuards = AxiosInstance & {
  isAxiosError: typeof axios.isAxiosError;
};

// Centralize repo-level axios policy without mutating the global axios singleton
// that third-party dependencies may also share.
const httpClient = (
  typeof axios?.create === "function"
    ? axios.create({ timeout: DEFAULT_HTTP_TIMEOUT_MS })
    : axios
) as AxiosInstanceWithGuards;

httpClient.isAxiosError = axios.isAxiosError;

export default httpClient;
