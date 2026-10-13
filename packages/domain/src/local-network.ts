export {
  LOCAL_NETWORK_BLOCKED_HINT,
  LOCAL_PROXY_HINT,
  classifyLocalNetwork,
  clearLocalNetwork,
  hostPortFromHttpUrl,
  isTransportFailure,
  probeTcp,
  readProxyEnv,
  targetUrlFromError,
  watchLocalFetchFailure,
} from "@regenic/connector-contract";
export type {
  LocalNetworkKind,
  LocalNetworkWatch,
  TcpConnect,
  TcpProbeResult,
} from "@regenic/connector-contract";
