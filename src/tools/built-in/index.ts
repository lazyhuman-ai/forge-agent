import type { ToolRegistry } from "../tool-registry.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { bashTool } from "./bash-tool.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { webFetchTool } from "./web-fetch.js";
import { webSearchTool } from "./web-search.js";
import { memoryAddTool } from "./memory-add.js";
import { memorySearchTool } from "./memory-search.js";
import { memoryGetTool } from "./memory-get.js";
import { cronCreateTool } from "./cron-create.js";
import { cronListTool } from "./cron-list.js";
import { cronDeleteTool } from "./cron-delete.js";
import { askUserTool } from "./ask-user.js";
import { readArtifactTool } from "./read-artifact.js";
import { browserTools } from "./browser-tools.js";
import { extensionTools } from "./extension-tools.js";

export const builtInTools = [
  askUserTool,
  readArtifactTool,
  ...extensionTools,
  ...browserTools,
  readFileTool,
  writeFileTool,
  editFileTool,
  bashTool,
  globTool,
  grepTool,
  webFetchTool,
  webSearchTool,
  memoryAddTool,
  memorySearchTool,
  memoryGetTool,
  cronCreateTool,
  cronListTool,
  cronDeleteTool,
];

export function registerBuiltInTools(registry: ToolRegistry): void {
  for (const tool of builtInTools) {
    registry.register(tool);
  }
}
