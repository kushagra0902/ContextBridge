/**
 * Session persistence is implemented with project/workstream scopes in
 * projects.ts because the three records share referential checks and one public
 * ScopeRepository transaction boundary.
 */
export { getScope, upsertScopes } from "./projects.js";

