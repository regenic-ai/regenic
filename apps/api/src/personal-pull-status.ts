import {
  clearLocalNetwork,
  isTransportFailure,
  watchLocalFetchFailure,
  type LocalNetworkWatch,
  type TcpConnect,
} from "@regenic/domain";

export interface PullStatusView {
  interval_ms: number;
  last_tick_at: string | null;
  last_error: string | null;
  last_error_hint: string | null;
  network: LocalNetworkWatch;
}

export const pullStatus: PullStatusView = {
  interval_ms: 0,
  last_tick_at: null,
  last_error: null,
  last_error_hint: null,
  network: clearLocalNetwork(),
};

export async function applyPullOutcome(
  errors: unknown[],
  options: { env?: NodeJS.ProcessEnv; connect?: TcpConnect } = {},
): Promise<void> {
  if (errors.length === 0) {
    pullStatus.last_error = null;
    pullStatus.last_error_hint = null;
    pullStatus.network = clearLocalNetwork(options.env);
    return;
  }
  const error =
    errors.find((item) => isTransportFailure(item)) ?? errors[errors.length - 1];
  const watch = await watchLocalFetchFailure({
    error,
    env: options.env,
    connect: options.connect,
  });
  pullStatus.last_error =
    error instanceof Error ? error.message : "Connector pull failed";
  pullStatus.last_error_hint = watch.hint;
  pullStatus.network = watch;
}
