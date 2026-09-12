/** Frontend broker for command approvals emitted by any Pi runtime. */

/**
 * The minimal shape this service needs from whatever transport carried the
 * request: a real WebSocket satisfies this structurally (readyState + send),
 * and so does a typed per-capability service's lightweight facade over the
 * one shared agentHarnessClient connection -- PR 4b migrates consumers off
 * raw sockets one capability at a time, and this interface (rather than the
 * concrete WebSocket class) is what lets this service keep working
 * unchanged for both kinds of caller.
 */
export interface CommandPermissionSocket {
  readonly readyState: number;
  send(data: string): void;
}

export type CommandPermissionDecision = "deny" | "allow_once" | "allow_session";
export type CommandRisk = "normal" | "elevated" | "destructive";
export type CommandSessionGrantScope = "executable" | "exact_command";

export interface CommandPermissionRequest {
  requestId: string;
  sessionId: string;
  command: { program: string; args: string[]; cwd: string; timeoutMs: number };
  risk: CommandRisk;
  sessionGrantScope: CommandSessionGrantScope;
  sessionGrantProgram: string;
  description: string;
}

type PendingPermission = CommandPermissionRequest & { socket: CommandPermissionSocket };
type Listener = () => void;

class CommandPermissionService {
  private queue: PendingPermission[] = [];
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CommandPermissionRequest | null => this.queue[0] || null;

  enqueue(message: CommandPermissionRequest, socket: CommandPermissionSocket): void {
    if (this.queue.some((request) => request.requestId === message.requestId)) return;
    this.queue.push({ ...message, socket });
    this.emit();
  }

  resolve(requestId: string, decision: CommandPermissionDecision): void {
    const request = this.queue.find((candidate) => candidate.requestId === requestId);
    if (!request) return;
    if (request.socket.readyState === WebSocket.OPEN) {
      request.socket.send(JSON.stringify({ type: "command_permission_response", requestId, decision }));
    }
    this.queue = this.queue.filter((candidate) => candidate.requestId !== requestId);
    this.emit();
  }

  removeForSocket(socket: CommandPermissionSocket): void {
    const next = this.queue.filter((request) => request.socket !== socket);
    if (next.length !== this.queue.length) {
      this.queue = next;
      this.emit();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const commandPermissionService = new CommandPermissionService();

/** Returns true when a WebSocket message was consumed by the permission broker. */
export function handleCommandPermissionMessage(message: any, socket: CommandPermissionSocket): boolean {
  if (message?.type !== "command_permission_request" || !message.requestId || !message.sessionId) return false;
  commandPermissionService.enqueue(message as CommandPermissionRequest, socket);
  return true;
}
