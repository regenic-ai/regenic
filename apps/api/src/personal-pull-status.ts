export interface PullStatusView {
  interval_ms: number;
  last_tick_at: string | null;
  last_error: string | null;
}

export const pullStatus: PullStatusView = {
  interval_ms: 0,
  last_tick_at: null,
  last_error: null,
};
