import type { ToolExecutor, ToolExecResult, ToolExecutionContext } from "../agent/tool-executor.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { StructuredToolOutput } from "./schemas.js";

function isStructuredToolOutput(value: unknown): value is StructuredToolOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    "output" in value &&
    "isError" in value &&
    typeof (value as { isError?: unknown }).isError === "boolean"
  );
}

export class ToolRuntime implements ToolExecutor {
  constructor(private registry: ToolRegistry) {}

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    sessionId: string,
    context?: ToolExecutionContext,
  ): Promise<ToolExecResult> {
    const tool = this.registry.get(toolName);
    if (!tool) {
      return {
        toolCallId: "",
        toolName,
        output: `Unknown tool: ${toolName}`,
        isError: true,
      };
    }

    try {
      if (context?.permissionBroker) {
        const policyInput = {
          sessionId,
          tool,
          args,
          ...(context.toolUseId !== undefined ? { toolUseId: context.toolUseId } : {}),
          ...(context.branchId !== undefined ? { branchId: context.branchId } : {}),
          ...(context.source !== undefined ? { source: context.source } : {}),
          ...(context.pathSandbox !== undefined ? { pathSandbox: context.pathSandbox } : {}),
        };
        const authorization = await context.permissionBroker.authorize(
          policyInput,
          context.signal,
        );
        if (!authorization.allowed) {
          return {
            toolCallId: context.toolUseId ?? "",
            toolName,
            output: authorization.message,
            isError: true,
          };
        }
      }

      const output = await tool.handler(args, sessionId, context);
      if (isStructuredToolOutput(output)) {
        return {
          toolCallId: context?.toolUseId ?? "",
          toolName,
          output: output.output,
          isError: output.isError,
        };
      }
      return {
        toolCallId: context?.toolUseId ?? "",
        toolName,
        output,
        isError: false,
      };
    } catch (err) {
      return {
        toolCallId: context?.toolUseId ?? "",
        toolName,
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }
}
