import type { Duplex } from "node:stream";

export interface RemoteHostPrivateListener { path: string; close(): Promise<void> }
export type RemoteHostPrivateListenerFactory = (accept: (client: Duplex) => void) => Promise<RemoteHostPrivateListener>;
