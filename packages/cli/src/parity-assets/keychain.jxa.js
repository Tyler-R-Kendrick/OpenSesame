// Run only through Auth's private capture. macOS's security CLI has an input-line
// limit, so use the native API for tokens of arbitrary length, over stdin.
ObjC.import("Foundation");
ObjC.import("Security");

function run(args) {
  const action = args[0];
  const service = args[1];
  const account = args[2];
  if (
    !service ||
    !account ||
    ["get", "exists", "add", "remove"].indexOf(action) === -1
  )
    throw new Error("Invalid Keychain operation");
  // Security constants are CFStringRefs; JXA needs their toll-free Objective-C
  // objects rather than the raw references when building an NSDictionary.
  const cf = ObjC.castRefToObject;
  const query = $.NSMutableDictionary.alloc.init;
  query.setObjectForKey(cf($.kSecClassGenericPassword), cf($.kSecClass));
  query.setObjectForKey($(service), cf($.kSecAttrService));
  query.setObjectForKey($(account), cf($.kSecAttrAccount));
  let status;
  if (action === "add") {
    const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    if (data.length === 0) throw new Error("Empty Keychain input");
    query.setObjectForKey(data, cf($.kSecValueData));
    status = $.SecItemAdd(query, null);
  } else if (action === "remove") {
    status = $.SecItemDelete(query);
    if (status === -25300) return "removed";
  } else {
    query.setObjectForKey(cf($.kSecMatchLimitOne), cf($.kSecMatchLimit));
    query.setObjectForKey(
      $.NSNumber.numberWithBool(true),
      cf(action === "get" ? $.kSecReturnData : $.kSecReturnAttributes),
    );
    const result = Ref();
    status = $.SecItemCopyMatching(query, result);
    if (action === "exists" && status === -25300) return "missing";
    if (status === 0)
      return action === "exists"
        ? "found"
        : ObjC.unwrap(
            $.NSString.alloc.initWithDataEncoding(
              cf(result[0]),
              $.NSUTF8StringEncoding,
            ),
          );
  }
  if (status !== 0) throw new Error("Keychain operation failed");
  return action === "remove" ? "removed" : "added";
}
