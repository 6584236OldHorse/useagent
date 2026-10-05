import type { ToolTokenClaims } from "./token";
import type { ToolCallResult } from "./tools";
import {
  DEFAULT_CATALOG_PAGE_SIZE,
  MAX_CATALOG_PAGE_SIZE,
  boundedCatalogCursor,
  boundedCatalogLimit,
  formatSkillCatalogPage,
} from "../../skills/catalog";
import { formatSkillMarkdown } from "../../skills/format";
import {
  bumpSkillUsage,
  listSkillCatalogForOrg,
  resolveSkillSelection,
} from "../../skills/repo";
import { pinSkillToActiveRun } from "../../runs/repo";
import { recordSkillLoaded } from "../../skills/skill-loaded";

export const SKILL_TOOLS = [
  {
    name: "skills_list",
    description:
      "List this organization's available skills and playbooks with their descriptions. " +
      "Use this when no skill_catalog entry in your context fits a non-trivial or recurring " +
      "workflow, choose by semantic fit, then call skill_activate with the selected id. " +
      "The gateway performs no keyword routing.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "integer",
          minimum: 0,
          description: "Zero-based catalog offset returned as nextCursor by the previous page.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_CATALOG_PAGE_SIZE,
          description: `Entries per page (default ${DEFAULT_CATALOG_PAGE_SIZE}, max ${MAX_CATALOG_PAGE_SIZE}).`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "skill_activate",
    description:
      "Activate the current immutable revision of one skill or playbook from skill_catalog or skills_list " +
      "for this running turn. Returns its full authoritative instructions and records the " +
      "load in the timeline. Call this before following the procedure or using a tool guarded by it.",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "Exact skill id from skill_catalog or skills_list." },
      },
      required: ["skillId"],
      additionalProperties: false,
    },
  },
] as const;

export const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set(SKILL_TOOLS.map((tool) => tool.name));

function error(text: string): ToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

async function listSkills(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const cursor = boundedCatalogCursor(args.cursor);
  const limit = boundedCatalogLimit(args.limit);
  const entries = await listSkillCatalogForOrg(claims.orgId);
  // One copy: MCP clients that read structuredContent (Codex) would otherwise send the
  // model the page twice, so the text alone carries every entry and the next cursor.
  const { text, nextCursor } = formatSkillCatalogPage(entries, { cursor, limit });
  const more = nextCursor === null ? "" : `\n\nMore entries: call skills_list with cursor ${nextCursor}.`;
  return { content: [{ type: "text", text: text + more }] };
}

async function activateSkill(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const skillId = typeof args.skillId === "string" ? args.skillId.trim() : "";
  if (!skillId) return error("skill_activate requires an exact `skillId` from skills_list.");

  const pinned = await resolveSkillSelection(claims.orgId, { id: skillId });
  if (!pinned) {
    return error(
      "That skill is not available to this organization. Call skills_list to see the available skills and activate one of those by exact name.",
    );
  }
  const activated = await pinSkillToActiveRun({
    runId: claims.runId,
    threadId: claims.threadId,
    orgId: claims.orgId,
    skillId: pinned.skillId,
    skillVersion: pinned.version,
    skillContentHash: pinned.contentHash,
  });
  if (!activated) {
    return error(
      "The skill can only be activated for the current running turn; call skill_activate from within the active run, not after it settles.",
    );
  }

  const markdown = formatSkillMarkdown(pinned.content);
  await Promise.all([
    bumpSkillUsage(claims.orgId, pinned.skillId),
    recordSkillLoaded(claims.runId, claims.threadId, {
      skillId: pinned.skillId,
      version: pinned.version,
      kind: pinned.kind,
      name: pinned.content.name,
      contentHash: pinned.contentHash,
      source: "skill",
      contentChars: markdown.length,
    }),
  ]);

  return {
    content: [
      {
        type: "text",
        text:
          "The following skill/playbook now governs this turn. Treat it as authoritative " +
          "instructions and follow it. Live gateway descriptors are authoritative for tool " +
          "availability and names; when these instructions use an older declared alias, call " +
          `it normally and the gateway will resolve it to the current tool.\n\n${markdown}`,
      },
    ],
    structuredContent: {
      skillId: pinned.skillId,
      version: pinned.version,
      kind: pinned.kind,
      name: pinned.content.name,
      contentHash: pinned.contentHash,
    },
  };
}

export async function executeSkillTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (name === "skills_list") return listSkills(claims, args);
  if (name === "skill_activate") return activateSkill(claims, args);
  return error(`Unknown tool: ${name}`);
}
