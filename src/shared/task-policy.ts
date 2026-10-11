// These values belong to the frozen v1 runner contract. A different timeout
// policy must receive a new identity rather than changing this policy in place.
export const TASK_ACTIVITY_POLICY = Object.freeze({
  id: 'idle120-offline300-v1',
  idle_timeout_ms: 120_000,
  connection_timeout_ms: 300_000,
  renewal_interval_ms: 60_000,
  request_timeout_ms: 10_000,
  client_check_interval_ms: 1_000,
  server_scan_interval_ms: 30_000,
} as const);
