export type DailyDigestCoverageAlertStatus = "open" | "resolved";

export interface DailyDigestCoverageAlert {
  id: string;
  org_id: string;
  local_date: string;
  generation: string;
  event_id: string;
  reason_code: "omitted_high_signal";
  status: DailyDigestCoverageAlertStatus;
  created_at: string;
  resolved_at?: string;
}

export interface DailyDigestCoverageAlertStore {
  putDailyDigestCoverageAlert(alert: DailyDigestCoverageAlert): Promise<DailyDigestCoverageAlert>;
  listDailyDigestCoverageAlerts(input: {
    org_id: string;
    status?: DailyDigestCoverageAlertStatus;
    limit?: number;
  }): Promise<DailyDigestCoverageAlert[]>;
  resolveDailyDigestCoverageAlert(input: {
    org_id: string;
    alert_id: string;
    resolved_at: string;
  }): Promise<DailyDigestCoverageAlert | null>;
}
