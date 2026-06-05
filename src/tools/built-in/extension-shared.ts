import type { ExtensionManager } from "../../extensions/extension-manager.js";

let extensionManager: ExtensionManager | undefined;

export function setExtensionManagerForTools(manager: ExtensionManager): void {
  extensionManager = manager;
}

export function getExtensionManagerForTools(): ExtensionManager {
  if (!extensionManager) {
    throw new Error("Extension ecosystem is not initialized.");
  }
  return extensionManager;
}

export function formatExtensionValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

