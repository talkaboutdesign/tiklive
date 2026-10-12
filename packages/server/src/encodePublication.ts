/** Internal live-message encoder shared by all sockets served by one router. */
import type { ServerMessage } from "@tiklive/contracts";
import type { SessionMessage } from "./Session.ts";

export const makePublicationEncoder = () => {
  // Publication objects are shared by subscribers. Weak keys keep eviction and scope cleanup automatic.
  const encoded = new WeakMap<SessionMessage, { username: string; text: string }>();
  return (username: string, publication: SessionMessage): string => {
    const cached = encoded.get(publication);
    if (cached?.username === username) return cached.text;
    let message: ServerMessage;
    switch (publication._tag) {
      case "Event":
        message = { type: "event", username, event: publication.event };
        break;
      case "Status":
        message = { type: "status", username, status: publication.status };
        break;
      case "Action":
        message = { type: "action", username, action: publication.action };
        break;
    }
    const text = JSON.stringify(message);
    encoded.set(publication, { username, text });
    return text;
  };
};
