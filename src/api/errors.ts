/** An error the agent caused and can fix: reported as a tool result with isError, which the model reads. */
export class ToolError extends Error {}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  run(args: Record<string, unknown>): Promise<unknown>;
}
