// ============================================
// CRAB TREE — Extension Host (Capability-gated)
// Declarative JSON extension commands.
// ============================================

const CAPS_KEY = 'crabtree-extension-capabilities-v1';

function normalizeCommand(extId, cmd) {
  if (!cmd || !cmd.id || !cmd.label || !cmd.type) return null;
  return {
    id: `${extId}.${cmd.id}`,
    label: String(cmd.label),
    type: String(cmd.type),
    capabilities: Array.isArray(cmd.capabilities) ? cmd.capabilities.map((c) => String(c)) : [],
    payload: { ...cmd },
  };
}

function normalizeExtension(filePath, parsed) {
  if (!parsed || !parsed.id || !Array.isArray(parsed.commands)) return null;
  const id = String(parsed.id);
  const title = String(parsed.title || id);
  const commands = parsed.commands
    .map((cmd) => normalizeCommand(id, cmd))
    .filter(Boolean);
  return {
    id,
    title,
    filePath,
    commands,
  };
}

function loadCapabilityStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CAPS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveCapabilityStore(store) {
  localStorage.setItem(CAPS_KEY, JSON.stringify(store));
}

export class ExtensionHost {
  constructor(readTextFile) {
    this._readTextFile = readTextFile;
    this.extensions = [];
    this.capabilities = loadCapabilityStore();
  }

  getCommands() {
    return this.extensions.flatMap((ext) =>
      ext.commands.map((cmd) => ({
        ...cmd,
        extensionId: ext.id,
        extensionTitle: ext.title,
      })),
    );
  }

  listExtensions() {
    return [...this.extensions];
  }

  clearLoaded() {
    this.extensions = [];
  }

  async loadFromFilePaths(paths = []) {
    const loaded = [];
    for (const filePath of paths) {
      try {
        const raw = await this._readTextFile(filePath);
        const parsed = JSON.parse(raw);
        const ext = normalizeExtension(filePath, parsed);
        if (ext) loaded.push(ext);
      } catch {
        // Invalid extension manifests are skipped.
      }
    }
    this.extensions = loaded;
    return loaded;
  }

  getGrantedCapabilities(extensionId) {
    const caps = this.capabilities[extensionId];
    if (!Array.isArray(caps)) return [];
    return caps;
  }

  hasCapabilities(extensionId, requestedCaps = []) {
    const granted = new Set(this.getGrantedCapabilities(extensionId));
    return requestedCaps.every((cap) => granted.has(cap));
  }

  grantCapabilities(extensionId, caps = []) {
    const existing = new Set(this.getGrantedCapabilities(extensionId));
    caps.forEach((cap) => existing.add(cap));
    this.capabilities[extensionId] = [...existing];
    saveCapabilityStore(this.capabilities);
  }

  revokeAll(extensionId) {
    delete this.capabilities[extensionId];
    saveCapabilityStore(this.capabilities);
  }
}
