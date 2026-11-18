import * as Y from '../src/index.js'
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
 * @param {t.TestCase} _tc
 */
export const testMapConflictOverwrite = _tc => {
  const ydoc = new Y.Doc()
  t.assert(ydoc.mapConflict === 'overwrite')
  const ymap = ydoc.get()
  ydoc.transact(() => {
    ymap.setAttr('a', 1)
    ymap.setAttr('a', 2)
  })
  t.assert(ymap.getAttr('a') === 2)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictKeepFirst = _tc => {
  const ydoc = new Y.Doc({ mapConflict: 'keep-first' })
  const ymap = ydoc.get()
  const other = ydoc.get('other')
  ydoc.transact(() => {
    ymap.setAttr('a', 1)
    ymap.setAttr('a', 2)
    ymap.setAttr('b', 1)
    ymap.deleteAttr('b')
    other.setAttr('a', 3) // the same key on another type is not a conflict
  })
  t.assert(ymap.getAttr('a') === 1)
  t.assert(ymap.getAttr('b') === 1)
  t.assert(other.getAttr('a') === 3)
  ydoc.transact(() => {
    ymap.deleteAttr('a')
    ymap.setAttr('a', 4)
  })
  t.assert(ymap.getAttr('a') === undefined)
  // each transaction tracks its writes separately
  ymap.setAttr('a', 5)
  ymap.setAttr('a', 6)
  t.assert(ymap.getAttr('a') === 6)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictError = _tc => {
  const ydoc = new Y.Doc({ mapConflict: 'error' })
  const ymap = ydoc.get()
  t.fails(() => {
    ydoc.transact(() => {
      ymap.setAttr('a', 1)
      ymap.setAttr('a', 2)
    })
  })
  // the first write is kept because transactions don't roll back
  t.assert(ymap.getAttr('a') === 1)
  t.fails(() => {
    ydoc.transact(() => {
      ymap.deleteAttr('a')
      ymap.setAttr('a', 3)
    })
  })
  t.assert(ymap.getAttr('a') === undefined)
  // deleting a missing key doesn't write anything
  ydoc.transact(() => {
    ymap.deleteAttr('missing')
    ymap.deleteAttr('missing')
    ymap.setAttr('missing', 1)
  })
  t.assert(ymap.getAttr('missing') === 1)
  // a rejected value doesn't claim the key
  ydoc.transact(() => {
    t.fails(() => {
      ymap.setAttr('b', /** @type {any} */ (new Map()))
    })
    ymap.setAttr('b', 1)
  })
  t.assert(ymap.getAttr('b') === 1)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictOnlyAppliesToLocalWrites = _tc => {
  const source = new Y.Doc()
  source.transact(() => {
    source.get().setAttr('a', 1)
    source.get().setAttr('a', 2)
  })
  const keepFirst = new Y.Doc({ mapConflict: 'keep-first' })
  const strict = new Y.Doc({ mapConflict: 'error' })
  Y.applyUpdate(keepFirst, Y.encodeStateAsUpdate(source))
  Y.applyUpdate(strict, Y.encodeStateAsUpdate(source))
  t.assert(keepFirst.get().getAttr('a') === 2)
  t.assert(strict.get().getAttr('a') === 2)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictRejectsUnknownStrategy = _tc => {
  t.fails(() => {
    new Y.Doc({ mapConflict: /** @type {any} */ ('unknown') }) // eslint-disable-line no-new
  })
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictErrorCarriesContext = _tc => {
  const ydoc = new Y.Doc({ mapConflict: 'error' })
  const ymap = ydoc.get()
  const origin = { name: 'test-origin' }
  /**
   * @type {any}
   */
  let caught = null
  try {
    ydoc.transact(() => {
      ymap.setAttr('a', 1)
      ymap.setAttr('a', 2)
    }, origin)
  } catch (err) {
    caught = err
  }
  t.assert(caught instanceof Y.MapConflictError)
  t.assert(caught instanceof Error)
  t.assert(caught.name === 'MapConflictError')
  t.assert(caught.message.includes('"a"'))
  const conflict = caught.conflict
  t.assert(conflict.key === 'a')
  t.assert(conflict.type === ymap)
  t.assert(conflict.operation === 'set')
  t.assert(conflict.value === 2)
  t.assert(conflict.currentValue === 1)
  t.assert(conflict.strategy === 'error')
  t.assert(conflict.origin === origin)
  t.assert(conflict.clientID === ydoc.clientID)
  t.assert(typeof conflict.time === 'number')
  t.assert(ydoc.mapConflicts.length === 1)
  t.assert(ydoc.mapConflicts[0] === conflict)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictsAreRecorded = _tc => {
  const ydoc = new Y.Doc({ mapConflict: 'keep-first' })
  const ymap = ydoc.get()
  ydoc.transact(() => {
    ymap.setAttr('a', 1)
    ymap.setAttr('a', 2)
    ymap.deleteAttr('a')
    ymap.setAttr('b', 1) // first write to this key is not a conflict
  })
  t.assert(ydoc.mapConflicts.length === 2)
  const [first, second] = ydoc.mapConflicts
  t.assert(first.operation === 'set' && first.value === 2 && first.currentValue === 1)
  t.assert(first.strategy === 'keep-first')
  t.assert(second.operation === 'delete' && second.value === undefined && second.currentValue === 1)
  // records survive later transactions
  ymap.setAttr('a', 3)
  t.assert(ydoc.mapConflicts.length === 2)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictsIgnoreAcceptedWrites = _tc => {
  const overwrite = new Y.Doc()
  overwrite.transact(() => {
    overwrite.get().setAttr('a', 1)
    overwrite.get().setAttr('a', 2)
  })
  t.assert(overwrite.mapConflicts.length === 0)
  const strict = new Y.Doc({ mapConflict: 'error' })
  Y.applyUpdate(strict, Y.encodeStateAsUpdate(overwrite))
  t.assert(strict.mapConflicts.length === 0)
  strict.transact(() => {
    t.fails(() => {
      strict.get().setAttr('b', /** @type {any} */ (new Map()))
    })
    strict.get().setAttr('b', 1)
  })
  t.assert(strict.mapConflicts.length === 0)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMapConflictSummary = _tc => {
  const ydoc = new Y.Doc({ mapConflict: 'keep-first' })
  t.compare(ydoc.getMapConflictSummary(), [])
  const settings = ydoc.get('settings')
  const nested = new Y.Type()
  settings.setAttr('nested', nested)
  ydoc.clientID = 1
  ydoc.transact(() => {
    settings.setAttr('a', 1)
    settings.setAttr('a', 2)
    settings.deleteAttr('a')
    settings.setAttr('b', 1)
    settings.setAttr('b', 2)
    nested.setAttr('a', 1)
    nested.setAttr('a', 2)
    settings.setAttr('untouched', 1)
  }, 'alice')
  ydoc.clientID = 2
  ydoc.transact(() => {
    settings.deleteAttr('a')
    settings.setAttr('a', 3)
  }, 'bob')
  const summary = ydoc.getMapConflictSummary()
  /**
   * @param {import('../src/utils/Doc.js').MapConflictSummary} group
   */
  const describe = group => group.writes.map(w => [w.status, w.clientID, w.origin, w.operation, w.value])
  t.assert(summary.length === 3)
  const [a, b, nestedA] = summary
  t.assert(a.type === settings && a.mapName === 'settings' && a.key === 'a')
  t.assert(a.refusedCount === 3)
  t.compare(describe(a), [
    ['kept', 1, 'alice', 'set', 1],
    ['refused', 1, 'alice', 'set', 2],
    ['refused', 1, 'alice', 'delete', undefined],
    ['kept', 2, 'bob', 'delete', undefined],
    ['refused', 2, 'bob', 'set', 3]
  ])
  t.assert(b.key === 'b' && b.refusedCount === 1)
  t.compare(describe(b), [
    ['kept', 1, 'alice', 'set', 1],
    ['refused', 1, 'alice', 'set', 2]
  ])
  t.assert(nestedA.type === nested && nestedA.mapName === null && nestedA.key === 'a')
  // the summary is derived from the log
  ydoc.mapConflicts.length = 0
  t.compare(ydoc.getMapConflictSummary(), [])
}
