// MCP tools for resources: the agent can see what the user keeps per account set and add to it.
import { createReadStream, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { ToolError, type Tool } from "../api/errors.ts";
import type { Store } from "../db.ts";
import { saveUpload } from "../posts.ts";
import { resourceSets, resourceView, setIdFrom } from "./routes.ts";
import type { ResourceStore } from "./store.ts";

const USE = "Resources are used only when an edit tags them: resources: [{tag}] on create_edit, or @tag in its instructions.";

export function resourceTools(store: Store, rs: ResourceStore): Tool[] {
  const optString = (args: Record<string, unknown>, key: string) => {
    const v = args[key];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") throw new ToolError(`${key} must be a string`);
    return v;
  };
  return [
    {
      name: "list_resources",
      title: "List resources",
      description: `Lists the user's resources per account set. These are text, audio, image and video files, each with an @tag. ${USE}`,
      inputSchema: { type: "object", properties: { account_set: { type: "string", description: "A set's name, no-space name or id. Omit for every set." } }, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        const want = optString(args, "account_set");
        let sets = resourceSets(store, rs);
        if (want) {
          const id = setIdFrom(store, want);
          if (typeof id === "string") throw new ToolError(id);
          sets = sets.filter((s) => s.id === id);
        }
        return { sets };
      },
    },
    {
      name: "add_resource",
      title: "Add a resource",
      description: `Adds a resource to a set. Give a file (.txt/.md, audio, PNG/JPEG/WebP or video) as file_path, or pasted text as text, not both. ${USE}`,
      inputSchema: {
        type: "object",
        properties: {
          account_set: { type: "string", description: "A set's name, no-space name or id. Omit for the default set." },
          file_path: { type: "string", description: "Absolute path of a file on this computer." },
          text: { type: "string", description: "Text to keep, up to 1 MB." },
          name: { type: "string" },
          tag: { type: "string", description: "Lowercase letters, digits and dashes (up to 32). Made from the name when omitted." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async run(args) {
        const setId = setIdFrom(store, optString(args, "account_set"));
        if (typeof setId === "string") throw new ToolError(setId);
        const path = optString(args, "file_path");
        const text = args.text === undefined || args.text === null ? undefined : String(args.text);
        if ((path === undefined) === (text === undefined)) throw new ToolError("give exactly one of file_path or text");
        const name = optString(args, "name");
        const tag = optString(args, "tag");
        let made;
        if (text !== undefined) {
          made = rs.addText(setId, name ?? "", text, tag);
        } else {
          if (!isAbsolute(path!)) throw new ToolError("file_path must be an absolute path");
          try { if (!statSync(path!).isFile()) throw new Error(); } catch { throw new ToolError(`no file at ${path}`); }
          const saved = await saveUpload(createReadStream(path!), path!);
          made = await rs.addFile(setId, saved.path, basename(path!), { name, tag });
        }
        if (typeof made === "string") throw new ToolError(made);
        return resourceView(rs, made);
      },
    },
  ];
}
