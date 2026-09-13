import React from "react";
import { FileSearch } from "lucide-react";
import { FileIcon } from "../../services/fileTypeService";
import { fileTreePresenter } from "../filetree/FileTreePresenter";

/** Human-readable file size, e.g. "3.2 MB". Shared with FileTab.tsx's
    large-file banner (REFACTOR_PLAN.md PR 6). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

interface UnsupportedFilePreviewProps {
  path: string;
  fileName: string;
  sizeBytes: number;
}

/**
 * Shown instead of Monaco when check_file_open_safety reports a binary
 * file (REFACTOR_PLAN.md PR 6 commit 8) -- opening it as text would either
 * error or render corrupted content.
 */
export const UnsupportedFilePreview: React.FC<UnsupportedFilePreviewProps> = ({ path, fileName, sizeBytes }) => {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-3 font-mono text-xs text-[var(--text-muted)] bg-[var(--bg-app)] select-none">
      <FileIcon fileName={fileName} size={40} />
      <div className="flex flex-col items-center gap-1">
        <span className="text-sm font-semibold text-[var(--text-light)]">{fileName}</span>
        <span>{formatFileSize(sizeBytes)} &middot; binary file</span>
      </div>
      <p className="max-w-[280px] text-center leading-relaxed">
        This file can't be displayed as text. Open it in a native app instead.
      </p>
      <button
        type="button"
        onClick={() => fileTreePresenter.openInFinder(path)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-color)] hover:border-[var(--border-active)] text-[var(--text-normal)] hover:text-[var(--text-light)] cursor-pointer transition-colors"
      >
        <FileSearch size={12} />
        <span>Reveal in Finder</span>
      </button>
    </div>
  );
};
