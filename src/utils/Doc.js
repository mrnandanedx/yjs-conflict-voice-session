/**
 * @module Y
 */

import {
  StructStore,
  transact,
  applyUpdate,
  ContentDoc, Item, Transaction, // eslint-disable-line
  encodeStateAsUpdate,
  findRootTypeKey
} from '../internals.js'

import { YType } from '../ytype.js'
import { ObservableV2 } from 'lib0/observable'
import * as random from 'lib0/random'
import * as map from 'lib0/map'
import * as array from 'lib0/array'
import * as promise from 'lib0/promise'

export const generateNewClientId = random.uint32

/**
 * @typedef {Object} DocOpts
 * @property {boolean} [DocOpts.gc=true] Disable garbage collection (default: gc=true)
 * @property {function(Item):boolean} [DocOpts.gcFilter] Will be called before an Item is garbage collected. Return false to keep the Item.
 * @property {string} [DocOpts.guid] Define a globally unique identifier for this document
 * @property {string | null} [DocOpts.collectionid] Associate this document with a collection. This only plays a role if your provider has a concept of collection.
 * @property {any} [DocOpts.meta] Any kind of meta information you want to associate with this document. If this is a subdocument, remote peers will store the meta information as well.
 * @property {boolean} [DocOpts.autoLoad] If a subdocument, automatically load document. If this is a subdocument, remote peers will load the document as well automatically.
 * @property {boolean} [DocOpts.shouldLoad] Whether the document should be synced by the provider now. This is toggled to true when you call ydoc.load()
 * @property {boolean} [DocOpts.isSuggestionDoc] Set to true if this document merely suggests
 * changes. If this flag is not set in a suggestion document, automatic formatting changes will be
 * displayed as suggestions, which might not be intended.
 * @property {MapConflictPolicy} [DocOpts.mapConflictPolicy='allow'] How to handle a map key that is
 * written twice in one transaction, or by two clients that didn't see each other's write.
 */

/**
 * - `allow`: apply every write and record nothing.
 * - `record`: apply every write and record the conflict.
 * - `error`: throw a `MapConflictError` and record the conflict. The repeated local write or the
 * whole incoming update is not applied. Refusing an update gives up convergence, because this doc
 * stops matching peers that accepted the update.
 *
 * @typedef {'allow'|'record'|'error'} MapConflictPolicy
 */

/**
 * Describes who wrote what to a map key.
 *
 * @typedef {Object} MapWriteSnapshot
 * @property {number} MapWriteSnapshot.clientID The client that wrote the key.
 * @property {'set'|'delete'} MapWriteSnapshot.operation The operation.
 * @property {any} MapWriteSnapshot.value The written value. `undefined` for a delete.
 * @property {any} MapWriteSnapshot.origin The origin of the transaction that handled the write.
 * @property {number} MapWriteSnapshot.time Unix time in milliseconds when this doc saw the write.
 * @property {string} MapWriteSnapshot.summary A readable description of the write.
 */

/**
 * Counts the recorded map conflicts.
 *
 * @typedef {Object} MapConflictSummary
 * @property {number} MapConflictSummary.count The number of recorded conflicts.
 * @property {Object<string,number>} MapConflictSummary.byType Conflicts by `type`.
 * @property {Object<string,number>} MapConflictSummary.byKey Conflicts by map key.
 * @property {Object<string,number>} MapConflictSummary.byParent Conflicts by `parent`.
 * @property {Object<string,number>} MapConflictSummary.bySource Conflicts by `source`.
 */

/**
 * Two writes to the same map key.
 *
 * @typedef {Object} MapConflict
 * @property {'set-set'|'delete-set'} MapConflict.type `delete-set` if one of the writes is a delete,
 * in either order.
 * @property {string} MapConflict.key The map key.
 * @property {string} MapConflict.parent The name of a top-level parent, or `client:clock` of a
 * nested parent.
 * @property {'local'|'remote'|'mixed'} MapConflict.source `local` for a repeated write in one
 * transaction, `mixed` if this client wrote one of two concurrent writes, and `remote` if other
 * clients wrote both.
 * @property {string} MapConflict.message A readable description of the conflict.
 * @property {MapWriteSnapshot} MapConflict.writeA The earlier write of a local conflict, or the
 * write of the lower client id of a concurrent conflict.
 * @property {MapWriteSnapshot} MapConflict.writeB The other write.
 * @property {{winner:'writeA'|'writeB',strategy:'deterministic'}} MapConflict.resolution The write
 * that wins. If an incoming update was refused, this is the write that wins when peers merge it.
 * @property {boolean} MapConflict.ambiguous Whether a value is a shared type or a subdocument. These
 * values hold their own content, so comparing the two writes doesn't tell what was lost.
 */

