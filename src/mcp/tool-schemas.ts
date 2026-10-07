import { z } from "zod";

const safeText = (maximum: number) => z
  .string()
  .trim()
  .min(1)
  .max(maximum)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Control characters are not allowed");

const stableId = (namespace: "project" | "workstream" | "session" | "event" | "chunk") =>
  z.string().regex(new RegExp(`^ku::${namespace}:[a-f0-9]{64}$`), `Invalid ${namespace} ID`);

export const scopeInputSchema = z.strictObject({
  projectId: stableId("project"),
  workstreamId: stableId("workstream").optional(),
  sessionId: stableId("session").optional(),
});

export const listContextScopesInputSchema = z.strictObject({
  query: safeText(256).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

export const getContextOverviewInputSchema = z.strictObject({
  scope: scopeInputSchema,
  maxTokens: z.number().int().min(128).max(3_000).optional(),
});

export const searchMemoryInputSchema = z.strictObject({
  query: safeText(2_048),
  scope: scopeInputSchema.optional(),
  scopeQuery: safeText(256).optional(),
  intent: z.enum([
    "exact_identifier",
    "exact_error",
    "decision_rationale",
    "debugging_history",
    "chronology",
    "open_items",
    "latest_state",
    "broad_synthesis",
    "general",
  ]).optional(),
  memoryTypes: z.array(z.enum([
    "session_synopsis",
    "workstream_synopsis",
    "project_synopsis",
    "decision",
    "episode",
    "semantic_fact",
    "open_item",
  ])).max(7).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  paths: z.array(safeText(4_096)).max(16).optional(),
  branch: safeText(512).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  maxTokens: z.number().int().min(128).max(6_000).optional(),
  cursor: safeText(4_096).optional(),
}).superRefine((input, context) => {
  if (input.scope !== undefined && input.scopeQuery !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["scopeQuery"],
      message: "scope and scopeQuery are mutually exclusive",
    });
  }
  if (input.from !== undefined && input.to !== undefined && input.from > input.to) {
    context.addIssue({
      code: "custom",
      path: ["from"],
      message: "from must not be later than to",
    });
  }
});

export const getEvidenceInputSchema = z.strictObject({
  evidenceIds: z.array(z.union([stableId("event"), stableId("chunk")])).min(1).max(5),
  scope: scopeInputSchema.optional(),
  beforeEvents: z.number().int().min(0).max(20).optional(),
  afterEvents: z.number().int().min(0).max(20).optional(),
  maxTokens: z.number().int().min(128).max(5_000).optional(),
});

export type ListContextScopesToolInput = z.infer<typeof listContextScopesInputSchema>;
export type GetContextOverviewToolInput = z.infer<typeof getContextOverviewInputSchema>;
export type SearchMemoryToolInput = z.infer<typeof searchMemoryInputSchema>;
export type GetEvidenceToolInput = z.infer<typeof getEvidenceInputSchema>;
