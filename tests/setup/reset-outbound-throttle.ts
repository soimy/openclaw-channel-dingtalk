import { afterEach } from "vitest";
import { resetOutboundSendThrottle } from "../../src/shared/outbound-throttle";

// The outbound throttle holds module-level state (the per-conversation reserved
// send slot). With a non-zero default interval a slot reserved in one test would
// otherwise delay the first send of the next test to the same conversation id,
// so reset it after every test.
afterEach(() => {
  resetOutboundSendThrottle();
});
