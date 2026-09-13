import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../../store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startWorkspaceFsWatch, stopWorkspaceFsWatch } from "./workspaceFsWatchCoordinator";
import * as fileTreePresenter from "../filetree/FileTreePresenter";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../filetree/FileTreePresenter", () => ({ scheduleTreeRefresh: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);
const mockScheduleTreeRefresh = vi.mocked(fileTreePresenter.scheduleTreeRefresh);

describe("workspaceFsWatchCoordinator", () => {
  const originalRootPath = useWorkspaceStore.getState().rootPath;

  beforeEach(() => {
    mockInvoke.mockReset().mockResolvedValue(undefined);
    mockListen.mockReset().mockResolvedValue(() => {});
    mockScheduleTreeRefresh.mockReset();
  });

  afterEach(() => {
    stopWorkspaceFsWatch();
    useWorkspaceStore.setState({ rootPath: originalRootPath });
  });

  it("subscribes to workspace-fs-changed exactly once", () => {
    startWorkspaceFsWatch();
    expect(mockListen).toHaveBeenCalledTimes(1);
    expect(mockListen).toHaveBeenCalledWith("workspace-fs-changed", expect.any(Function));
  });

  it("is idempotent: a second start does not double-subscribe", () => {
    startWorkspaceFsWatch();
    startWorkspaceFsWatch();
    expect(mockListen).toHaveBeenCalledTimes(1);
  });

  it("tells Rust to watch the current rootPath on start, when one is already set", () => {
    useWorkspaceStore.setState({ rootPath: "/repo/already-open" });
    startWorkspaceFsWatch();
    expect(mockInvoke).toHaveBeenCalledWith("watch_workspace", { rootDir: "/repo/already-open" });
  });

  it("starts watching a new root when rootPath changes after start", () => {
    useWorkspaceStore.setState({ rootPath: "" });
    startWorkspaceFsWatch();
    mockInvoke.mockClear();

    useWorkspaceStore.setState({ rootPath: "/repo/opened-later" });
    expect(mockInvoke).toHaveBeenCalledWith("watch_workspace", { rootDir: "/repo/opened-later" });
  });

  it("does not re-invoke watch_workspace for a no-op rootPath change to the same value", () => {
    useWorkspaceStore.setState({ rootPath: "/repo/same" });
    startWorkspaceFsWatch();
    mockInvoke.mockClear();

    // Setting other state alongside an unchanged rootPath still fires the
    // store's subscribe callback -- applyRoot's own dedup (not the
    // subscription's `state.rootPath !== previous.rootPath` guard) is what
    // must hold here, since a rootPath-inclusive object literal always
    // creates a new state reference.
    useWorkspaceStore.setState({ rootPath: "/repo/same" });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("calls scheduleTreeRefresh when the fs-changed event fires", () => {
    let handler: (() => void) | undefined;
    mockListen.mockImplementation((_event, cb) => {
      handler = cb as () => void;
      return Promise.resolve(() => {});
    });

    startWorkspaceFsWatch();
    expect(handler).toBeDefined();
    handler?.();
    expect(mockScheduleTreeRefresh).toHaveBeenCalledTimes(1);
  });

  it("stopWorkspaceFsWatch allows a clean restart that re-subscribes", () => {
    startWorkspaceFsWatch();
    stopWorkspaceFsWatch();
    startWorkspaceFsWatch();
    expect(mockListen).toHaveBeenCalledTimes(2);
  });
});