/**
 * @param {any} value
 * @return {string}
 */
const describeMapValue = value => {
  if (value instanceof YType) return 'a shared type'
  if (value instanceof Doc) return 'a subdocument'
  if (value instanceof Uint8Array) return `${value.length} bytes`
  if (typeof value === 'bigint') return `${value}n`
  let json
  try {
    json = JSON.stringify(value) ?? String(value)
  } catch (_err) {
    json = String(value)
  }
  return json.length > 80 ? `${json.slice(0, 77)}...` : json
}

/**
 * @param {string} key
 * @param {'set'|'delete'} operation
 * @param {any} value
 * @param {number} clientID
 * @param {any} origin
 * @param {number} time
 * @return {MapWriteSnapshot}
 */
export const createMapWriteSnapshot = (key, operation, value, clientID, origin, time) => ({
  clientID,
  operation,
  value,
  origin,
  time,
  summary: operation === 'delete'
    ? `client ${clientID} deleted "${key}"`
    : `client ${clientID} set "${key}" to ${describeMapValue(value)}`
})

/**
 * @param {'local'|'remote'|'mixed'} source
 * @param {string} key
 * @param {string} parent
 * @param {MapWriteSnapshot} writeA
 * @param {MapWriteSnapshot} writeB
 * @param {'writeA'|'writeB'} winner
 * @return {MapConflict}
 */
export const createMapConflict = (source, key, parent, writeA, writeB, winner) => ({
  type: writeA.operation === 'set' && writeB.operation === 'set' ? 'set-set' : 'delete-set',
  key,
  parent,
  source,
  message: `${source === 'local' ? 'Map key written twice in one transaction' : 'Concurrent writes to a map key'}: ${writeA.summary} and ${writeB.summary} in "${parent}"`,
  writeA,
  writeB,
  resolution: { winner, strategy: 'deterministic' },
  ambiguous: [writeA.value, writeB.value].some(v => v instanceof YType || v instanceof Doc)
})

/**
 * @param {YType<any>} parent
 * @return {string} The name of a top-level type, or `client:clock` of a nested type.
 */
export const getMapParentName = parent => parent._item === null
  ? findRootTypeKey(parent)
  : `${parent._item.id.client}:${parent._item.id.clock}`

/**
 * Thrown when `doc.mapConflictPolicy` is `error` and a transaction writes to a map key more than
 * once, or an incoming update has conflicting writes.
 */
export class MapConflictError extends Error {
  /**
   * @param {MapConflict} conflict
   * @param {Array<MapConflict>} [conflicts] All conflicts that caused this error.
   */
  constructor (conflict, conflicts = [conflict]) {
    super(conflict.message)
    this.name = 'MapConflictError'
    /**
     * @type {MapConflict}
     */
    this.conflict = conflict
    /**
     * @type {Array<MapConflict>}
     */
    this.conflicts = conflicts
  }
}

/**
 * @typedef {Object} DocEvents
 * @property {function(Doc):void} DocEvents.destroy
 * @property {function(Doc):void} DocEvents.load
 * @property {function(boolean, Doc):void} DocEvents.sync
 * @property {function(Uint8Array<ArrayBuffer>, any, Doc, Transaction):void} DocEvents.update
 * @property {function(Uint8Array<ArrayBuffer>, any, Doc, Transaction):void} DocEvents.updateV2
 * @property {function(Doc):void} DocEvents.beforeAllTransactions
 * @property {function(Transaction, Doc):void} DocEvents.beforeTransaction
 * @property {function(Transaction, Doc):void} DocEvents.beforeObserverCalls
 * @property {function(Transaction, Doc):void} DocEvents.afterTransaction
 * @property {function(Transaction, Doc):void} DocEvents.afterTransactionCleanup
 * @property {function(Doc, Array<Transaction>):void} DocEvents.afterAllTransactions
 * @property {function({ loaded: Set<Doc>, added: Set<Doc>, removed: Set<Doc> }, Doc, Transaction):void} DocEvents.subdocs
 */

