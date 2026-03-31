import axios from "axios";

export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

// Centralize repo-level axios policy so timeout and future proxy/agent defaults
// are defined in one place. Guard test mocks that don't provide defaults.
if (axios?.defaults) {
  axios.defaults.timeout = DEFAULT_HTTP_TIMEOUT_MS;
}

export default axios;
