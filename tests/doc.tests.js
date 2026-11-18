import * as Y from '../src/index.js'
import { typeMapSet } from '../src/internals.js'
import * as t from 'lib0/testing'

/**
 * @param {t.TestCase} _tc
 */
export const testAfterTransactionRecursion = _tc => {
  const ydoc = new Y.Doc()
  const yxml = ydoc.get('')
  ydoc.on('afterTransaction', tr => {
    if (tr.origin === 'test') {
      yxml.toJSON()
    }
  })
  ydoc.transact(_tr => {
    for (let i = 0; i < 15000; i++) {
      yxml.push([new Y.Type('a')])
    }
  }, 'test')
}

/**
 * @param {t.TestCase} _tc
 */
export const testFindTypeInOtherDoc = _tc => {
  const ydoc = new Y.Doc()
  const ymap = ydoc.get()
  const ytext = ymap.setAttr('ytext', new Y.Type())
  const ydocClone = new Y.Doc()
  Y.applyUpdate(ydocClone, Y.encodeStateAsUpdate(ydoc))
  /**
   * @param {Y.Type} ytype
   * @param {Y.Doc} otherYdoc
   * @return {Y.Type}
   */
  const findTypeInOtherYdoc = (ytype, otherYdoc) => {
    const ydoc = /** @type {Y.Doc} */ (ytype.doc)
    if (ytype._item === null) {
      /**
       * If is a root type, we need to find the root key in the original ydoc
       * and use it to get the type in the other ydoc.
       */
      const rootKey = Array.from(ydoc.share.keys()).find(
        (key) => ydoc.share.get(key) === ytype
      )
      if (rootKey == null) {
        throw new Error('type does not exist in other ydoc')
      }
      return otherYdoc.get(rootKey)
    } else {
      /**
       * If it is a sub type, we use the item id to find the history type.
       */
      const ytypeItem = ytype._item
      const otherStructs = otherYdoc.store.clients.get(ytypeItem.id.client) ?? []
      const itemIndex = Y.findIndexSS(
        otherStructs,
        ytypeItem.id.clock
      )
      const otherItem = /** @type {Y.Item} */ (otherStructs[itemIndex])
      const otherContent = /** @type {Y.ContentType} */ (otherItem.content)
      return /** @type {Y.Type} */ (otherContent.type)
    }
  }
  t.assert(findTypeInOtherYdoc(ymap, ydocClone) != null)
  t.assert(findTypeInOtherYdoc(ytext, ydocClone) != null)
}

/**
 * Client id should be changed when an instance receives updates from another client using the same client id.
 *
 * @param {t.TestCase} _tc
 */
export const testClientIdDuplicateChange = _tc => {
  const doc1 = new Y.Doc()
  doc1.clientID = 0
  const doc2 = new Y.Doc()
  doc2.clientID = 0
  t.assert(doc2.clientID === doc1.clientID)
  doc1.get('a').insert(0, [1, 2])
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
  t.assert(doc2.clientID !== doc1.clientID)
}

/**
 * @param {t.TestCase} _tc
 */
export const testGetTypeEmptyId = _tc => {
  const doc1 = new Y.Doc()
  doc1.get('').insert(0, 'h')
  doc1.get().insert(1, 'i')
  const doc2 = new Y.Doc()
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
  t.assert(doc2.get().toString() === 'hi')
  t.assert(doc2.get('').toString() === 'hi')
}

/**
 * @param {t.TestCase} _tc
 */
export const testToJSON = _tc => {
  const doc = new Y.Doc()
  t.compare(doc.toJSON(), {}, 'doc.toJSON yields empty object')

  const arr = doc.get('array')
  arr.push(['test1'])

  const map = doc.get('map')
  map.setAttr('k1', 'v1')
  const map2 = new Y.Type()
  map.setAttr('k2', map2)
  map2.setAttr('m2k1', 'm2v1')
  t.compare(doc.toJSON(), {
    array: { children: ['test1'] },
    map: {
      attrs: {
        k1: 'v1',
        k2: {
          attrs: {
            m2k1: 'm2v1'
          }
        }
      }
    }
  }, 'doc.toJSON has array and recursive map')
}

