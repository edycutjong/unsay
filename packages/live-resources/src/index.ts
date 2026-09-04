/**
 * @unsay/live-resources — the public entry point.
 *
 * Everything importable from this package is re-exported here, and nothing else is
 * supported: deep imports into `./src/*` are not part of the contract.
 */
export { LiveResourceStore } from './store.ts'
export type { ListedRecord, StoreOptions } from './store.ts'

export { AudiencePartition, AUDIENCES, DEFAULT_PARTITION } from './partition.ts'
export type { AudienceLane, ParsedUri, PartitionConfig } from './partition.ts'

export { AAD_SEPARATOR, hashVersion, recordAad } from './chain.ts'
export type { RecordIdentity } from './chain.ts'

export { ResourceNotifier } from './notifier.ts'
export type { NotificationTarget, NotifierOptions } from './notifier.ts'

export {
  LiveResourceError,
  NotFoundError,
  PartitionConfigError,
  ReservedSeparatorError,
} from './errors.ts'

export type { SealedDescription, ValueCodec } from './codec.ts'

export type {
  Annotations,
  AtRestReceipt,
  Audience,
  ChainVerdict,
  ListChangedListener,
  LiveRecord,
  Principal,
  PublishInput,
  Staleness,
  Unsubscribe,
  UpdatedListener,
} from './types.ts'
