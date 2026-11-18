import {
  ContentDeleted,
  ContentType,
  Item,
  MapConflictError,
  getMapConflictType,
  getMapParentName,
  YType,
  getItem,
  getState,
  typeMapGet,
  BlockSet, Doc, GC, ID, Skip, Transaction // eslint-disable-line
} from '../internals.js'

import * as map from 'lib0/map'
import * as time from 'lib0/time'

/**
 * @typedef {Object} RemoteWrite
 * @property {ID} lastId The last id of the written item.
 * @property {number} length The length of the written item.
 * @property {import('./Doc.js').MapWrite} write
 */

/**
 * Concurrent writes to one key that were found in an update, before it is integrated.
 *
 * @typedef {Object} RemoteMapConflict
 * @property {YType<any>|string} parent The type that owns the key, or a placeholder if it is unknown.
 * @property {string} key
 * @property {any} currentValue The value of the key before the update.
 * @property {RemoteWrite|null} local The current local write, if the update doesn't build on it.
 * @property {import('./Doc.js').MapWrite|null} current The current local write of this key.
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
 * @param {string|ID|YType<any>} parent
 * @return {YType<any>|string}
 */
const resolveParent = (doc, parent) => {
  if (parent instanceof YType) return parent
  if (typeof parent === 'string') return doc.share.get(parent) ?? `root:${parent}`
  if (parent.clock < getState(doc.store, parent.client) && !doc.store.skips.hasId(parent)) {
    const parentItem = getItem(doc.store, parent)
    if (parentItem instanceof Item && parentItem.content instanceof ContentType) {
      return parentItem.content.type
    }
  }
  return `id:${parent.client}:${parent.clock}`
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
 * @param {any} origin
 * @return {RemoteWrite}
 */
const createRemoteWrite = (item, origin) => {
  const isDelete = item.deleted || item.content instanceof ContentDeleted
  return {
    lastId: item.lastId,
    length: item.length,
    write: {
      operation: isDelete ? 'delete' : 'set',
      value: isDelete ? undefined : item.content.getContent()[item.length - 1],
      clientID: item.id.client,
      origin,
      time: time.getUnixTime()
    }
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
        .map(item => createRemoteWrite(item, transaction.origin))
      const local = head !== null ? createRemoteWrite(head, null) : null
      const writers = new Set(incoming.map(({ write }) => write.clientID))
      if (headIsTip && local !== null) writers.add(local.write.clientID)
      if (writers.size > 1) {
        conflicts.push({
          parent,
          key,
          currentValue: parent instanceof YType ? typeMapGet(parent, key) : undefined,
          local: headIsTip ? local : null,
          current: local && local.write,
          incoming
        })
      }
    })
  })
  return conflicts
}

/**
 * @param {Doc} doc
 * @param {RemoteMapConflict} conflict
 * @param {RemoteWrite} loser
 * @param {import('./Doc.js').MapWrite|null} accepted
 * @return {import('./Doc.js').MapConflict}
 */
const logRemoteConflict = (doc, conflict, loser, accepted) => {
  const id = `${loser.lastId.client}:${loser.lastId.clock}`
  const recorded = doc._recordedRemoteMapConflicts.get(id)
  // Providers deliver a refused update again on every sync
  if (recorded !== undefined) return recorded
  const parent = typeof conflict.parent === 'string' && conflict.parent.startsWith('root:')
    ? doc.get(conflict.parent.slice(5))
    : conflict.parent
  const record = {
    ...loser.write,
    source: /** @type {'remote'} */ ('remote'),
    type: getMapConflictType(loser.write.value, accepted),
    key: conflict.key,
    parent: parent instanceof YType ? parent : null,
    parentName: parent instanceof YType ? getMapParentName(parent) : parent.slice(3),
    currentValue: conflict.currentValue,
    policy: /** @type {'record'|'error'} */ (doc.mapConflictPolicy),
    accepted
  }
  doc._recordedRemoteMapConflicts.set(id, record)
  doc._mapConflicts.push(record)
  return record
}

/**
 * Records the conflicts of an update and refuses the update.
 *
 * @param {Doc} doc
 * @param {Array<RemoteMapConflict>} conflicts
 */
export const rejectRemoteMapConflicts = (doc, conflicts) => {
  const records = conflicts.flatMap(conflict =>
    conflict.incoming.map(write => logRemoteConflict(doc, conflict, write, conflict.current))
  )
  throw new MapConflictError(records[0], records)
}

/**
 * Logs conflicts of an update that was applied. The write that the merge kept is only known after
 * the update is integrated.
 *
 * @param {Doc} doc
 * @param {Array<RemoteMapConflict>} conflicts
 */
export const logMergedMapConflicts = (doc, conflicts) => {
  conflicts.forEach(conflict => {
    const parent = typeof conflict.parent === 'string' && conflict.parent.startsWith('root:')
      ? doc.share.get(conflict.parent.slice(5))
      : conflict.parent
    const head = parent instanceof YType ? parent._map.get(conflict.key) : undefined
    const writes = conflict.local !== null ? [conflict.local, ...conflict.incoming] : conflict.incoming
    const winner = head && writes.find(({ lastId }) =>
      lastId.client === head.id.client && lastId.clock >= head.id.clock && lastId.clock < head.id.clock + head.length
    )
    const accepted = winner ? winner.write : conflict.current
    writes.forEach(write => {
      if (write !== winner) logRemoteConflict(doc, conflict, write, accepted)
    })
  })
}
