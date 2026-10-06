import Foundation
@preconcurrency import Multipaz

/// Retained document/table handles share the original principal's revocation fence.
final class NativeGatedStorage: NSObject, Storage {
    private let delegate: any Storage
    let fence: NativeAuthorityFence
    init(delegate: any Storage, fence: NativeAuthorityFence) { self.delegate = delegate; self.fence = fence }
    func __getTable(spec: StorageTableSpec, completionHandler: @escaping ((any StorageTable)?, Error?) -> Void) {
        fence.perform({ done in
            delegate.__getTable(spec: spec) { table, error in
                done(table.map { NativeGatedTable(delegate: $0, storage: self) }, error)
            }
        }, completion: completionHandler)
    }
    func __purgeExpired(completionHandler: @escaping (Error?) -> Void) {
        fence.performVoid({ delegate.__purgeExpired(completionHandler: $0) }, completion: completionHandler)
    }
}

private final class NativeGatedTable: NSObject, StorageTable {
    private let delegate: any StorageTable
    private let parent: NativeGatedStorage
    var storage: any Storage { parent }
    init(delegate: any StorageTable, storage: NativeGatedStorage) { self.delegate = delegate; parent = storage }
    func __get(key: String, partitionId: String?, completionHandler: @escaping (ByteString?, Error?) -> Void) {
        parent.fence.perform({ delegate.__get(key: key, partitionId: partitionId, completionHandler: $0) }, completion: completionHandler)
    }
    func __insert(key: String?, data: ByteString, partitionId: String?, expiration: KotlinInstant,
                completionHandler: @escaping (String?, Error?) -> Void) {
        parent.fence.perform({ delegate.__insert(key: key, data: data, partitionId: partitionId,
            expiration: expiration, completionHandler: $0) }, completion: completionHandler)
    }
    func __update(key: String, data: ByteString, partitionId: String?, expiration: KotlinInstant?,
                completionHandler: @escaping (Error?) -> Void) {
        parent.fence.performVoid({ delegate.__update(key: key, data: data, partitionId: partitionId,
            expiration: expiration, completionHandler: $0) }, completion: completionHandler)
    }
    func __delete(key: String, partitionId: String?, completionHandler: @escaping (KotlinBoolean?, Error?) -> Void) {
        parent.fence.perform({ delegate.__delete(key: key, partitionId: partitionId, completionHandler: $0) }, completion: completionHandler)
    }
    func __deleteAll(completionHandler: @escaping (Error?) -> Void) {
        parent.fence.performVoid({ delegate.__deleteAll(completionHandler: $0) }, completion: completionHandler)
    }
    func __deletePartition(partitionId: String, completionHandler: @escaping (Error?) -> Void) {
        parent.fence.performVoid({ delegate.__deletePartition(partitionId: partitionId, completionHandler: $0) }, completion: completionHandler)
    }
    func __enumerate(partitionId: String?, afterKey: String?, limit: Int32,
                   completionHandler: @escaping ([String]?, Error?) -> Void) {
        parent.fence.perform({ delegate.__enumerate(partitionId: partitionId, afterKey: afterKey,
            limit: limit, completionHandler: $0) }, completion: completionHandler)
    }
    func __enumerateWithData(partitionId: String?, afterKey: String?, limit: Int32,
                          completionHandler: @escaping ([KotlinPair<NSString, ByteString>]?, Error?) -> Void) {
        parent.fence.perform({ delegate.__enumerateWithData(partitionId: partitionId, afterKey: afterKey,
            limit: limit, completionHandler: $0) }, completion: completionHandler)
    }
}
