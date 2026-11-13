import { randomUUID, createHash } from "node:crypto";
import { realpath, lstat, open, link, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join, basename } from "node:path";
import type { WalletRequests } from "../app/requests.js";
import type { ClientHandle } from "../app/sessions.js";
import { requireWallet, WalletError } from "../domain/errors.js";
export class ResponseExporter {
  #destinations = new Map<
    string,
    {
      handle: ClientHandle;
      directory: string;
      name: string;
      dev: number;
      ino: number;
      expires: number;
      requestId?: string;
    }
  >();
  constructor(private readonly requests: WalletRequests) {}
  list(handle: ClientHandle): string[] {
    return [...this.#destinations]
      .filter(([, value]) => value.handle === handle && value.expires > Date.now())
      .map(([ref]) => ref);
  }
  clear(handle: ClientHandle): void {
    for (const [ref, value] of this.#destinations)
      if (value.handle === handle) this.#destinations.delete(ref);
  }
  discard(handle: ClientHandle, ref: string): void {
    if (this.#destinations.get(ref)?.handle === handle) this.#destinations.delete(ref);
  }
  async approve(
    handle: ClientHandle,
    directory: string,
    name: string,
    requestId?: string,
  ): Promise<string> {
    if (requestId !== undefined) this.requests.store.owned(handle, requestId);
    for (const [ref, value] of this.#destinations)
      if (value.expires <= Date.now()) this.#destinations.delete(ref);
    requireWallet(
      this.#destinations.size < 128 &&
        name === basename(name) &&
        name !== "." &&
        name !== ".." &&
        name.length <= 200 &&
        !name.includes("\0"),
      "DESTINATION_INVALID",
      "The approved output filename is invalid.",
    );
    const canonical = await realpath(directory),
      stat = await lstat(directory);
    requireWallet(
      stat.isDirectory() && !stat.isSymbolicLink() && directory === canonical,
      "DESTINATION_INVALID",
      "A canonical output directory is required.",
    );
    const ref = "wallet-destination:" + randomUUID();
    this.#destinations.set(ref, {
      handle,
      directory,
      name,
      dev: stat.dev,
      ino: stat.ino,
      expires: Date.now() + 300000,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return ref;
  }
  async export(handle: ClientHandle, requestId: string, ref: string, signal?: AbortSignal) {
    const destination = this.#destinations.get(ref);
    requireWallet(
      destination &&
        destination.handle === handle &&
        destination.expires > Date.now() &&
        (destination.requestId === undefined || destination.requestId === requestId),
      "DESTINATION_NOT_FOUND",
      "The approved output location is unavailable.",
    );
    const assertCurrent = () => {
      signal?.throwIfAborted();
      this.requests.store.owned(handle, requestId);
      requireWallet(
        this.#destinations.get(ref) === destination && destination.expires > Date.now(),
        "DESTINATION_NOT_FOUND",
        "The approved output location is unavailable.",
      );
    };
    assertCurrent();
    const data = await this.requests.readResponse(handle, requestId);
    try {
      const info = await lstat(destination.directory);
      assertCurrent();
      requireWallet(
        info.isDirectory() &&
          !info.isSymbolicLink() &&
          info.dev === destination.dev &&
          info.ino === destination.ino &&
          (await realpath(destination.directory)) === destination.directory,
        "DESTINATION_INVALID",
        "The output directory changed after approval.",
      );
      const temporary = join(destination.directory, ".wallet-response-" + randomUUID()),
        target = join(destination.directory, destination.name);
      assertCurrent();
      const file = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        assertCurrent();
        await file.writeFile(data);
        assertCurrent();
        await file.sync();
        await file.close();
        this.requests.store.owned(handle, requestId);
        const check = await lstat(destination.directory);
        requireWallet(
          check.dev === destination.dev && check.ino === destination.ino && !check.isSymbolicLink(),
          "DESTINATION_INVALID",
          "The output directory identity changed.",
        );
        assertCurrent();
        await link(temporary, target);
        const dir = await open(destination.directory, constants.O_RDONLY);
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
        this.#destinations.delete(ref);
        return {
          requestId,
          bodyRef: `wallet-response://requests/${requestId}/body`,
          byteLength: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
          destinationRef: ref,
          truncated: false,
          sensitiveRedacted: this.requests.get(handle, requestId).sensitiveRedacted ?? false,
        };
      } catch {
        throw new WalletError(
          "RESPONSE_EXPORT_FAILED",
          "The response could not be atomically exported; existing files are never overwritten.",
        );
      } finally {
        await file.close().catch(() => {});
        await unlink(temporary).catch(() => {});
      }
    } finally {
      data.fill(0);
    }
  }
}
