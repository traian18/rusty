import { FormEvent, useEffect, useRef, useState } from "react";
import { CornerDownLeft, Loader2, MessageSquareCode, Square, X } from "lucide-react";
import { useWorkspaceStore } from "../../store";
import {
  InlineChatEditorContext,
  InlineChatMessage,
  InlineChatRun,
  inlineChatService,
} from "../../services/inlineChatService";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { CustomSelect } from "../CustomSelect";
import { providerHasModelReference, selectableProviderModels } from "../../store/providerHelpers";

interface InlineChatProps {
  sessionId: string;
  context: InlineChatEditorContext;
  position: { x: number; y: number };
  onClose: () => void;
}

export const InlineChat = ({ sessionId, context, position, onClose }: InlineChatProps) => {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const activeModel = useWorkspaceStore((state) => state.activeModel);
  const providers = useWorkspaceStore((state) => state.customProviders);
  const activeProviderId = useWorkspaceStore((state) => state.activeCustomProviderId);
  const providerStatus = useWorkspaceStore((state) => state.providerStatus);
  const [selectedModel, setSelectedModel] = useState(activeModel);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<InlineChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const runRef = useRef<InlineChatRun | null>(null);
  const responseRef = useRef("");

  useEffect(() => {
    inputRef.current?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
      runRef.current?.cancel();
    };
  }, []);

  const modelOptions = selectableProviderModels(providers, providerStatus, activeProviderId)
    .map(({ provider, model }) => ({ id: model.id, name: `${provider.name} / ${model.name}` }));

  useEffect(() => {
    if (modelOptions.some((option) => option.id === selectedModel)) return;
    const nextModel = modelOptions.some((option) => option.id === activeModel)
      ? activeModel
      : modelOptions[0]?.id || "";
    setSelectedModel(nextModel);
  }, [activeModel, activeProviderId, providers, selectedModel]);

  const stop = () => {
    runRef.current?.cancel();
    runRef.current = null;
    if (responseRef.current) {
      setMessages((current) => [...current, { role: "assistant", content: responseRef.current }]);
    }
    responseRef.current = "";
    setStreamingText("");
    setIsStreaming(false);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const prompt = input.trim();
    if (!prompt || isStreaming) return;
    if (!selectedModel) {
      setError("Select a model in LLM Setup before using inline chat.");
      return;
    }

    const userMessage: InlineChatMessage = { role: "user", content: prompt };
    const history = [...messages, userMessage];
    const provider = providers.find((item) => providerHasModelReference(item, selectedModel))
      || providers.find((item) => item.id === activeProviderId)
      || null;

    setMessages(history);
    setInput("");
    setError("");
    setIsStreaming(true);
    setStreamingText("");
    responseRef.current = "";

    runRef.current = inlineChatService.send({
      sessionId,
      message: prompt,
      model: selectedModel,
      workspaceRoot: rootPath,
      customProvider: provider,
      history: messages,
      context,
    }, {
      onToken: (token) => {
        responseRef.current += token;
        setStreamingText(responseRef.current);
      },
      onComplete: (response) => {
        const finalResponse = response || responseRef.current;
        setMessages((current) => [...current, { role: "assistant", content: finalResponse }]);
        responseRef.current = "";
        setStreamingText("");
        setIsStreaming(false);
        runRef.current = null;
        window.setTimeout(() => inputRef.current?.focus(), 0);
      },
      onError: (message) => {
        setError(message);
        responseRef.current = "";
        setStreamingText("");
        setIsStreaming(false);
        runRef.current = null;
      },
    });
  };

  const contextLabel = context.selection.text
    ? `Lines ${context.selection.startLine}-${context.selection.endLine}`
    : `Line ${context.selection.startLine}`;

  return (
    <section
      className="chat-typography-scope absolute z-[9999] flex flex-col overflow-hidden rounded-lg border border-[var(--border-active)] bg-[var(--bg-sidebar)] font-mono shadow-2xl"
      style={{
        left: position.x,
        right: position.x,
        top: position.y,
        maxHeight: `min(520px, calc(100% - ${position.y + 12}px))`,
      }}
      onMouseDown={(event) => event.stopPropagation()}
      aria-label="Inline chat"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--border-color)] bg-[var(--color-surface-sunken)] px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <MessageSquareCode size={14} className="shrink-0 text-[var(--accent-color)]" />
          <span className="text-[length:var(--font-size-chat-xs)] font-bold uppercase text-[var(--text-muted)]">Inline Chat</span>
          <span className="truncate text-[length:var(--font-size-chat-xs)] text-[var(--text-normal)]">{contextLabel}</span>
          <CustomSelect
            value={selectedModel}
            onChange={setSelectedModel}
            options={modelOptions}
            placeholder="Select model"
            className="ml-auto w-56 max-w-[45%]"
            buttonClassName="flex w-full items-center justify-between rounded border border-[var(--border-color)] bg-[var(--bg-app)] px-2 py-1 text-left text-[length:var(--font-size-chat-xs)] text-[var(--text-normal)]"
          />
        </div>
        <button onClick={onClose} className="ml-2 shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-app)] hover:text-[var(--text-light)]" title="Close inline chat (Esc)" aria-label="Close inline chat">
          <X size={14} />
        </button>
      </header>

      {(messages.length > 0 || streamingText) && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
          {messages.map((message, index) => message.role === "user" ? (
            <div key={index} className="ml-8 rounded-md bg-[var(--accent-bg)]/30 px-2.5 py-2 text-[length:var(--font-size-chat-md)] text-[var(--text-light)]">
              {message.content}
            </div>
          ) : (
            <MarkdownRenderer key={index} content={message.content} />
          ))}
          {streamingText && <MarkdownRenderer content={streamingText} />}
          {isStreaming && !streamingText && (
            <div className="flex items-center gap-2 text-[length:var(--font-size-chat-xs)] text-[var(--text-muted)]">
              <Loader2 size={13} className="animate-spin text-[var(--accent-color)]" />
              <span>Pi is thinking…</span>
            </div>
          )}
        </div>
      )}

      {error && <div className="border-t border-[var(--color-status-danger-border)] bg-[var(--color-status-danger-bg)] px-3 py-2 text-[length:var(--font-size-chat-xs)] text-[var(--color-status-danger)]">{error}</div>}

      <form onSubmit={submit} className="shrink-0 border-t border-[var(--border-color)] p-2">
        <div className="flex items-end gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-app)] p-2 focus-within:border-[var(--border-active)]">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={1}
            disabled={isStreaming}
            placeholder={context.selection.text ? "Ask about or change the selected code…" : "Ask about this code…"}
            className="max-h-28 min-h-6 flex-1 resize-none bg-transparent text-[length:var(--font-size-chat-md)] leading-[var(--line-height-chat)] text-[var(--text-light)] outline-none placeholder:text-[var(--text-muted)] disabled:opacity-60"
          />
          {isStreaming ? (
            <button type="button" onClick={stop} className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-sidebar)] hover:text-[var(--text-light)]" title="Stop">
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()} className="rounded bg-[var(--accent-color)] p-1.5 text-[var(--color-primary-foreground)] disabled:cursor-not-allowed disabled:opacity-40" title="Send (Enter)">
              <CornerDownLeft size={13} />
            </button>
          )}
        </div>
        <div className="mt-1.5 px-1 text-[length:var(--font-size-chat-xs)] text-[var(--text-muted)]">Enter to send · Shift+Enter for a new line · Esc to close</div>
      </form>
    </section>
  );
};