/**
 * @param {t.TestCase} _tc
 */
export const testSubdoc = _tc => {
  const doc = new Y.Doc()
  doc.load() // doesn't do anything
  {
    /**
     * @type {Array<any>|null}
     */
    let event = /** @type {any} */ (null)
    doc.on('subdocs', subdocs => {
      event = [Array.from(subdocs.added).map(x => x.guid), Array.from(subdocs.removed).map(x => x.guid), Array.from(subdocs.loaded).map(x => x.guid)]
    })
    const subdocs = doc.get('mysubdocs')
    const docA = new Y.Doc({ guid: 'a' })
    docA.load()
    subdocs.setAttr('a', docA)
    t.compare(event, [['a'], [], ['a']])

    event = null
    subdocs.getAttr('a').load()
    t.assert(event === null)

    event = null
    subdocs.getAttr('a').destroy()
    t.compare(event, [['a'], ['a'], []])
    subdocs.getAttr('a').load()
    t.compare(event, [[], [], ['a']])

    subdocs.setAttr('b', new Y.Doc({ guid: 'a', shouldLoad: false }))
    t.compare(event, [['a'], [], []])
    subdocs.getAttr('b').load()
    t.compare(event, [[], [], ['a']])

    const docC = new Y.Doc({ guid: 'c' })
    docC.load()
    subdocs.setAttr('c', docC)
    t.compare(event, [['c'], [], ['c']])

    t.compare(Array.from(doc.getSubdocGuids()), ['a', 'c'])
  }

  const doc2 = new Y.Doc()
  {
    t.compare(Array.from(doc2.getSubdocs()), [])
    /**
     * @type {Array<any>|null}
     */
    let event = /** @type {any} */ (null)
    doc2.on('subdocs', subdocs => {
      event = [Array.from(subdocs.added).map(d => d.guid), Array.from(subdocs.removed).map(d => d.guid), Array.from(subdocs.loaded).map(d => d.guid)]
    })
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc))
    t.compare(event, [['a', 'a', 'c'], [], []])

    doc2.get('mysubdocs').getAttr('a').load()
    t.compare(event, [[], [], ['a']])

    t.compare(Array.from(doc2.getSubdocGuids()), ['a', 'c'])

    doc2.get('mysubdocs').deleteAttr('a')
    t.compare(event, [[], ['a'], []])
    t.compare(Array.from(doc2.getSubdocGuids()), ['a', 'c'])
  }
}

/**
 * @param {t.TestCase} _tc
 */
export const testSubdocLoadEdgeCases = _tc => {
  const ydoc = new Y.Doc()
  const yarray = ydoc.get()
  const subdoc1 = new Y.Doc()
  /**
   * @type {any}
   */
  let lastEvent = null
  ydoc.on('subdocs', event => {
    lastEvent = event
  })
  yarray.insert(0, [subdoc1])
  t.assert(subdoc1.shouldLoad)
  t.assert(subdoc1.autoLoad === false)
  t.assert(lastEvent !== null && lastEvent.loaded.has(subdoc1))
  t.assert(lastEvent !== null && lastEvent.added.has(subdoc1))
  // destroy and check whether lastEvent adds it again to added (it shouldn't)
  subdoc1.destroy()
  const subdoc2 = yarray.get(0)
  t.assert(subdoc1 !== subdoc2)
  t.assert(lastEvent !== null && lastEvent.added.has(subdoc2))
  t.assert(lastEvent !== null && !lastEvent.loaded.has(subdoc2))
  // load
  subdoc2.load()
  t.assert(lastEvent !== null && !lastEvent.added.has(subdoc2))
  t.assert(lastEvent !== null && lastEvent.loaded.has(subdoc2))
  // apply from remote
  const ydoc2 = new Y.Doc()
  ydoc2.on('subdocs', event => {
    lastEvent = event
  })
  Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc))
  const subdoc3 = ydoc2.get().get(0)
  t.assert(subdoc3.shouldLoad === false)
  t.assert(subdoc3.autoLoad === false)
  t.assert(lastEvent !== null && lastEvent.added.has(subdoc3))
  t.assert(lastEvent !== null && !lastEvent.loaded.has(subdoc3))
  // load
  subdoc3.load()
  t.assert(subdoc3.shouldLoad)
  t.assert(lastEvent !== null && !lastEvent.added.has(subdoc3))
  t.assert(lastEvent !== null && lastEvent.loaded.has(subdoc3))
}

