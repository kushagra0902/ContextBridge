// Just an entry point for all the necessary funcs from this section. 

export {
  CompressedObjectStore,
  type CompressedObjectStoreOptions,
  type ObjectId,
  type StoredObject,
  type StoredObjectEntry,
} from "./compressed-store.js";

export {
  collectOrphanObjects,
  type ObjectGcOptions,
  type ObjectGcResult,
} from "./gc.js";