/**
 * A Yjs instance handles the state of shared data.
 * @extends ObservableV2<DocEvents>
 */
export class Doc extends ObservableV2 {
  /**
   * @param {DocOpts} opts configuration
   */
  constructor ({ guid = random.uuidv4(), collectionid = null, gc = true, gcFilter = () => true, meta = null, autoLoad = false, shouldLoad = true, isSuggestionDoc = false, mapConflictPolicy = 'allow' } = {}) {
    super()
    if (mapConflictPolicy !== 'allow' && mapConflictPolicy !== 'record' && mapConflictPolicy !== 'error') {
      throw new Error(`Unknown mapConflictPolicy: ${mapConflictPolicy}`)
    }
    /**
     * @type {MapConflictPolicy}
     */
    this.mapConflictPolicy = mapConflictPolicy
    /**
     * Remote conflicts that were already recorded, by the id of the losing write.
     *
     * @type {Map<string,MapConflict>}
     */
    this._recordedRemoteMapConflicts = new Map()
    /**
     * Every map write that lost a conflict, oldest first. This log is kept in memory on this doc
     * instance. It is not synced or persisted.
     *
     * @type {Array<MapConflict>}
     */
    this._mapConflicts = []
    this.gc = gc
    this.gcFilter = gcFilter
    this.clientID = generateNewClientId()
    this.guid = guid
    this.collectionid = collectionid
    this.isSuggestionDoc = isSuggestionDoc
    this.cleanupFormatting = !isSuggestionDoc
    /**
     * @type {Map<string, YType>}
     */
    this.share = new Map()
    this.store = new StructStore()
    /**
     * @type {Transaction | null}
     */
    this._transaction = null
    /**
     * @type {Array<Transaction>}
     */
    this._transactionCleanups = []
    /**
     * @type {Set<Doc>}
     */
    this.subdocs = new Set()
    /**
     * If this document is a subdocument - a document integrated into another document - then _item is defined.
     * @type {Item?}
     */
    this._item = null
    this.shouldLoad = shouldLoad
    this.autoLoad = autoLoad
    this.meta = meta
    /**
     * This is set to true when the persistence provider loaded the document from the database or when the `sync` event fires.
     * Note that not all providers implement this feature. Provider authors are encouraged to fire the `load` event when the doc content is loaded from the database.
     *
     * @type {boolean}
     */
    this.isLoaded = false
    /**
     * This is set to true when the connection provider has successfully synced with a backend.
     * Note that when using peer-to-peer providers this event may not provide very useful.
     * Also note that not all providers implement this feature. Provider authors are encouraged to fire
     * the `sync` event when the doc has been synced (with `true` as a parameter) or if connection is
     * lost (with false as a parameter).
     */
    this.isSynced = false
    this.isDestroyed = false
    /**
     * Promise that resolves once the document has been loaded from a persistence provider.
     */
    this.whenLoaded = promise.create(resolve => {
      this.on('load', () => {
        this.isLoaded = true
        resolve(this)
      })
    })
    const provideSyncedPromise = () => promise.create(resolve => {
      /**
       * @param {boolean} isSynced
       */
      const eventHandler = (isSynced) => {
        if (isSynced === undefined || isSynced === true) {
          this.off('sync', eventHandler)
          resolve()
        }
      }
      this.on('sync', eventHandler)
    })
    this.on('sync', isSynced => {
      if (isSynced === false && this.isSynced) {
        this.whenSynced = provideSyncedPromise()
      }
      this.isSynced = isSynced === undefined || isSynced === true
      if (this.isSynced && !this.isLoaded) {
        this.emit('load', [this])
      }
    })
    /**
     * Promise that resolves once the document has been synced with a backend.
     * This promise is recreated when the connection is lost.
     * Note the documentation about the `isSynced` property.
     */
    this.whenSynced = provideSyncedPromise()
  }

  /**
   * Notify the parent document that you request to load data into this subdocument (if it is a subdocument).
   *
   * `load()` might be used in the future to request any provider to load the most current data.
   *
   * It is safe to call `load()` multiple times.
   */
  load () {
    const item = this._item
    if (item !== null && !this.shouldLoad) {
      transact(/** @type {any} */ (item.parent).doc, transaction => {
        transaction.subdocsLoaded.add(this)
      }, null, true)
    }
    this.shouldLoad = true
  }

