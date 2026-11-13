type ConversationCommand = { envelope?: { type?: unknown } };
type ConversationAck = { status?: unknown; result?: { type?: unknown; sessionId?: unknown } };

/**
 * Selection side chats are created by a conversation command, not as tasks, so the task-service
 * route announcements never cover them. The Host announces a side session only after its own
 * Agent accepted the creation; renderer-supplied ids are never announced.
 */
export function withSideSessionRoutes<T extends object>(service: T, announce: (sessionId: string) => void): T {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "sendConversationCommandV4" || typeof value !== "function") return value;
      return async (params: ConversationCommand, ...rest: unknown[]) => {
        const ack = (await value.call(target, params, ...rest)) as ConversationAck;
        const sessionId = ack?.result?.sessionId;
        if (params?.envelope?.type === "createSelectionSideSession" &&
            (ack?.status === "accepted" || ack?.status === "duplicate") &&
            ack.result?.type === "createSelectionSideSession" &&
            typeof sessionId === "string" && sessionId.length > 0) {
          try { announce(sessionId); } catch { /* The command result does not depend on the announcement. */ }
        }
        return ack;
      };
    },
  });
}