/**
 * @param {t.TestCase} _tc
 */
export const testSubdocLoadEdgeCasesAutoload = _tc => {
  const ydoc = new Y.Doc()
  const yarray = ydoc.get()
  const subdoc1 = new Y.Doc({ autoLoad: true })
  /**
   * @type {any}
   */
  let lastEvent = null
  ydoc.on('subdocs', event => {
    lastEvent = event
  })
  yarray.insert(0, [subdoc1])
  t.assert(subdoc1.shouldLoad)
  t.assert(subdoc1.autoLoad)
  t.assert(lastEvent !== null && lastEvent.loaded.has(subdoc1))
  t.assert(lastEvent !== null && lastEvent.added.has(subdoc1))
  // destroy and check whether lastEvent adds it again to added (it shouldn't)
  subdoc1.destroy()
  const subdoc2 = yarray.get(0)
  t.assert(subdoc1 !== subdoc2)
  t.assert(lastEvent !== null && lastEvent.added.has(subdoc2))
  t.assert(lastEvent !== null && !lastEvent.loaded.has(subdoc2))
  // load
  subdoc2.load()
  t.assert(lastEvent !== null && !lastEvent.added.has(subdoc2))
  t.assert(lastEvent !== null && lastEvent.loaded.has(subdoc2))
  // apply from remote
  const ydoc2 = new Y.Doc()
  ydoc2.on('subdocs', event => {
    lastEvent = event
  })
  Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc))
  const subdoc3 = ydoc2.get().get(0)
  t.assert(subdoc1.shouldLoad)
  t.assert(subdoc1.autoLoad)
  t.assert(lastEvent !== null && lastEvent.added.has(subdoc3))
  t.assert(lastEvent !== null && lastEvent.loaded.has(subdoc3))
}

/**
 * @param {t.TestCase} _tc
 */
export const testSubdocsUndo = _tc => {
  const ydoc = new Y.Doc()
  const elems = ydoc.get()
  const undoManager = new Y.UndoManager(elems)
  const subdoc = new Y.Doc()
  // @ts-ignore
  elems.insert(0, [subdoc])
  undoManager.undo()
  undoManager.redo()
  t.assert(elems.length === 1)
}

/**
 * @param {t.TestCase} _tc
 */
export const testLoadDocsEvent = async _tc => {
  const ydoc = new Y.Doc()
  t.assert(ydoc.isLoaded === false)
  let loadedEvent = false
  ydoc.on('load', () => {
    loadedEvent = true
  })
  ydoc.emit('load', [ydoc])
  await ydoc.whenLoaded
  t.assert(loadedEvent)
  t.assert(ydoc.isLoaded)
}

/**
 * @param {t.TestCase} _tc
 */
