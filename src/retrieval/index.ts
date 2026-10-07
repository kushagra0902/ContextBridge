export { classifyQuery, normalizeRetrievalQuery } from "./intent.js";
export { resolveScope, type ResolveScopeInput } from "./resolve-scope.js";
export {
  retrieveLexical,
  type LexicalRetrievalDependencies,
  type LexicalRetrievalInput,
} from "./lexical.js";
export {
  retrieveSemantic,
  type SemanticCandidate,
  type SemanticRetrievalDependencies,
  type SemanticRetrievalInput,
  type SemanticRetrievalResult,
} from "./semantic.js";
export { fuseCandidates, type FusedCandidate, type FuseOptions } from "./fuse.js";
export {
  validateHits,
  type HitValidationDependencies,
  type HitValidationInput,
} from "./validate-hits.js";
export { diversifyHits } from "./diversify.js";
export { orderByChronology } from "./chronology.js";
export {
  expandEvidence,
  type EvidenceExpansionDependencies,
  type EvidenceExpansionOptions,
  type ExpandedEvidenceChunk,
  type ExpandedEvidenceEvent,
  type ExpandedEvidenceResult,
} from "./evidence.js";
export {
  decodeSearchCursor,
  encodeSearchCursor,
  packSearchHits,
  type PackedSearchHits,
  type PackSearchOptions,
} from "./pack.js";
