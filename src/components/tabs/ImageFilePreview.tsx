import React, { useState } from "react";
import { FileSearch, ZoomIn, ZoomOut } from "lucide-react";
import { fileTreePresenter } from "../filetree/FileTreePresenter";
import { formatFileSize } from "./UnsupportedFilePreview";

interface ImageFilePreviewProps {
  path: string;
  fileName: string;
  src: string;
  sizeBytes: number;
}

const ZOOM_STEP = 0.25;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

/**
 * Renders an actual `<img>` for a file FileTab detected as an image
 * (services/imageFile.ts), instead of handing its binary bytes to Monaco or
 * falling through to UnsupportedFilePreview's generic "can't display this"
 * card. `src` is the `data:` URL FileTab already built from
 * `read_file_as_base64`'s response -- this component owns no fetching of
 * its own.
 *
 * The checkerboard background (CSS, not an asset) is what makes a
 * transparent PNG/SVG's alpha channel visible, the same convention every
 * other image viewer uses; naturalWidth/naturalHeight come from the
 * `<img>` itself once loaded rather than a second round trip to Rust.
 */
export const ImageFilePreview: React.FC<ImageFilePreviewProps> = ({ path, fileName, src, sizeBytes }) => {
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [loadError, setLoadError] = useState(false);

  if (loadError) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 font-mono text-xs text-[var(--text-muted)] bg-[var(--bg-app)] select-none">
        <span className="text-sm font-semibold text-[var(--text-light)]">{fileName}</span>
        <p className="max-w-[280px] text-center leading-relaxed">
          This image could not be decoded for preview.
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
  }

  return (
    <div className="w-full h-full flex flex-col bg-[var(--bg-app)]">
      <div
        className="flex-1 overflow-auto flex items-center justify-center p-6"
        style={{
          backgroundImage:
            "linear-gradient(45deg, var(--color-surface-sunken) 25%, transparent 25%), " +
            "linear-gradient(-45deg, var(--color-surface-sunken) 25%, transparent 25%), " +
            "linear-gradient(45deg, transparent 75%, var(--color-surface-sunken) 75%), " +
            "linear-gradient(-45deg, transparent 75%, var(--color-surface-sunken) 75%)",
          backgroundSize: "20px 20px",
          backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
        }}
      >
        <img
          src={src}
          alt={fileName}
          onLoad={(e) => {
            const img = e.currentTarget;
            setDimensions({ width: img.naturalWidth, height: img.naturalHeight });
          }}
          onError={() => setLoadError(true)}
          style={{
            width: dimensions ? dimensions.width * zoom : undefined,
            height: dimensions ? dimensions.height * zoom : undefined,
            maxWidth: dimensions ? undefined : "100%",
            maxHeight: dimensions ? undefined : "100%",
          }}
          className="select-none shadow-lg"
          draggable={false}
        />
      </div>

      <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-[var(--border-color)] bg-[var(--bg-sidebar)] font-mono text-[10px] text-[var(--text-muted)]">
        <div className="flex items-center gap-3 min-w-0">
          <span className="truncate text-[var(--text-normal)]">{fileName}</span>
          <span>{formatFileSize(sizeBytes)}</span>
          {dimensions && <span>{dimensions.width}&times;{dimensions.height}</span>}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP))}
            className="p-1 rounded hover:bg-[var(--bg-app)] hover:text-[var(--text-light)] cursor-pointer"
            title="Zoom out"
          >
            <ZoomOut size={12} />
          </button>
          <span className="w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP))}
            className="p-1 rounded hover:bg-[var(--bg-app)] hover:text-[var(--text-light)] cursor-pointer"
            title="Zoom in"
          >
            <ZoomIn size={12} />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="ml-1 px-2 py-1 rounded border border-[var(--border-color)] hover:border-[var(--border-active)] hover:text-[var(--text-light)] cursor-pointer"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => fileTreePresenter.openInFinder(path)}
            className="flex items-center gap-1.5 ml-2 px-2 py-1 rounded border border-[var(--border-color)] hover:border-[var(--border-active)] hover:text-[var(--text-light)] cursor-pointer"
          >
            <FileSearch size={11} />
            <span>Reveal</span>
          </button>
        </div>
      </div>
    </div>
  );
};
