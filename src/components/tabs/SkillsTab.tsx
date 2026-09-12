import React, { useState, useEffect, useRef } from "react";
import { useWorkspaceStore, Skill } from "../../store";
import { skillsService } from "../../services/skillsService";
import { Cpu, Plus, Trash2, Save, Wand2, Plug } from "lucide-react";
import { CustomSelect } from "../CustomSelect";
import { notify } from "../../notificationStore";
import { providerHasModelReference, selectableProviderModels } from "../../store/providerHelpers";
import { createAgentHarnessSocket } from "../../services/agentHarnessClient";
import { SIDECAR_PORT } from "../../config/sidecar";

const AVAILABLE_TOOLS = [
  { id: "read_file", label: "Read Files" },
  { id: "write_file", label: "Write Files" },
  { id: "list_files", label: "List Files" },
  { id: "search_codebase", label: "Search Codebase" },
  { id: "web_search", label: "Search Web" },
  { id: "run_command", label: "Run Commands" },
];

export const SkillsTab: React.FC = () => {
  const skills = useWorkspaceStore((state) => state.skills);
  const addSkill = useWorkspaceStore((state) => state.addSkill);
  const updateSkill = useWorkspaceStore((state) => state.updateSkill);
  const deleteSkill = useWorkspaceStore((state) => state.deleteSkill);
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const customProviders = useWorkspaceStore((state) => state.customProviders);
  const activeCustomProviderId = useWorkspaceStore((state) => state.activeCustomProviderId);
  const providerStatus = useWorkspaceStore((state) => state.providerStatus);
  const mcpServers = useWorkspaceStore((state) => state.mcpServers);

  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [editingSkill, setEditingSkill] = useState<Partial<Skill> | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [genModel, setGenModel] = useState<string>("");
  const [genDescription, setGenDescription] = useState<string>("");
  const [showSavedModal, setShowSavedModal] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  const selectedSkill = skills.find((s) => s.id === selectedSkillId);

  const isDirty = editingSkill && selectedSkill
    ? JSON.stringify(editingSkill) !== JSON.stringify({ ...selectedSkill })
    : editingSkill !== null && !skills.some(s => s.id === editingSkill?.id);

  useEffect(() => {
    if (selectedSkill) {
      setEditingSkill({ ...selectedSkill });
    } else {
      setEditingSkill(null);
    }
  }, [selectedSkillId, selectedSkill]);

  const handleNewSkill = () => {
    const id = `skill_custom_${Date.now()}`;
    const newSkill: Skill = {
      id,
      name: "New Skill",
      description: "",
      systemPrompt: "",
      enabledTools: ["read_file", "write_file", "list_files", "search_codebase", "web_search", "run_command"],
      mcpServers: [],
      isBuiltIn: false,
      icon: "help",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    addSkill(newSkill);
    setSelectedSkillId(id);
    setEditingSkill({ ...newSkill });
  };

  const handleSave = async () => {
    if (!editingSkill?.id) return;
    const fullSkill: Skill = {
      id: editingSkill.id,
      name: editingSkill.name || "Unnamed Skill",
      description: editingSkill.description || "",
      systemPrompt: editingSkill.systemPrompt || "",
      enabledTools: editingSkill.enabledTools || [],
      preferredModel: editingSkill.preferredModel,
      mcpServers: editingSkill.mcpServers || [],
      isBuiltIn: editingSkill.isBuiltIn || false,
      icon: editingSkill.icon,
      createdAt: editingSkill.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (editingSkill.isBuiltIn) {
      updateSkill(fullSkill.id, fullSkill);
    } else {
      addSkill(fullSkill);
      if (rootPath) {
        await skillsService.saveSkill(rootPath, fullSkill);
      }
    }
    setSelectedSkillId(fullSkill.id);
    setShowSavedModal(true);
    setTimeout(() => setShowSavedModal(false), 2000);
  };

  const handleDelete = async (id: string) => {
    const skill = skills.find((s) => s.id === id);
    if (!skill) return;
    if (skill.isBuiltIn) return;
    deleteSkill(id);
    if (rootPath) {
      await skillsService.deleteSkill(rootPath, id);
    }
    if (selectedSkillId === id) {
      setSelectedSkillId(null);
      setEditingSkill(null);
    }
  };

  const handleToolToggle = (toolId: string) => {
    if (!editingSkill) return;
    const current = editingSkill.enabledTools || [];
    const updated = current.includes(toolId)
      ? current.filter((t) => t !== toolId)
      : [...current, toolId];
    setEditingSkill({ ...editingSkill, enabledTools: updated });
  };

  const handleMcpToggle = (serverName: string) => {
    if (!editingSkill) return;
    const current = editingSkill.mcpServers || [];
    const updated = current.includes(serverName)
      ? current.filter((n) => n !== serverName)
      : [...current, serverName];
    setEditingSkill({ ...editingSkill, mcpServers: updated });
  };

  const handleGenerateWithAI = async (model: string, description: string) => {
    if (!description.trim()) return;
    setIsGenerating(true);
    setGenerateError(null);

    try {
      const provider = customProviders.find((p) =>
        providerHasModelReference(p, model)
      );

      try {
        wsRef.current = createAgentHarnessSocket();
      } catch (err: any) {
        console.error("Failed to construct Skills WebSocket:", err);
        setGenerateError(`WebSocket connection failed: ${err.message || String(err)}`);
        setIsGenerating(false);
        notify(
          "Sidecar Connection Error",
          `Failed to create WebSocket connection to sidecar: ${err.message || String(err)}. Ensure the agent sidecar is running on port ${SIDECAR_PORT}.`,
          "error"
        );
        return;
      }

      wsRef.current.onopen = () => {
        wsRef.current?.send(JSON.stringify({
          type: "generate_skill",
          model,
          description,
          workspaceRoot: rootPath,
          customProvider: provider || null,
        }));
      };

      wsRef.current.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "generate_skill_response") {
            try {
              const generated = typeof msg.spec === "string"
                ? JSON.parse(msg.spec)
                : msg.spec;
              setEditingSkill({
                ...editingSkill!,
                systemPrompt: generated.systemPrompt || "",
                enabledTools: generated.enabledTools || ["read_file", "list_files"],
                description: generated.description || description,
              });
            } catch {
              setGenerateError("Failed to parse generated skill. Please try again.");
              notify("Parse Error", "Failed to parse generated skill specification.", "error");
            }
            wsRef.current?.close();
            setIsGenerating(false);
          } else if (msg.type === "generate_skill_error") {
            setGenerateError(msg.error || "Generation failed");
            wsRef.current?.close();
            setIsGenerating(false);
            notify("Generation Error", `Skill generation failed with error: ${msg.error}`, "error");
          }
        } catch (err: any) {
          setGenerateError("Invalid response from sidecar");
          wsRef.current?.close();
          setIsGenerating(false);
          notify("Sidecar Communication Error", `Error processing message from sidecar: ${err.message || String(err)}`, "error");
        }
      };

      wsRef.current.onerror = () => {
        setGenerateError("WebSocket connection failed. Is the sidecar running?");
        setIsGenerating(false);
        notify(
          "Sidecar Connection Failed",
          `Connection to agent sidecar closed unexpectedly. Ensure agent sidecar is running on port ${SIDECAR_PORT}.`,
          "error"
        );
      };

      setTimeout(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.close();
          setIsGenerating(false);
          notify("Timeout", "Skill generation request timed out after 60 seconds.", "info");
        }
      }, 60000);
    } catch (err: any) {
      setGenerateError(String(err));
      setIsGenerating(false);
      notify("Exception", `An unexpected exception occurred: ${err.message || String(err)}`, "error");
    }
  };

  const modelOptions = selectableProviderModels(customProviders, providerStatus, activeCustomProviderId)
    .map(({ provider, model }) => ({ id: model.id, name: `${provider.name} / ${model.name}` }));

  return (
    <div className="w-full h-full p-8 max-w-5xl mx-auto flex flex-col space-y-6 font-sans text-[var(--text-normal)] overflow-y-auto">
      <div className="flex flex-col space-y-1">
        <h2 className="text-2xl font-bold text-[var(--text-light)] flex items-center space-x-2">
          <Cpu className="text-[var(--accent-color)]" size={24} />
          <span>Skills</span>
        </h2>
        <p className="text-xs text-[var(--text-muted)] font-mono">
          Design AI agent behaviors and generate skill specs with a model.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-8">
        <div className="md:col-span-2 space-y-4">
          <div className="bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider font-mono">
                Skills
              </h3>
              <button
                onClick={handleNewSkill}
                className="flex items-center space-x-1 text-[10px] font-bold text-[var(--accent-color)] hover:text-[var(--text-light)] transition-colors px-2 py-1 rounded-lg hover:bg-[var(--accent-bg)]"
              >
                <Plus size={12} />
                <span>New</span>
              </button>
            </div>

            <div className="space-y-2">
              {skills.filter((skill) => !skill.isInternal).map((skill) => {
                const isSelected = skill.id === selectedSkillId;
                return (
                  <div
                    key={skill.id}
                    onClick={() => setSelectedSkillId(skill.id)}
                    className={`group flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all ${
                      isSelected
                        ? "border-[var(--accent-color)] bg-[var(--accent-bg)]/20 shadow-[0_0_10px_var(--color-focus-ring)]"
                        : "border-[var(--border-color)] bg-[var(--bg-app)]/50 hover:bg-[var(--bg-sidebar)] hover:border-[var(--border-active)]"
                    }`}
                  >
                    <div className="flex flex-col min-w-0 pr-2">
                      <span className="text-xs font-bold text-[var(--text-light)] group-hover:text-[var(--accent-color)] transition-colors">
                        {skill.name}
                      </span>
                      <span className="text-[10px] text-[var(--text-muted)] font-mono truncate mt-0.5 max-w-[180px]">
                        {skill.description || "No description"}
                      </span>
                    </div>
                    <div className="flex items-center space-x-2 flex-shrink-0">
                      {skill.isBuiltIn && (
                        <span className="text-[8px] font-bold text-[var(--color-status-warning)] bg-[var(--color-status-warning-bg)] px-1.5 py-0.5 rounded-full">
                          Built-in
                        </span>
                      )}
                      {!skill.isBuiltIn && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(skill.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-[var(--color-status-danger)] hover:text-[var(--color-status-danger)]"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="md:col-span-3 space-y-4">
          {editingSkill ? (
            <div className="bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-xl p-6 space-y-5">
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider font-mono block mb-2">
                    Name
                  </label>
                  <input
                    type="text"
                    value={editingSkill.name || ""}
                    onChange={(e) => setEditingSkill({ ...editingSkill, name: e.target.value })}
                    disabled={editingSkill.isBuiltIn}
                    className="w-full bg-[var(--bg-app)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-light)] focus:border-[var(--accent-color)] focus:outline-none disabled:opacity-50"
                    placeholder="Skill name..."
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider font-mono block mb-2">
                    Description
                  </label>
                  <textarea
                    value={editingSkill.description || ""}
                    onChange={(e) => setEditingSkill({ ...editingSkill, description: e.target.value })}
                    rows={2}
                    className="w-full bg-[var(--bg-app)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-light)] focus:border-[var(--accent-color)] focus:outline-none resize-y"
                    placeholder="What this skill does..."
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider font-mono block mb-2">
                    System Prompt
                  </label>
                  <textarea
                    value={editingSkill.systemPrompt || ""}
                    onChange={(e) => setEditingSkill({ ...editingSkill, systemPrompt: e.target.value })}
                    rows={14}
                    className="w-full bg-[var(--bg-app)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-light)] focus:border-[var(--accent-color)] focus:outline-none resize-y font-mono"
                    placeholder="You are an AI coding agent specialized in..."
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider font-mono block mb-3">
                    Enabled Tools
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {AVAILABLE_TOOLS.map((tool) => {
                      const isEnabled = (editingSkill.enabledTools || []).includes(tool.id);
                      return (
                        <button
                          key={tool.id}
                          onClick={() => handleToolToggle(tool.id)}
                          className={`flex items-center space-x-2 p-2 rounded-lg border transition-all text-left ${
                            isEnabled
                              ? "border-[var(--accent-color)] bg-[var(--accent-bg)]/20 text-[var(--accent-color)]"
                              : "border-[var(--border-color)] bg-[var(--bg-app)]/50 text-[var(--text-muted)] hover:border-[var(--border-active)]"
                          }`}
                        >
                          <div className={`w-2 h-2 rounded-full ${isEnabled ? "bg-[var(--accent-color)]" : "bg-[var(--border-color)]"}`} />
                          <span className="text-xs font-bold">{tool.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider font-mono block mb-2">
                    Allowed MCP Servers
                  </label>
                  {Object.keys(mcpServers).length === 0 ? (
                    <p className="text-[10px] font-mono text-[var(--text-muted)] py-2 px-3 border border-dashed border-[var(--border-color)] rounded-lg">
                      No MCP servers configured. Add one via the MCP Integration tab.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(mcpServers).map(([name, srv]) => {
                        const selected = (editingSkill.mcpServers || []).includes(name);
                        return (
                          <button
                            key={name}
                            onClick={() => handleMcpToggle(name)}
                            className={`flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg border transition-all ${
                              selected
                                ? "border-[var(--color-status-info-border)] bg-[var(--color-status-info-bg)] text-[var(--color-status-info)]"
                                : "border-[var(--border-color)] bg-[var(--bg-app)]/50 text-[var(--text-muted)] hover:border-[var(--color-status-info-border)] hover:text-[var(--text-light)]"
                            }`}
                            title={srv.transport.url || srv.transport.command || name}
                          >
                            <Plug size={12} className={selected ? "text-[var(--color-status-info)]" : "text-[var(--text-muted)]"} />
                            <span className="text-[11px] font-bold">{srv.displayName || name}</span>
                            {!srv.enabled && (
                              <span className="text-[8px] font-mono text-[var(--text-muted)] uppercase">off</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <p className="text-[9px] text-[var(--text-muted)] font-mono mt-1.5">
                    Selected servers expose their tools to the LLM when this skill is active.
                  </p>
                </div>

                <div>
                  <label className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider font-mono block mb-2">
                    Preferred Model (optional)
                  </label>
                  <div className="max-w-xs">
                    <CustomSelect
                      options={[{ id: "", name: "Default" }, ...modelOptions]}
                      value={editingSkill.preferredModel || ""}
                      onChange={(val) => setEditingSkill({ ...editingSkill, preferredModel: val || undefined })}
                      placeholder="Use default model"
                    />
                  </div>
                </div>

                <div className="pt-2 flex items-center space-x-3">
                  <button
                    onClick={handleSave}
                    disabled={!isDirty}
                    className="flex items-center space-x-2 px-4 py-2 bg-[var(--accent-color)] hover:bg-[var(--accent-color)]/80 disabled:opacity-40 disabled:cursor-not-allowed text-[var(--color-primary-foreground)] text-xs font-bold rounded-lg transition-colors"
                  >
                    <Save size={14} />
                    <span>Save</span>
                  </button>
                  {editingSkill.isBuiltIn && (
                    <span className="text-[10px] text-[var(--text-muted)] font-mono">
                      Built-in skill — editing in memory
                    </span>
                  )}
                </div>
              </div>

              <div className="border-t border-[var(--border-color)] pt-5 space-y-4">
                <div className="flex items-center space-x-2">
                  <Wand2 size={14} className="text-[var(--accent-color)]" />
                  <h3 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider font-mono">
                    Generate with AI
                  </h3>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center space-x-3">
                    <div className="flex-1 max-w-xs">
                      <CustomSelect
                        options={modelOptions}
                        value={genModel}
                        onChange={setGenModel}
                        placeholder="Select model..."
                      />
                    </div>
                  </div>
                  <textarea
                    value={genDescription}
                    onChange={(e) => setGenDescription(e.target.value)}
                    rows={4}
                    className="w-full bg-[var(--bg-app)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-light)] focus:border-[var(--accent-color)] focus:outline-none resize-y font-mono"
                    placeholder="Describe the skill you want the AI to generate. Be specific about its behavior, guidelines, and purpose..."
                  />
                  <button
                    onClick={() => {
                      if (genModel && genDescription) {
                        handleGenerateWithAI(genModel, genDescription);
                      }
                    }}
                    disabled={isGenerating}
                    className="flex items-center space-x-2 px-4 py-2 bg-[var(--color-secondary)] hover:opacity-85 disabled:opacity-50 text-[var(--color-secondary-foreground)] text-xs font-bold rounded-lg transition-colors"
                  >
                    <Wand2 size={14} />
                    <span>{isGenerating ? "Generating..." : "Generate"}</span>
                  </button>
                  {generateError && (
                    <p className="text-xs text-[var(--color-status-danger)] font-mono">{generateError}</p>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-xl p-8 flex flex-col items-center justify-center space-y-3 text-center">
              <Cpu size={32} className="text-[var(--text-muted)]" />
              <p className="text-sm text-[var(--text-muted)]">
                Select a skill to edit or create a new one
              </p>
              <button
                onClick={handleNewSkill}
                className="flex items-center space-x-2 px-4 py-2 bg-[var(--accent-color)] hover:bg-[var(--accent-color)]/80 text-[var(--color-primary-foreground)] text-xs font-bold rounded-lg transition-colors"
              >
                <Plus size={14} />
                <span>New Skill</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {showSavedModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-[var(--color-surface-sunken)] backdrop-blur-sm" />
          <div className="relative bg-[var(--bg-sidebar)] border border-[var(--accent-color)]/30 rounded-xl px-6 py-4 shadow-2xl shadow-[var(--accent-color)]/10 flex items-center space-x-3">
            <div className="w-8 h-8 rounded-full bg-[var(--color-status-success-bg)] flex items-center justify-center">
              <Save size={16} className="text-[var(--color-status-success)]" />
            </div>
            <span className="text-sm font-bold text-[var(--text-light)]">Changes have been saved</span>
          </div>
        </div>
      )}
    </div>
  );
};
