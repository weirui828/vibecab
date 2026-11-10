export type ConnectionState = "Starting" | "Connected" | "Engine stopped" | "Engine unreachable";
export type ConnectionEvent = "connected" | "stopped" | "unreachable" | "starting";

export function connectionTransition(_current: ConnectionState, event: ConnectionEvent): ConnectionState {
  switch (event) {
    case "connected":
      return "Connected";
    case "stopped":
      return "Engine stopped";
    case "unreachable":
      return "Engine unreachable";
    case "starting":
      return "Starting";
  }
}
