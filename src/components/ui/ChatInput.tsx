import React, { useState, useRef, useEffect } from "react";
import { Send, X, FileText, Folder, Paperclip, Square, CircleHelp } from "lucide-react";
import { useWorkspaceStore } from "../../store";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { searchService } from "../../services/searchService";
import styles from "./ChatInput.module.css";
// Moved to shared/agent-protocol/rpc.ts (PR 4c) so both the client and the
// sidecar share one definition; re-exported here unchanged so existing
// importers of this module are unaffected.
export type { AgentQuestion } from "../../../shared/agent-protocol";
import type { AgentQuestion } from "../../../shared/agent-protocol";

interface ChatInputProps {
  value: string;
  onChange: (val: string) => void;
  onSend: (attachments: { path: string; name: string; isDir?: boolean }[]) => void;
  placeholder?: string;
  disabled?: boolean;
  isStreaming?: boolean;
  onStop?: () => void;
  agentQuestion?: AgentQuestion | null;
  onAgentQuestionAnswer?: (answer: string) => void;
}

interface FileItem {
  name: string;
  path: string;
  isDir: boolean;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  value,
  onChange,
  onSend,
  placeholder = "Ask or prompt changes...",
  disabled = false,
  isStreaming = false,
  onStop,
  agentQuestion,
  onAgentQuestionAnswer,
}) => {
  const fileTree = useWorkspaceStore((state) => state.fileTree);
  const rootPath = useWorkspaceStore((state) => state.rootPath);

  const [attachments, setAttachments] = useState<{ path: string; name: string; isDir?: boolean }[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<FileItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [suggestionTriggerIndex, setSuggestionTriggerIndex] = useState(-1);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const autocompleteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flatten the file tree for autocompletion fallback
  const getFlatFiles = (): FileItem[] => {
    const list: FileItem[] = [];
    const recurse = (entries: any[]) => {
      for (const entry of entries) {
        list.push({
          name: entry.name,
          path: entry.path,
          isDir: !!entry.is_dir,
        });
        if (entry.children && entry.children.length > 0) {
          recurse(entry.children);
        }
      }
    };
    recurse(fileTree || []);
    return list;
  };

  // Auto-resize the textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(200, textarea.scrollHeight)}px`;
    }
  }, [value]);

  // Handle click outside suggestions box & clean timeouts
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      if (autocompleteTimeoutRef.current) {
        clearTimeout(autocompleteTimeoutRef.current);
      }
    };
  }, []);

  const searchWorkspaceFiles = async (query: string) => {
    if (!rootPath) {
      setShowSuggestions(false);
      return;
    }

    if (!query) {
      // Instant fallback for empty query
      const flat = getFlatFiles();
      const filtered = flat.slice(0, 10);
      if (filtered.length > 0) {
        setSuggestions(filtered);
        setShowSuggestions(true);
        setSelectedIndex(0);
      } else {
        setShowSuggestions(false);
      }
      return;
    }

    try {
      const results = await searchService.searchProject({
        rootDir: rootPath,
        query,
        matchCase: false,
        wholeWord: false,
        isRegex: false,
      });

      const fileMatches = results
        .filter((r) => !r.is_content_match) // only filenames
        .map((r) => ({
          name: r.name,
          path: r.path,
          isDir: false,
        }))
        .slice(0, 10);

      if (fileMatches.length > 0) {
        setSuggestions(fileMatches);
        setShowSuggestions(true);
        setSelectedIndex(0);
      } else {
        setShowSuggestions(false);
      }
    } catch (err) {
      console.error("Failed autocomplete search:", err);
      setShowSuggestions(false);
    }
  };

  // Handle keydown for autocompletion suggestions
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSuggestions && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % suggestions.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertSuggestion(suggestions[selectedIndex]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setShowSuggestions(false);
      }
    } else if (agentQuestion) {
      if (e.key === "Enter" && !e.shiftKey && value.trim()) {
        e.preventDefault();
        onAgentQuestionAnswer?.(value.trim());
        onChange("");
      }
    } else {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    onChange(text);

    const selectionStart = e.target.selectionStart;
    const beforeCursor = text.substring(0, selectionStart);

    // Check if user has typed `@` followed by any non-whitespace characters
    const atMatch = beforeCursor.match(/@([^\s@]*)$/);

    if (atMatch) {
      const query = atMatch[1].toLowerCase();
      const triggerIdx = selectionStart - atMatch[0].length;
      setSuggestionTriggerIndex(triggerIdx);

      if (autocompleteTimeoutRef.current) {
        clearTimeout(autocompleteTimeoutRef.current);
      }

      autocompleteTimeoutRef.current = setTimeout(() => {
        searchWorkspaceFiles(query);
      }, 150);
    } else {
      setShowSuggestions(false);
    }
  };

  const insertSuggestion = (item: FileItem) => {
    const text = value;
    const startPart = text.substring(0, suggestionTriggerIndex);
    // Use relative path if possible, or just the file name
    const relativePath = rootPath ? item.path.replace(`${rootPath}/`, "") : item.name;
    const completedText =
      `${startPart}@${relativePath} ` + text.substring(textareaRef.current?.selectionStart || 0);

    onChange(completedText);
    setShowSuggestions(false);

    // Reposition cursor
    setTimeout(() => {
      if (textareaRef.current) {
        const cursorPosition = startPart.length + relativePath.length + 2; // +2 for @ and space
        textareaRef.current.setSelectionRange(cursorPosition, cursorPosition);
        textareaRef.current.focus();
      }
    }, 10);
  };

  const handleAddAttachment = async () => {
    try {
      const selected = await openDialog({
        multiple: true,
        directory: false,
        title: "Attach Context Document/File",
      });

      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        const newAttachments = paths.map((p) => {
          const name = p.split("/").pop() || p;
          return { path: p, name, isDir: false };
        });
        setAttachments((prev) => {
          // Avoid duplicates
          const filtered = newAttachments.filter((n) => !prev.some((p) => p.path === n.path));
          return [...prev, ...filtered];
        });
      }
    } catch (err) {
      console.error("Failed to pick files:", err);
    }
  };

  const handleRemoveAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  const handleSend = () => {
    if (!value.trim() && attachments.length === 0) return;
    onSend(attachments);
    setAttachments([]);
  };

  const answerQuestion = (answer: string) => {
    const normalized = answer.trim();
    if (!normalized) return;
    onAgentQuestionAnswer?.(normalized);
    onChange("");
  };

  return (
    <div className={`chat-typography-scope ${styles.composer} w-full flex flex-col relative bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-lg shadow-sm focus-within:border-[var(--accent-color)]/40 transition-colors`}>
      {/* 1. Autocomplete Dropdown */}
      {showSuggestions && suggestions.length > 0 && (
        <div
          ref={suggestionsRef}
          className="absolute left-0 bottom-full mb-1 z-[150] w-full max-h-48 overflow-y-auto bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-lg shadow-xl py-1 font-mono animate-in fade-in slide-in-from-bottom-2 duration-150"
        >
          <div className="px-3 py-1 border-b border-[var(--border-color)]/40 text-[length:var(--font-size-chat-xs)] font-mono text-[var(--text-muted)] uppercase tracking-wider">
            Autolink Files
          </div>
          {suggestions.map((item, idx) => (
            <button
              key={item.path}
              onClick={() => insertSuggestion(item)}
              className={`w-full text-left px-3 py-1.5 flex items-center justify-between text-[length:var(--font-size-chat-md)] transition-colors cursor-pointer ${
                idx === selectedIndex
                  ? "bg-[var(--accent-bg)] text-[var(--text-light)]"
                  : "text-[var(--text-normal)] hover:bg-[var(--accent-bg)]/40"
              }`}
            >
              <span className="flex items-center space-x-2 min-w-0">
                {item.isDir ? (
                  <Folder size={12} className="text-[var(--color-secondary)] flex-shrink-0" />
                ) : (
                  <FileText size={12} className="text-[var(--color-fg-muted)] flex-shrink-0" />
                )}
                <span className="truncate">{item.name}</span>
              </span>
              <span className="text-[length:var(--font-size-chat-xs)] font-mono text-[var(--text-muted)] ml-2 truncate max-w-[120px]">
                {rootPath ? item.path.replace(`${rootPath}/`, "") : ""}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* 2. Attachments Preview Drawer */}
      {agentQuestion && (
        <div className="mx-3 mt-3 rounded-lg border border-[var(--color-status-info-border)] bg-[var(--color-status-info-bg)] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-status-info-border)] text-[var(--color-status-info)]">
            <CircleHelp size={14} className="text-[var(--color-status-info)] flex-shrink-0" />
            <span className="text-[length:var(--font-size-chat-xs)] font-mono uppercase tracking-wider font-semibold">Agent needs your decision</span>
          </div>
          <div className="px-3 pt-2.5 pb-3">
            <p className="text-[length:var(--font-size-chat-md)] text-[var(--text-light)] leading-relaxed">{agentQuestion.question}</p>
            {agentQuestion.options.length > 0 && (
              <div className="mt-2 grid gap-1.5">
                {agentQuestion.options.map((option, index) => (
                  <button
                    key={`${option.label}-${index}`}
                    type="button"
                    onClick={() => answerQuestion(option.label)}
                    className="w-full text-left rounded border border-[var(--color-border-default)] bg-[var(--color-surface-input)] px-2.5 py-2 hover:border-[var(--color-status-info)] hover:bg-[var(--color-interaction-hover)] transition-colors cursor-pointer"
                  >
                    <div className="text-[length:var(--font-size-chat-sm)] text-[var(--text-light)] font-medium">{option.label}</div>
                    {option.description && <div className="mt-0.5 text-[length:var(--font-size-chat-xs)] text-[var(--text-muted)]">{option.description}</div>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3 pb-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-log-header)]">
          {attachments.map((att) => (
            <div
              key={att.path}
              className="flex items-center space-x-1.5 px-2 py-0.5 rounded bg-[var(--color-surface-elevated)] border border-[var(--color-border-subtle)] text-[length:var(--font-size-chat-xs)] font-mono text-[var(--color-fg-strong)]"
            >
              <Paperclip size={10} className="text-[var(--accent-color)]" />
              <span className="truncate max-w-[150px]">{att.name}</span>
              <button
                onClick={() => handleRemoveAttachment(att.path)}
                className="text-[var(--text-muted)] hover:text-[var(--color-status-danger)] transition-colors p-0.5 rounded-full"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 3. Text Area Input */}
      <div className="px-3 pt-2.5 pb-1">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={agentQuestion ? "Type a different answer, then press Enter..." : placeholder}
          disabled={disabled && !agentQuestion}
          className="w-full bg-transparent border-none outline-none py-1 text-[length:var(--font-size-chat-md)] text-[var(--text-light)] placeholder-[var(--text-muted)] resize-none font-sans leading-relaxed min-h-[36px] select-text focus:ring-0 focus:outline-none"
          rows={1}
          style={{ height: "auto", maxHeight: "200px" }}
        />
      </div>

      {/* 4. Controls Footer Row */}
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--color-log-header)] border-t border-[var(--color-border-subtle)] text-[length:var(--font-size-chat-xs)] font-mono text-[var(--color-fg-muted)] select-none rounded-b-lg">
        <div className="flex items-center space-x-3">
          {/* Upload Button */}
          <button
            type="button"
            onClick={handleAddAttachment}
            disabled={disabled}
            className="flex items-center space-x-1 px-2 py-1 rounded bg-[var(--bg-app)] border border-[var(--border-color)] hover:text-[var(--text-light)] hover:border-[var(--accent-color)]/40 transition-all cursor-pointer text-[length:var(--font-size-chat-xs)] text-[var(--text-normal)]"
            title="Attach file to prompt context"
          >
            <Paperclip size={11} className="text-[var(--accent-color)]" />
            <span>Add Context</span>
          </button>

          <span className="text-[length:var(--font-size-chat-xs)] text-[var(--text-muted)]/60 font-light hidden xs:inline">
            Use @ to reference workspace files
          </span>
        </div>

        <div className="flex items-center space-x-3">
          <span className="text-[length:var(--font-size-chat-xs)] text-[var(--text-muted)]/60 hidden md:inline">
            Enter to submit, Shift+Enter for new line
          </span>

          {/* Send or Stop Button */}
          {agentQuestion ? (
            <>
              <button
                type="button"
                onClick={() => answerQuestion(value)}
                disabled={!value.trim()}
                className="flex items-center space-x-1.5 px-3 py-1 rounded bg-[var(--color-status-danger-solid)] disabled:opacity-40 text-[var(--color-status-danger-solid-foreground)] hover:bg-[var(--color-status-danger-solid)] font-semibold transition-all cursor-pointer shadow-sm text-[length:var(--font-size-chat-xs)]"
              >
                <Send size={9} />
                <span>ANSWER</span>
              </button>
              {isStreaming && onStop && (
                <button
                  type="button"
                  onClick={onStop}
                  className="flex items-center space-x-1.5 px-3 py-1 rounded bg-[var(--color-status-danger-solid)] hover:bg-[var(--color-status-danger-solid)] text-[var(--color-status-danger-solid-foreground)] font-semibold transition-all cursor-pointer shadow-sm text-[length:var(--font-size-chat-xs)]"
                >
                  <Square size={9} fill="currentColor" />
                  <span>STOP</span>
                </button>
              )}
            </>
          ) : isStreaming && onStop ? (
            <button
              type="button"
              onClick={onStop}
              className="flex items-center space-x-1.5 px-3 py-1 rounded bg-[var(--color-status-danger-solid)] hover:bg-[var(--color-status-danger-solid)] text-[var(--color-status-danger-solid-foreground)] font-semibold transition-all cursor-pointer shadow-sm animate-pulse text-[length:var(--font-size-chat-xs)]"
            >
              <Square size={9} fill="currentColor" />
              <span>STOP</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={disabled || (!value.trim() && attachments.length === 0)}
              className="flex items-center space-x-1.5 px-3 py-1 rounded bg-[var(--accent-color)] disabled:opacity-40 disabled:hover:bg-[var(--accent-color)] text-[var(--color-primary-foreground)] hover:bg-[var(--accent-color)]/80 font-semibold transition-all cursor-pointer shadow-sm text-[length:var(--font-size-chat-xs)]"
            >
              <Send size={9} />
              <span>PROMPT</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
