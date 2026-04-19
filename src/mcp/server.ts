/**
 * MCP stdio server: exposes Vault Maker knowledge tools for a single vault.
 * Set VAULT_PATH to an absolute path of the Obsidian vault (same as the web UI).
 *
 * Run: npx tsx src/mcp/server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  getGraphJson,
  listAtomsJson,
  listSourcesJson,
  getChunkJson,
  retrieveChunksJson,
  rebuildGraphJson,
} from "./knowledgeTools.js";

function requireVaultPath(): string {
  const p = process.env.VAULT_PATH?.trim();
  if (!p) {
    throw new Error("Set VAULT_PATH to your vault directory (absolute path).");
  }
  return p;
}

async function main(): Promise<void> {
  const vaultPath = requireVaultPath();

  const server = new McpServer({
    name: "vaultmaker-knowledge",
    version: "1.0.0",
  });

  server.registerTool(
    "vaultmaker_get_graph",
    {
      description: "Read the machine-readable knowledge graph (.vaultmaker/graph.json) for the configured vault.",
      inputSchema: z.object({}),
    },
    async () => {
      const graph = await getGraphJson(vaultPath);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      };
    }
  );

  server.registerTool(
    "vaultmaker_list_atoms",
    {
      description: "List atoms from .vaultmaker/atoms.json with optional filters.",
      inputSchema: z.object({
        sourceId: z.string().optional(),
        kind: z.string().optional(),
      }),
    },
    async ({ sourceId, kind }) => {
      const data = await listAtomsJson(vaultPath, { sourceId, kind });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "vaultmaker_list_sources",
    {
      description: "List staged source metadata from .vaultmaker/sources/.",
      inputSchema: z.object({}),
    },
    async () => {
      const data = await listSourcesJson(vaultPath);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "vaultmaker_get_chunk",
    {
      description: "Get one text chunk by chunk id (format: {sourceId}-c{index}).",
      inputSchema: z.object({
        chunkId: z.string(),
      }),
    },
    async ({ chunkId }) => {
      const data = await getChunkJson(vaultPath, chunkId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "vaultmaker_retrieve_chunks",
    {
      description: "Hybrid retrieval over chunk embeddings (and keyword fallback).",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().positive().max(50).optional(),
        sourceId: z.string().optional(),
        useEmbeddings: z.boolean().optional(),
      }),
    },
    async ({ query, limit, sourceId, useEmbeddings }) => {
      const data = await retrieveChunksJson(
        vaultPath,
        query,
        limit ?? 10,
        sourceId,
        useEmbeddings
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "vaultmaker_rebuild_graph",
    {
      description: "Rebuild graph.json from atoms and note Relationship:: links.",
      inputSchema: z.object({}),
    },
    async () => {
      const data = await rebuildGraphJson(vaultPath);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
