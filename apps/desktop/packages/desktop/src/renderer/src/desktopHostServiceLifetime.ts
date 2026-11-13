import type { DatabaseStartupState } from "@fcode/shared";

interface ServiceConnection {
  dispose(reason?: Error): void;
}

/** Owns only the renderer connections attached to one window Host generation. */
export class DesktopHostServiceLifetime {
  private readonly connections = new Set<ServiceConnection>();
  private closedReason: Error | undefined;

  constructor(readonly startupId: string) {}

  add(connection: ServiceConnection): void {
    if (this.closedReason) connection.dispose(this.closedReason);
    else this.connections.add(connection);
  }

  remove(connection: ServiceConnection): void {
    this.connections.delete(connection);
  }

  acceptExit(state: DatabaseStartupState): boolean {
    if (
      state.startupId !== this.startupId ||
      state.phase !== "failed" ||
      state.errorCode !== "transport_closed"
    )
      return false;
    if (!this.closedReason) {
      this.closedReason = new Error(
        "The local background service exited. Reload the app to reconnect.",
      );
      this.closedReason.name = "ConnectionClosed";
      for (const connection of this.connections) connection.dispose(this.closedReason);
      this.connections.clear();
    }
    return true;
  }
}
