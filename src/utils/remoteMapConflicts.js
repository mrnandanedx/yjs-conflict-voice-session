import {
  ContentDeleted,
  ContentType,
  Doc,
  Item,
  MapConflictError,
  UpdateEncoderV2,
  YType,
  applyUpdateV2,
  createID,
  createMapConflict,
  createMapWriteSnapshot,
  encodeStateAsUpdateV2,
  findRootTypeKey,
  getItem,
  getMapParentName,
  getState,
  writeBlockSet,
  BlockSet, GC, ID, Skip, Transaction // eslint-disable-line
} from '../internals.js'

import * as encoding from 'lib0/encoding'
import * as map from 'lib0/map'
import * as time from 'lib0/time'

/**
 * @typedef {Object} RemoteWrite
 * @property {ID} lastId The last id of the written item.
 * @property {import('./Doc.js').MapWriteSnapshot} write
 */

/**
 * Concurrent writes to one key that were found in an update, before it is integrated.
 *
 * @typedef {Object} RemoteMapConflict
 * @property {YType<any>|string} parent The type that owns the key, or a placeholder if it is unknown.
 * @property {string} key
 * @property {RemoteWrite|null} local The current local write, if the update doesn't build on it.
 * @property {Array<RemoteWrite>} incoming The concurrent writes in the update.
 */

/**
 * @param {BlockSet} blocks
 * @param {ID} id
 * @return {Item|GC|Skip|null}
 */
const findBlock = (blocks, id) => {
  const refs = blocks.clients.get(id.client)?.refs
  if (refs == null) return null
  let low = 0
  let high = refs.length - 1
  while (low <= high) {
    const mid = (low + high) >>> 1
    const block = refs[mid]
    if (id.clock < block.id.clock) {
      high = mid - 1
    } else if (id.clock >= block.id.clock + block.length) {
      low = mid + 1
    } else {
      return block
    }
  }
  return null
}

/**
 * @param {Doc} doc
 * @param {ID} id
 * @return {YType<any>|null} The shared type created by this id, if this doc knows it.
 */
const findTypeById = (doc, id) => {
  if (id.clock < getState(doc.store, id.client) && !doc.store.skips.hasId(id)) {
    const item = getItem(doc.store, id)
    if (item instanceof Item && item.content instanceof ContentType) {
      return item.content.type
    }
  }
  return null
}

/**
 * @param {Doc} doc
 * @param {string|ID|YType<any>} parent
 * @return {YType<any>|string}
 */
const resolveParent = (doc, parent) => {
  if (parent instanceof YType) return parent
  if (typeof parent === 'string') return doc.share.get(parent) ?? `root:${parent}`
  return findTypeById(doc, parent) ?? `id:${parent.client}:${parent.clock}`
}

/**
 * Finds the type of a conflict in `doc`, which may be a copy of the doc that found the conflict.
 *
 * @param {Doc} doc
 * @param {YType<any>|string} parent
 * @return {YType<any>|null}
 */
const findConflictParent = (doc, parent) => {
  if (parent instanceof YType) {
    return parent._item === null
      ? doc.share.get(findRootTypeKey(parent)) ?? null
      : findTypeById(doc, parent._item.id)
  }
  if (parent.startsWith('root:')) return doc.share.get(parent.slice(5)) ?? null
  const [, client, clock] = parent.split(':')
  return findTypeById(doc, createID(Number(client), Number(clock)))
}

/**
 * Finds the map entry an item writes to. Items only store their parent and key if they have no
 * origin. Otherwise this information is inherited from the origin.
 *
 * @param {Doc} doc
 * @param {BlockSet} blocks
 * @param {Item} item
 * @param {Map<Item,{parent:YType<any>|string,key:string}|null>} resolved
 * @return {{parent:YType<any>|string,key:string}|null} `null` if this is not a known map entry.
 */
const resolveMapEntry = (doc, blocks, item, resolved) => {
  /**
   * @type {Array<Item>}
   */
  const chain = []
  /**
   * @type {{parent:YType<any>|string,key:string}|null|undefined}
   */
  let entry
  let current = item
  while (entry === undefined) {
    if (resolved.has(current)) {
      entry = resolved.get(current)
      break
    }
    chain.push(current)
    if (current.parent !== null) {
      entry = current.parentSub === null
        ? null
        : { parent: resolveParent(doc, /** @type {any} */ (current.parent)), key: current.parentSub }
    } else if (current.origin === null) {
      entry = null
    } else {
      const origin = current.origin
      const block = findBlock(blocks, origin)
      if (block instanceof Item) {
        current = block
      } else if (block !== null || origin.clock >= getState(doc.store, origin.client) || doc.store.skips.hasId(origin)) {
        entry = null
      } else {
        const stored = getItem(doc.store, origin)
        entry = stored instanceof Item && stored.parent !== null && stored.parentSub !== null
          ? { parent: /** @type {YType<any>} */ (stored.parent), key: stored.parentSub }
          : null
      }
    }
  }
  const result = entry ?? null
  chain.forEach(chained => resolved.set(chained, result))
  return result
}

/**
 * @param {Item} item
 * @param {string} key
 * @param {any} origin
 * @return {RemoteWrite}
 */
const createRemoteWrite = (item, key, origin) => {
  const isDelete = item.deleted || item.content instanceof ContentDeleted
  return {
    lastId: item.lastId,
    write: createMapWriteSnapshot(
      key,
      isDelete ? 'delete' : 'set',
      isDelete ? undefined : item.content.getContent()[item.length - 1],
      item.id.client,
      origin,
      time.getUnixTime()
    )
  }
}

