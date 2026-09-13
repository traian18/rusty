import React, { useState, useEffect, useRef } from "react";
import { useWorkspaceStore } from "../store";
import { searchService, SearchMatch } from "../services/searchService";
import { SearchPaletteView } from "./SearchPalette.view";

interface SearchPaletteProps {
  onClose: () => void;
}

export const SearchPalette: React.FC<SearchPaletteProps> = ({ onClose }) => {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const openTab = useWorkspaceStore((state) => state.openTab);

  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Handle outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [onClose]);

  // Execute search when inputs change (debounced)
  useEffect(() => {
    if (!rootPath) return;

    if (!query.trim()) {
      setResults([]);
      setSelectedIndex(0);
      return;
    }

    setSearching(true);
    const delayDebounce = setTimeout(async () => {
      try {
        const matches = await searchService.searchProject({
          rootDir: rootPath,
          query,
          matchCase,
          wholeWord,
          isRegex,
        });
        setResults(matches);
        setSelectedIndex(0);
      } catch (err) {
        console.error("Search failed:", err);
      } finally {
        setSearching(false);
      }
    }, 150);

    return () => clearTimeout(delayDebounce);
  }, [query, matchCase, wholeWord, isRegex, rootPath]);

  // Select item action
  const handleSelectResult = (match: SearchMatch) => {
    openTab({ type: "file", path: match.path, title: match.name, line: match.line > 0 ? match.line : undefined });
    onClose();
  };

  // Keyboard navigation inside search results
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }

      if (results.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % results.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + results.length) % results.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const selected = results[selectedIndex];
        if (selected) {
          handleSelectResult(selected);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [results, selectedIndex, onClose]);

  // Group results by path for clean layout
  const groupedResults = results.reduce<Record<string, { name: string; items: SearchMatch[] }>>((acc, match) => {
    if (!acc[match.path]) {
      acc[match.path] = { name: match.name, items: [] };
    }
    acc[match.path].items.push(match);
    return acc;
  }, {});

  return (
    <SearchPaletteView
      query={query}
      setQuery={setQuery}
      matchCase={matchCase}
      setMatchCase={setMatchCase}
      wholeWord={wholeWord}
      setWholeWord={setWholeWord}
      isRegex={isRegex}
      setIsRegex={setIsRegex}
      searching={searching}
      results={results}
      selectedIndex={selectedIndex}
      groupedResults={groupedResults}
      rootPath={rootPath}
      onClose={onClose}
      handleSelectResult={handleSelectResult}
      inputRef={inputRef}
      containerRef={containerRef}
    />
  );
};