export const testSyncDocsEvent = async _tc => {
  const ydoc = new Y.Doc()
  t.assert(ydoc.isLoaded === false)
  t.assert(ydoc.isSynced === false)
  let loadedEvent = false
  ydoc.once('load', () => {
    loadedEvent = true
  })
  let syncedEvent = false
  ydoc.once('sync', /** @param {any} isSynced */ (isSynced) => {
    syncedEvent = true
    t.assert(isSynced)
  })
  ydoc.emit('sync', [true, ydoc])
  await ydoc.whenLoaded
  const oldWhenSynced = ydoc.whenSynced
  await ydoc.whenSynced
  t.assert(loadedEvent)
  t.assert(syncedEvent)
  t.assert(ydoc.isLoaded)
  t.assert(ydoc.isSynced)
  let loadedEvent2 = false
  ydoc.on('load', () => {
    loadedEvent2 = true
  })
  let syncedEvent2 = false
  ydoc.on('sync', (isSynced) => {
    syncedEvent2 = true
    t.assert(isSynced === false)
  })
  ydoc.emit('sync', [false, ydoc])
  t.assert(!loadedEvent2)
  t.assert(syncedEvent2)
  t.assert(ydoc.isLoaded)
  t.assert(!ydoc.isSynced)
  t.assert(ydoc.whenSynced !== oldWhenSynced)
}

/**
 * Creates two clients that wrote different values to the same key without seeing each other.
 *
 * @param {any} [aliceValue]
 * @param {any} [bobValue]
 * @param {number} [aliceClient]
 * @param {number} [bobClient]
 */
const createConcurrentWrites = (aliceValue = 'alice', bobValue = 'bob', aliceClient = 1, bobClient = 2) => {
  const alice = new Y.Doc()
  alice.clientID = aliceClient
  const bob = new Y.Doc()
  bob.clientID = bobClient
  alice.get().setAttr('a', aliceValue)
  bob.transact(() => {
    bob.get().setAttr('a', bobValue)
    bob.get().setAttr('other', 'bob')
  })
  return { alice, bob, aliceUpdate: Y.encodeStateAsUpdate(alice), bobUpdate: Y.encodeStateAsUpdate(bob) }
}

/**
 * @param {import('../src/utils/Doc.js').MapConflict} conflict
 */
