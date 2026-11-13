/* Private Security.framework transport. No application/UI scripting is used. */
ObjC.import('Foundation');
ObjC.import('Security');
ObjC.import('unistd');
ObjC.import('stdlib');

function constant(name) { return ObjC.castRefToObject($[name]); }
function dictionary() { return $.NSMutableDictionary.alloc.init; }
function set(query, key, value) { query.setObjectForKey(value, constant(key)); }
function output(data) { $.NSFileHandle.fileHandleWithStandardOutput.writeData(data); }
function statusCode(status) {
  if (status === 0) return 0;
  if (status === -25300) return 44;
  if (status === -25308 || status === -25315 || status === -25293) return 77;
  return 74;
}
// One bounded operation per process. CF results live until process exit; do not
// CFRelease objects handed to the Objective-C bridge (it also owns references).
function validAccess(item) {
  var access = Ref(), uid = Ref(), gid = Ref(), owner = Ref(), rights = Ref();
  if ($.SecKeychainItemCopyAccess(ObjC.castRefToObject(item), access) !== 0) return false;
  if ($.SecAccessCopyOwnerAndACL(access[0], uid, gid, owner, rights) !== 0) return false;
  return uid[0] === $.getuid() && owner[0] === Number($.kSecUseOnlyUID) &&
    ObjC.castRefToObject(rights[0]).containsObject(constant('kSecACLAuthorizationAny'));
}
function findItem(query) {
  var check = query.mutableCopy, item = Ref();
  set(check, 'kSecReturnRef', $.NSNumber.numberWithBool(true));
  set(check, 'kSecMatchLimit', constant('kSecMatchLimitOne'));
  var status = $.SecItemCopyMatching(check, item);
  if (status === -25300) return 44;
  if (status !== 0) return statusCode(status);
  return validAccess(item[0]) ? 0 : 78;
}
function readInput() {
  var input = $.NSMutableData.alloc.init, stream = $.NSFileHandle.fileHandleWithStandardInput;
  while (input.length <= 1048576) {
    var chunk = stream.readDataOfLength(Math.min(65536, 1048577 - input.length));
    if (Number(chunk.length) === 0) break;
    input.appendData(chunk);
  }
  return input;
}
function exchange(args) {
  if (args.length !== 3 || !/^(get|put|remove-response-secret)$/.test(args[0]) ||
      !/^[A-Za-z0-9:._-]{1,256}$/.test(args[1]) ||
      !/^dev\.koincode\.wallet\.(mainnet|general|m4-testnet|testnet)\.v1\.user\.v2$/.test(args[2])) return 64;
  if (args[0] === 'remove-response-secret' &&
      !/^(?:r:[0-9a-f-]{36}:)?(?:http-blob|http-quarantine):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args[1])) return 64;
  var query = dictionary();
  set(query, 'kSecClass', constant('kSecClassGenericPassword'));
  set(query, 'kSecAttrService', $(args[2]));
  set(query, 'kSecAttrAccount', $(args[1]));
  set(query, 'kSecUseAuthenticationUI', constant('kSecUseAuthenticationUIFail'));
  var found = findItem(query);
  if (found !== 0 && found !== 44) return found;
  if (args[0] === 'get') {
    if (found === 44) return 44;
    set(query, 'kSecReturnData', $.NSNumber.numberWithBool(true));
    set(query, 'kSecMatchLimit', constant('kSecMatchLimitOne'));
    var result = Ref(), status = $.SecItemCopyMatching(query, result);
    if (status !== 0) return statusCode(status);
    var data = ObjC.castRefToObject(result[0]);
    if (data.length > 1048576) return 74;
    output(data); return 0;
  }
  if (args[0] === 'remove-response-secret') {
    if (found === 44) return 0;
    return statusCode($.SecItemDelete(query));
  }
  var input = readInput();
  if (Number(input.length) === 0 || input.length > 1048576) return 64;
  if (found === 0) {
    var update = dictionary(); set(update, 'kSecValueData', input);
    var updated = $.SecItemUpdate(query, update);
    return updated === 0 ? findItem(query) : statusCode(updated);
  }
  var access = $.SecAccessCreateWithOwnerAndACL($.getuid(), $.getgid(), $.kSecUseOnlyUID,
    $([constant('kSecACLAuthorizationAny')]), null);
  if (!access) return 74;
  {
    set(query, 'kSecAttrAccess', ObjC.castRefToObject(access));
    set(query, 'kSecValueData', input);
    var added = $.SecItemAdd(query, null);
    query.removeObjectForKey(constant('kSecAttrAccess'));
    query.removeObjectForKey(constant('kSecValueData'));
    return added === 0 ? findItem(query) : statusCode(added);
  }
}
// oxlint-disable-next-line no-unused-vars -- Entry point invoked by the system JXA runtime.
function run(args) {
  $.alarm(10);
  var previous = Ref(), result = 74;
  if ($.SecKeychainGetUserInteractionAllowed(previous) === 0 &&
      $.SecKeychainSetUserInteractionAllowed(false) === 0) {
    try { result = exchange(args); }
    catch { result = 74; }
    finally { if ($.SecKeychainSetUserInteractionAllowed(previous[0]) !== 0) result = 74; }
  }
  $.exit(result);
}
