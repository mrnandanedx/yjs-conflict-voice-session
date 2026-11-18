/**
 * @module Y
 */

import {
  StructStore,
  transact,
  applyUpdate,
  ContentDoc, Item, Transaction, // eslint-disable-line
  encodeStateAsUpdate
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
 * @property {MapConflictStrategy} [DocOpts.mapConflict='overwrite'] How to handle a local write to
 * a map key that was already written in the same transaction.
 * @property {RemoteMapConflictStrategy} [DocOpts.remoteMapConflict='ignore'] How to handle an
 * incoming update in which two clients wrote the same map key without seeing each other's write.
 */

/**
 * - `ignore`: merge the update and log nothing.
 * - `record`: merge the update and log the conflict on `doc.mapConflicts`.
 * - `refuse`: apply nothing from the update, log the conflict, and throw a `MapConflictError`.
 * - `discard`: apply nothing from the update and log the conflict, without throwing.
 *
 * `refuse` and `discard` give up convergence: this doc stops matching peers that accepted the update.
 *
 * @typedef {'ignore'|'record'|'refuse'|'discard'} RemoteMapConflictStrategy
 */

/**
 * - `overwrite`: the last write wins.
 * - `keep-first`: the first write wins. Later writes to that key are ignored.
 * - `error`: later writes to that key throw an error.
 *
 * @typedef {'overwrite'|'keep-first'|'error'} MapConflictStrategy
 */

/**
 * Describes who wrote what to a map key.
 *
 * @typedef {Object} MapWrite
 * @property {'set'|'delete'} MapWrite.operation The attempted operation.
 * @property {any} MapWrite.value The written value. `undefined` for a delete.
 * @property {number} MapWrite.clientID The client that attempted the write.
 * @property {any} MapWrite.origin The origin of the transaction.
 * @property {number} MapWrite.time Unix time in milliseconds of the write.
 */

/**
 * All refused writes to one key of one map, next to the writes that were kept instead.
 *
 * @typedef {Object} MapConflictSummary
 * @property {YType<any>|null} MapConflictSummary.type The type that owns the key. `null` if this
 * doc doesn't know the type.
 * @property {string|null} MapConflictSummary.mapName The name of the type if it is a top-level
 * type. `null` if the type is nested.
 * @property {string} MapConflictSummary.key The map key.
 * @property {number} MapConflictSummary.refusedCount The number of refused writes.
 * @property {boolean} MapConflictSummary.ambiguous Whether any conflict on this key is ambiguous.
 * @property {Array<MapWrite & { status: 'kept'|'refused'|'lost' }>} MapConflictSummary.writes Every
 * kept, refused, and lost write, oldest first. A `lost` write was merged, but another client's
 * write to the key won.
 */

/**
 * Describes a map write that lost a conflict. `source` is `local` for a repeated write in one
 * transaction, and `remote` for concurrent writes by two clients found in an incoming update.
 *
 * @typedef {Object} MapConflict
 * @property {'local'|'remote'} MapConflict.source Where the conflict was detected.
 * @property {string} MapConflict.key The map key that was written more than once.
 * @property {YType<any>|null} MapConflict.type The type that owns the key. `null` if this doc
 * doesn't know the type because the update that creates it was not applied.
 * @property {'set'|'delete'} MapConflict.operation The losing operation.
 * @property {any} MapConflict.value The losing value. `undefined` for a delete.
 * @property {any} MapConflict.currentValue The value of the key when the conflict was detected.
 * @property {'keep-first'|'error'|'record'|'refuse'|'discard'} MapConflict.strategy The strategy
 * that handled the conflict.
 * @property {any} MapConflict.origin The origin of the transaction.
 * @property {number} MapConflict.clientID The client that wrote the losing value.
 * @property {number} MapConflict.time Unix time in milliseconds when the conflict was detected.
 * @property {MapWrite|null} MapConflict.accepted The write that was kept. `null` if the key has no
 * value on this doc because the whole update was refused.
 * @property {boolean} MapConflict.ambiguous Whether the losing or the kept value is a shared type
 * or a subdocument. These values hold their own content, so comparing the two writes doesn't tell
 * what was lost.
 */

/**
 * @param {any} value The losing value.
 * @param {MapWrite|null} accepted The write that was kept.
 * @return {boolean}
 */
export const isAmbiguousMapConflict = (value, accepted) =>
  [value, accepted?.value].some(v => v instanceof YType || v instanceof Doc)

/**
 * Thrown when `doc.mapConflict` is `error` and a transaction writes to a map key more than once,
 * or when `doc.remoteMapConflict` is `refuse` and an incoming update has conflicting writes.
 */
export class MapConflictError extends Error {
  /**
   * @param {MapConflict} conflict
   * @param {Array<MapConflict>} [conflicts] All conflicts that caused this error.
   */
  constructor (conflict, conflicts = [conflict]) {
    super(conflict.source === 'remote'
      ? `Refused update: client ${conflict.clientID} wrote map key "${conflict.key}" concurrently with another client`
      : `Refused ${conflict.operation} on map key "${conflict.key}": the key was already written in this transaction`)
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
  constructor ({ guid = random.uuidv4(), collectionid = null, gc = true, gcFilter = () => true, meta = null, autoLoad = false, shouldLoad = true, isSuggestionDoc = false, mapConflict = 'overwrite', remoteMapConflict = 'ignore' } = {}) {
    super()
    if (mapConflict !== 'overwrite' && mapConflict !== 'keep-first' && mapConflict !== 'error') {
      throw new Error(`Unknown mapConflict strategy: ${mapConflict}`)
    }
    if (remoteMapConflict !== 'ignore' && remoteMapConflict !== 'record' && remoteMapConflict !== 'refuse' && remoteMapConflict !== 'discard') {
      throw new Error(`Unknown remoteMapConflict strategy: ${remoteMapConflict}`)
    }
    /**
     * @type {RemoteMapConflictStrategy}
     */
    this.remoteMapConflict = remoteMapConflict
    /**
     * Remote conflicts that were already logged, by the id of the losing write.
     *
     * @type {Map<string,MapConflict>}
     */
    this._loggedRemoteMapConflicts = new Map()
    /**
     * @type {MapConflictStrategy}
     */
    this.mapConflict = mapConflict
    /**
     * Every map write that lost a conflict, oldest first. This log is kept in memory on this doc
     * instance. It is not synced or persisted.
     *
     * @type {Array<MapConflict>}
     */
    this.mapConflicts = []
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
   * Summarizes `doc.mapConflicts`, with one entry per map and key, in order of first conflict.
   *
   * @return {Array<MapConflictSummary>}
   */
  getMapConflictSummary () {
    /**
     * @type {Array<MapConflictSummary>}
     */
    const summary = []
    /**
     * @type {Map<YType<any>|null, Map<string, MapConflictSummary>>}
     */
    const groups = new Map()
    /**
     * @type {Set<MapWrite>}
     */
    const listedAccepted = new Set()
    this.mapConflicts.forEach(({ type, key, operation, value, clientID, origin, time, accepted, strategy, ambiguous }) => {
      const group = map.setIfUndefined(map.setIfUndefined(groups, type, () => /** @type {Map<string, MapConflictSummary>} */ (new Map())), key, () => {
        const rootEntry = array.from(this.share.entries()).find(([, rootType]) => rootType === type)
        /**
         * @type {MapConflictSummary}
         */
        const created = { type, mapName: rootEntry ? rootEntry[0] : null, key, refusedCount: 0, ambiguous: false, writes: [] }
        summary.push(created)
        return created
      })
      if (accepted !== null && !listedAccepted.has(accepted)) {
        listedAccepted.add(accepted)
        group.writes.push({ status: 'kept', ...accepted })
      }
      group.refusedCount++
      group.ambiguous = group.ambiguous || ambiguous
      group.writes.push({ status: strategy === 'record' ? 'lost' : 'refused', operation, value, clientID, origin, time })
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