const getWinner = conflict => conflict[conflict.resolution.winner]

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictPolicyAllow = _tc => {
  const ydoc = new Y.Doc()
  t.assert(ydoc.mapConflictPolicy === 'allow')
  const ymap = ydoc.get()
  ydoc.transact(() => {
    ymap.setAttr('a', 1)
    ymap.setAttr('a', 2)
  })
  t.assert(ymap.getAttr('a') === 2)
  const { aliceUpdate, bobUpdate } = createConcurrentWrites()
  Y.applyUpdate(ydoc, aliceUpdate)
  Y.applyUpdate(ydoc, bobUpdate)
  t.assert(ymap.getAttr('other') === 'bob')
  t.compare(ydoc.getMapConflicts(), [])
  const summary = ydoc.getMapConflictSummary()
  t.assert(summary.count === 0)
  t.assert(Object.keys(summary.byKey).length === 0)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictPolicyRejectsUnknownValue = _tc => {
  t.fails(() => {
    new Y.Doc({ mapConflictPolicy: /** @type {any} */ ('unknown') }) // eslint-disable-line no-new
  })
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictRecordShapeLocal = _tc => {
  const ydoc = new Y.Doc({ mapConflictPolicy: 'record' })
  ydoc.clientID = 7
  const ymap = ydoc.get('settings')
  const other = ydoc.get('other')
  ydoc.transact(() => {
    ymap.setAttr('a', 1)
    ymap.setAttr('a', 2)
    ymap.deleteAttr('a')
    ymap.setAttr('b', 1)
    other.setAttr('a', 3) // the same key on another type is not a conflict
    ymap.deleteAttr('missing') // deleting a missing key doesn't write anything
    ymap.deleteAttr('missing')
  }, 'alice')
  // every write is applied
  t.assert(ymap.getAttr('a') === undefined)
  const conflicts = ydoc.getMapConflicts()
  t.assert(conflicts.length === 2)
  const [setSet, setDelete] = conflicts
  t.assert(setSet.type === 'set-set' && setSet.key === 'a' && setSet.parent === 'settings')
  t.assert(setSet.source === 'local' && setSet.ambiguous === false)
  t.assert(setSet.writeA.value === 1 && setSet.writeB.value === 2)
  t.assert(setSet.writeA.clientID === 7 && setSet.writeA.origin === 'alice')
  t.assert(setSet.writeA.summary === 'client 7 set "a" to 1')
  t.compare(setSet.resolution, { winner: 'writeB', strategy: 'deterministic' })
  t.assert(setSet.message.includes(setSet.writeA.summary) && setSet.message.includes('"settings"'))
  t.assert(setDelete.type === 'delete-set')
  t.assert(setDelete.writeB.operation === 'delete' && setDelete.writeB.value === undefined)
  t.assert(setDelete.writeB.summary === 'client 7 deleted "a"')
  // a delete before a set has the same type
  ymap.setAttr('c', 1)
  ydoc.transact(() => {
    ymap.deleteAttr('c')
    ymap.setAttr('c', 2)
  })
  t.assert(ydoc.getMapConflicts()[2].type === 'delete-set')
  // each transaction tracks its writes separately
  ymap.setAttr('d', 1)
  ymap.setAttr('d', 2)
  t.assert(ydoc.getMapConflicts().length === 3)
  // the returned list is a copy
  ydoc.getMapConflicts().length = 0
  t.assert(ydoc.getMapConflicts().length === 3)
  // allow mode doesn't report conflicts recorded earlier
  ydoc.mapConflictPolicy = 'allow'
  t.compare(ydoc.getMapConflicts(), [])
  t.assert(ydoc.getMapConflictSummary().count === 0)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictPolicyErrorLocal = _tc => {
  const ydoc = new Y.Doc({ mapConflictPolicy: 'error' })
  const ymap = ydoc.get()
  /**
   * @type {any}
   */
  let caught = null
  try {
    ydoc.transact(() => {
      ymap.setAttr('a', 1)
      ymap.setAttr('a', 2)
    })
  } catch (err) {
    caught = err
  }
  t.assert(caught instanceof Y.MapConflictError)
  t.assert(caught.name === 'MapConflictError')
  t.assert(caught.message === caught.conflict.message)
  t.assert(caught.conflict.source === 'local')
  t.assert(caught.conflict.resolution.winner === 'writeA')
  t.assert(ydoc.getMapConflicts()[0] === caught.conflict)
  // the first write is kept because transactions don't roll back
  t.assert(ymap.getAttr('a') === 1)
  // a rejected value doesn't count as a write
  ydoc.transact(() => {
    t.fails(() => {
      ymap.setAttr('b', /** @type {any} */ (new Map()))
    })
    ymap.setAttr('b', 1)
  })
  t.assert(ymap.getAttr('b') === 1)
  t.assert(ydoc.getMapConflicts().length === 1)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictPolicyRecordRemote = _tc => {
  const { aliceUpdate, bobUpdate } = createConcurrentWrites()
  const ydoc = new Y.Doc({ mapConflictPolicy: 'record' })
  const reversed = new Y.Doc({ mapConflictPolicy: 'record' })
  const reference = new Y.Doc()
  Y.applyUpdate(ydoc, aliceUpdate)
  Y.applyUpdate(ydoc, bobUpdate, 'from-bob')
  Y.applyUpdate(reversed, bobUpdate)
  Y.applyUpdate(reversed, aliceUpdate)
  Y.applyUpdate(reference, aliceUpdate)
  Y.applyUpdate(reference, bobUpdate)
  // the update is merged as usual, in any order
  const winner = reference.get().getAttr('a')
  t.assert(ydoc.get().getAttr('a') === winner)
  t.assert(reversed.get().getAttr('a') === winner)
  t.assert(ydoc.get().getAttr('other') === 'bob')
  t.assert(ydoc.getMapConflicts().length === 1)
  const conflict = ydoc.getMapConflicts()[0]
  t.assert(conflict.source === 'remote' && conflict.type === 'set-set')
  t.assert(conflict.key === 'a' && conflict.parent === '')
  // both delivery orders describe the conflict the same way
  t.assert(conflict.writeA.clientID === 1 && conflict.writeB.clientID === 2)
  t.assert(getWinner(conflict).value === winner)
  const other = reversed.getMapConflicts()[0]
  t.compare(other.resolution, conflict.resolution)
  t.assert(other.writeA.clientID === 1 && other.writeB.clientID === 2)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictSourceMixed = _tc => {
  const bob = new Y.Doc()
  bob.clientID = 2
  bob.get().setAttr('a', 'bob')
  const ydoc = new Y.Doc({ mapConflictPolicy: 'record' })
  ydoc.clientID = 1
  ydoc.get().setAttr('a', 'local')
  ydoc.get().deleteAttr('a')
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(bob))
  const conflict = ydoc.getMapConflicts()[0]
  t.assert(conflict.source === 'mixed')
  t.assert(conflict.type === 'delete-set')
  t.assert(conflict.writeA.operation === 'delete' && conflict.writeB.value === 'bob')
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictPolicyErrorRemote = _tc => {
  const { aliceUpdate, bobUpdate } = createConcurrentWrites()
  const ydoc = new Y.Doc({ mapConflictPolicy: 'error' })
  Y.applyUpdate(ydoc, aliceUpdate)
  const stateBefore = Y.encodeStateVector(ydoc)
  let updates = 0
  ydoc.on('update', () => { updates++ })
  /**
   * @type {any}
   */
  let caught = null
  try {
    Y.applyUpdate(ydoc, bobUpdate, 'from-bob')
  } catch (err) {
    caught = err
  }
  t.assert(caught instanceof Y.MapConflictError)
  t.assert(caught.conflict.source === 'remote')
  t.assert(caught.conflict.writeB.value === 'bob' && caught.conflict.writeB.origin === 'from-bob')
  t.assert(caught.conflicts.length === 1)
  // nothing from the update is applied
  t.assert(ydoc.get().getAttr('a') === 'alice')
  t.assert(ydoc.get().getAttr('other') === undefined)
  t.compare(Y.encodeStateVector(ydoc), stateBefore)
  t.assert(updates === 0)
  // delivering the same update again doesn't record it twice
  t.fails(() => {
    Y.applyUpdate(ydoc, bobUpdate)
  })
  t.assert(ydoc.getMapConflicts().length === 1)
}

/**
 * The winner must match what peers get by merging, even if this doc applies nothing.
 *
 * @param {t.TestCase} _tc
 */
export const testMapConflictWinnerMatchesMergeWhenRefused = _tc => {
  [[1, 2], [2, 1], [100, 3], [3, 100]].forEach(([aliceClient, bobClient]) => {
    const { aliceUpdate, bobUpdate } = createConcurrentWrites('alice', 'bob', aliceClient, bobClient)
    const reference = new Y.Doc()
    Y.applyUpdate(reference, aliceUpdate)
    Y.applyUpdate(reference, bobUpdate)
    const ydoc = new Y.Doc({ mapConflictPolicy: 'error' })
    Y.applyUpdate(ydoc, aliceUpdate)
    t.fails(() => {
      Y.applyUpdate(ydoc, bobUpdate)
    })
    t.assert(ydoc.get().getAttr('a') === 'alice')
    const conflict = ydoc.getMapConflicts()[0]
    t.assert(conflict.resolution.strategy === 'deterministic')
    t.assert(getWinner(conflict).value === reference.get().getAttr('a'))
  })
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictPolicyIgnoresSequentialWrites = _tc => {
  const alice = new Y.Doc()
  alice.clientID = 1
  const bob = new Y.Doc()
  bob.clientID = 2
  const ydoc = new Y.Doc({ mapConflictPolicy: 'error' })
  alice.get().setAttr('a', 1)
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(alice))
  Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))
  // bob saw alice's write
  bob.get().setAttr('a', 2)
  bob.get().setAttr('a', 3)
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(bob))
  t.assert(ydoc.get().getAttr('a') === 3)
  t.assert(ydoc.getMapConflicts().length === 0)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictPolicyLoadsResolvedHistory = _tc => {
  const { alice, bob, aliceUpdate, bobUpdate } = createConcurrentWrites()
  Y.applyUpdate(alice, bobUpdate)
  Y.applyUpdate(bob, aliceUpdate)
  // the sender already resolved this conflict, so a new peer can load the document
  const ydoc = new Y.Doc({ mapConflictPolicy: 'error' })
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(alice))
  t.assert(ydoc.get().getAttr('a') === alice.get().getAttr('a'))
  t.assert(ydoc.getMapConflicts().length === 0)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictPolicyInMergedUpdate = _tc => {
  const { aliceUpdate, bobUpdate } = createConcurrentWrites()
  const reference = new Y.Doc()
  Y.applyUpdate(reference, Y.mergeUpdates([aliceUpdate, bobUpdate]))
  const ydoc = new Y.Doc({ mapConflictPolicy: 'error' })
  t.fails(() => {
    Y.applyUpdate(ydoc, Y.mergeUpdates([aliceUpdate, bobUpdate]))
  })
  // the merged update applies nothing, but the winner is still filled in
  t.assert(ydoc.get().getAttr('a') === undefined)
  t.assert(ydoc.getMapConflicts().length === 1)
  t.assert(getWinner(ydoc.getMapConflicts()[0]).value === reference.get().getAttr('a'))
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictPolicyOnNestedMap = _tc => {
  const alice = new Y.Doc()
  alice.clientID = 1
  const bob = new Y.Doc()
  bob.clientID = 2
  alice.get().setAttr('nested', new Y.Type())
  Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))
  const ydoc = new Y.Doc({ mapConflictPolicy: 'error' })
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(alice))
  alice.get().getAttr('nested').setAttr('a', 'alice')
  bob.get().getAttr('nested').setAttr('a', 'bob')
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(alice))
  t.fails(() => {
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(bob))
  })
  const nested = ydoc.get().getAttr('nested')
  t.assert(nested.getAttr('a') === 'alice')
  t.assert(ydoc.getMapConflicts().length === 1)
  t.assert(ydoc.getMapConflicts()[0].parent === `${nested._item.id.client}:${nested._item.id.clock}`)
  Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob))
  t.assert(getWinner(ydoc.getMapConflicts()[0]).value === alice.get().getAttr('nested').getAttr('a'))
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictPolicyKeepsDependentUpdatesPending = _tc => {
  const alice = new Y.Doc()
  alice.clientID = 1
  const bob = new Y.Doc()
  bob.clientID = 2
  /**
   * @type {Array<Uint8Array>}
   */
  const bobUpdates = []
  bob.on('update', update => { bobUpdates.push(update) })
  alice.get().setAttr('a', 'alice')
  bob.get().setAttr('a', 'bob-1')
  bob.get().setAttr('a', 'bob-2')
  const ydoc = new Y.Doc({ mapConflictPolicy: 'error' })
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(alice))
  Y.applyUpdate(ydoc, bobUpdates[1]) // depends on the first update, so it can't be checked yet
  t.assert(ydoc.getMapConflicts().length === 0)
  t.fails(() => {
    Y.applyUpdate(ydoc, bobUpdates[0])
  })
  t.assert(ydoc.getMapConflicts().length === 1)
  t.assert(ydoc.get().getAttr('a') === 'alice')
  t.assert(ydoc.store.pendingStructs !== null)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictAmbiguousLocal = _tc => {
  const ydoc = new Y.Doc({ mapConflictPolicy: 'record' })
  const ymap = ydoc.get()
  ydoc.transact(() => {
    ymap.setAttr('plain', 1)
    ymap.setAttr('plain', 2)
    ymap.setAttr('laterType', 1)
    ymap.setAttr('laterType', new Y.Type())
    ymap.setAttr('earlierType', new Y.Type())
    ymap.setAttr('earlierType', 1)
    ymap.setAttr('laterSubdoc', 1)
    ymap.setAttr('laterSubdoc', new Y.Doc())
    ymap.setAttr('earlierSubdoc', new Y.Doc())
    ymap.deleteAttr('earlierSubdoc')
  })
  t.compare(ydoc.getMapConflicts().map(conflict => [conflict.key, conflict.ambiguous]), [
    ['plain', false],
    ['laterType', true],
    ['earlierType', true],
    ['laterSubdoc', true],
    ['earlierSubdoc', true]
  ])
  t.assert(ydoc.getMapConflicts()[1].writeB.summary.endsWith('a shared type'))
  t.assert(ydoc.getMapConflicts()[3].writeB.summary.endsWith('a subdocument'))
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictAmbiguousRemote = _tc => {
  /**
   * @type {Array<'record'|'error'>}
   */
  const policies = ['record', 'error']
  /**
   * @param {'record'|'error'} policy
   * @param {any} aliceValue
   * @param {any} bobValue
   */
  const isAmbiguous = (policy, aliceValue, bobValue) => {
    const { aliceUpdate, bobUpdate } = createConcurrentWrites(aliceValue, bobValue)
    const ydoc = new Y.Doc({ mapConflictPolicy: policy })
    Y.applyUpdate(ydoc, aliceUpdate)
    try {
      Y.applyUpdate(ydoc, bobUpdate)
    } catch (err) {
      t.assert(err instanceof Y.MapConflictError)
    }
    t.assert(ydoc.getMapConflicts().length === 1)
    return ydoc.getMapConflicts()[0].ambiguous
  }
  policies.forEach(policy => {
    t.assert(!isAmbiguous(policy, 'alice', 'bob'))
    t.assert(isAmbiguous(policy, 'alice', new Y.Type()))
    t.assert(isAmbiguous(policy, new Y.Type(), 'bob'))
    t.assert(isAmbiguous(policy, 'alice', new Y.Doc()))
    t.assert(isAmbiguous(policy, new Y.Doc(), 'bob'))
  })
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictSummaryCounts = _tc => {
  const { aliceUpdate, bobUpdate } = createConcurrentWrites()
  const ydoc = new Y.Doc({ mapConflictPolicy: 'record' })
  Y.applyUpdate(ydoc, aliceUpdate)
  Y.applyUpdate(ydoc, bobUpdate)
  const settings = ydoc.get('settings')
  ydoc.transact(() => {
    settings.setAttr('a', 1)
    settings.setAttr('a', 2)
    settings.setAttr('a', 3)
    settings.setAttr('b', 1)
    settings.deleteAttr('b')
  })
  const summary = ydoc.getMapConflictSummary()
  t.assert(summary.count === 4)
  t.assert(summary.byType['set-set'] === 3 && summary.byType['delete-set'] === 1)
  t.assert(summary.byKey.a === 3 && summary.byKey.b === 1)
  t.assert(summary.byParent[''] === 1 && summary.byParent.settings === 3)
  t.assert(summary.bySource.local === 3 && summary.bySource.remote === 1)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictSummaryCountsUnsafeKeys = _tc => {
  const ydoc = new Y.Doc({ mapConflictPolicy: 'record' })
  // a peer can send this key, even though setAttr doesn't accept it
  ydoc.transact(transaction => {
    typeMapSet(transaction, ydoc.get(), '__proto__', 1)
    typeMapSet(transaction, ydoc.get(), '__proto__', 2)
  })
  const { byKey } = ydoc.getMapConflictSummary()
  t.assert(Object.keys(byKey).length === 1 && Object.keys(byKey)[0] === '__proto__')
  t.assert(byKey.__proto__ === 1) // eslint-disable-line no-proto
}