/**
 * Finds keys that two clients wrote without having seen each other's write.
 *
 * A write builds on the entry it names as its origin. A key is in conflict if, after this update,
 * more than one live write has no successor. Writes the sender already deleted are ignored because
 * the sender resolved them before sending the update. Without this, every peer that loads a
 * document with an old conflict would report it again.
 *
 * Writes whose dependencies are still missing are checked when the update is retried.
 *
 * @param {Transaction} transaction
 * @param {BlockSet} blocks The new blocks of the update.
 * @return {Array<RemoteMapConflict>}
 */
export const findRemoteMapConflicts = (transaction, blocks) => {
  const doc = transaction.doc
  /**
   * @type {Map<YType<any>|string,Map<string,Array<Item>>>}
   */
  const entries = new Map()
  /**
   * @type {Map<Item,{parent:YType<any>|string,key:string}|null>}
   */
  const resolved = new Map()
  /**
   * @type {Set<Item|GC|Skip>}
   */
  const superseded = new Set()
  blocks.clients.forEach(({ refs }) => {
    refs.forEach(block => {
      if (!(block instanceof Item)) return
      const entry = resolveMapEntry(doc, blocks, block, resolved)
      if (entry === null) return
      map.setIfUndefined(map.setIfUndefined(entries, entry.parent, () => /** @type {Map<string,Array<Item>>} */ (new Map())), entry.key, () => /** @type {Array<Item>} */ ([])).push(block)
      if (block.origin !== null) {
        const originBlock = findBlock(blocks, block.origin)
        if (originBlock !== null) superseded.add(originBlock)
      }
    })
  })
  /**
   * @type {Array<RemoteMapConflict>}
   */
  const conflicts = []
  entries.forEach((keys, parent) => {
    keys.forEach((items, key) => {
      const head = parent instanceof YType ? parent._map.get(key) ?? null : null
      const headIsTip = head !== null && !items.some(({ origin }) =>
        origin !== null && origin.client === head.id.client && origin.clock >= head.id.clock && origin.clock < head.id.clock + head.length
      )
      const incoming = items
        .filter(item => !superseded.has(item) && !(item.content instanceof ContentDeleted))
        .map(item => createRemoteWrite(item, key, transaction.origin))
      const local = headIsTip ? createRemoteWrite(head, key, null) : null
      const writers = new Set(incoming.map(({ write }) => write.clientID))
      if (local !== null) writers.add(local.write.clientID)
      if (writers.size > 1) {
        conflicts.push({ parent, key, local, incoming })
      }
    })
  })
  return conflicts
}

/**
 * @param {YType<any>|string} parent
 * @return {string}
 */
const getConflictParentName = parent => {
  if (parent instanceof YType) return getMapParentName(parent)
  return parent.startsWith('root:') ? parent.slice(5) : parent.slice(3)
}

/**
 * Records every write that loses against the write `head` holds after merging.
 *
 * @param {Doc} doc
 * @param {RemoteMapConflict} conflict
 * @param {Item|undefined} head The entry of the key after the update is merged.
 * @return {Array<import('./Doc.js').MapConflict>}
 */
const recordRemoteConflict = (doc, conflict, head) => {
  const writes = conflict.local !== null ? [conflict.local, ...conflict.incoming] : conflict.incoming
  const byClient = writes.slice().sort((a, b) => b.lastId.client - a.lastId.client)
  const winner = (head && writes.find(({ lastId }) =>
    lastId.client === head.id.client && lastId.clock >= head.id.clock && lastId.clock < head.id.clock + head.length
  )) ?? byClient[0]
  return writes.filter(({ lastId }) => lastId.client !== winner.lastId.client).map(loser => {
    const [writeA, writeB] = loser.lastId.client < winner.lastId.client ? [loser, winner] : [winner, loser]
    const id = `${writeA.lastId.client}:${writeA.lastId.clock}|${writeB.lastId.client}:${writeB.lastId.clock}`
    return map.setIfUndefined(doc._recordedRemoteMapConflicts, id, () => {
      const source = writeA.write.clientID === doc.clientID || writeB.write.clientID === doc.clientID ? 'mixed' : 'remote'
      const record = createMapConflict(source, conflict.key, getConflictParentName(conflict.parent), writeA.write, writeB.write, writeA === winner ? 'writeA' : 'writeB')
      doc._mapConflicts.push(record)
      return record
    })
  })
}

/**
 * Records the conflicts of an update and refuses the update. The update is merged into a copy of
 * this doc to find the winner that peers get when they accept the update.
 *
 * @param {Doc} doc
 * @param {Array<RemoteMapConflict>} conflicts
 * @param {BlockSet} blocks The new blocks of the update.
 */
export const rejectRemoteMapConflicts = (doc, conflicts, blocks) => {
  const encoder = new UpdateEncoderV2()
  writeBlockSet(encoder, blocks)
  encoding.writeVarUint(encoder.restEncoder, 0) // the winner doesn't depend on deletes
  const merged = new Doc()
  applyUpdateV2(merged, encodeStateAsUpdateV2(doc))
  applyUpdateV2(merged, encoder.toUint8Array())
  const records = conflicts.flatMap(conflict =>
    recordRemoteConflict(doc, conflict, findConflictParent(merged, conflict.parent)?._map.get(conflict.key))
  )
  merged.destroy()
  throw new MapConflictError(records[0], records)
}

/**
 * Records the conflicts of an update that was merged into this doc.
 *
 * @param {Doc} doc
 * @param {Array<RemoteMapConflict>} conflicts
 */
export const logMergedMapConflicts = (doc, conflicts) => {
  conflicts.forEach(conflict => {
    recordRemoteConflict(doc, conflict, findConflictParent(doc, conflict.parent)?._map.get(conflict.key))
  })
}