  getSubdocs () {
    return this.subdocs
  }

  getSubdocGuids () {
    return new Set(array.from(this.subdocs).map(doc => doc.guid))
  }

  /**
   * Changes that happen inside of a transaction are bundled. This means that
   * the observer fires _after_ the transaction is finished and that all changes
   * that happened inside of the transaction are sent as one message to the
   * other peers.
   *
   * @template T
   * @param {function(Transaction):T} f The function that should be executed as a transaction
   * @param {any} [origin] Origin of who started the transaction. Will be stored on transaction.origin
   * @return T
   *
   * @public
   */
  transact (f, origin = null) {
    return transact(this, f, origin)
  }

  /**
   * Define a shared data type.
   *
   * Multiple calls of `ydoc.get(name)` yield the same result
   * and do not overwrite each other. I.e.
   * `ydoc.get(name) === ydoc.get(name)`
   *
   * After this method is called, the type is also available on `ydoc.share.get(name)`.
   *
   * @param {string} key
   * @param {string?} name Type-name
   *
   * @return {YType}
   */
  get (key = '', name = null) {
    return map.setIfUndefined(this.share, key, () => {
      const t = new YType(name)
      t._integrate(this, null)
      return t
    })
  }

  /**
   * Lists the recorded map conflicts, oldest first. The list is empty if the policy is `allow`.
   *
   * @return {Array<MapConflict>}
   */
  getMapConflicts () {
    return this.mapConflictPolicy === 'allow' ? [] : this._mapConflicts.slice()
  }

  /**
   * Counts the conflicts returned by `getMapConflicts`.
   *
   * @return {MapConflictSummary}
   */
  getMapConflictSummary () {
    const conflicts = this.getMapConflicts()
    // Keys come from remote peers. Without a prototype, a key like `__proto__` is counted as usual.
    /**
     * @type {MapConflictSummary}
     */
    const summary = {
      count: conflicts.length,
      byType: Object.create(null),
      byKey: Object.create(null),
      byParent: Object.create(null),
      bySource: Object.create(null)
    }
    /**
     * @param {Object<string,number>} counts
     * @param {string} name
     */
    const increment = (counts, name) => {
      counts[name] = (counts[name] || 0) + 1
    }
    conflicts.forEach(({ type, key, parent, source }) => {
      increment(summary.byType, type)
      increment(summary.byKey, key)
      increment(summary.byParent, parent)
      increment(summary.bySource, source)
    })
    return summary
  }

  /**
   * Converts the entire document into a js object, recursively traversing each yjs type
   * Doesn't log types that have not been defined (using ydoc.getType(..)).
   *
   * @deprecated Do not use this method and rather call toJSON directly on the shared types.
   *
   * @return {Object<string, any>}
   */
  toJSON () {
    /**
     * @type {Object<string, any>}
     */
    const doc = {}
    this.share.forEach((value, key) => {
      doc[key] = value.toJSON()
    })
    return doc
  }

  /**
   * Emit `destroy` event and unregister all event handlers.
   */
  destroy () {
    this.isDestroyed = true
    array.from(this.subdocs).forEach(subdoc => subdoc.destroy())
    const item = this._item
    if (item !== null) {
      this._item = null
      const content = /** @type {ContentDoc} */ (item.content)
      content.doc = new Doc({ guid: this.guid, ...content.opts, shouldLoad: false })
      content.doc._item = item
      transact(/** @type {any} */ (item).parent.doc, transaction => {
        const doc = content.doc
        if (!item.deleted) {
          transaction.subdocsAdded.add(doc)
        }
        transaction.subdocsRemoved.add(this)
      }, null, true)
    }
    // @ts-ignore
    this.emit('destroyed', [true]) // DEPRECATED!
    this.emit('destroy', [this])
    super.destroy()
  }
}

/**
 * @param {Doc} ydoc
 * @param {DocOpts} [opts]
 */
export const cloneDoc = (ydoc, opts) => {
  const clone = new Doc(opts)
  applyUpdate(clone, encodeStateAsUpdate(ydoc))
  return clone
}
