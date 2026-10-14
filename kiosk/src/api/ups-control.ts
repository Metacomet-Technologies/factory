// factory-ups-control has a separate JSON contract, not factory-api's OpenAPI.
export interface ControlAction {
  action: string;
  label?: string;
  tier: "safe" | "settings" | "power";
  confirm_phrase: string;
  enabled: boolean;
  disabled_reason: string | null;
  refusal_reason?: string | null;
}

export interface ControlSetting {
  value: string;
  allowed_values: string[];
  ranges: [number, number][];
  range_source: string;
}

export interface AuditRow {
  id: number;
  ts_ms: number;
  login: string | null;
  action: string | null;
  value: string | null;
  result: string;
}

export interface PendingPower {
  audit_id: number;
  ts_ms: number;
  action: string;
  result: string;
  expected_return_ms?: number;
}

export interface ControlState {
  login: string;
  actions: ControlAction[];
  settings: Record<string, ControlSetting>;
  pending_power_action: PendingPower | null;
  audit: AuditRow[];
}

export interface Confirmation {
  id: number;
  confirm_phrase: string;
  expires_ms: number;
}

export interface ControlResult {
  audit_id: number;
  tracking_status: string;
  result: string;
  expected_downtime: string | null;
  expected_return_ms?: number;
}
