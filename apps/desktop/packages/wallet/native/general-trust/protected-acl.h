#ifndef KOINCODE_GENERAL_PROTECTED_ACL_H
#define KOINCODE_GENERAL_PROTECTED_ACL_H
#include <stdbool.h>
#include <errno.h>
#include <sys/acl.h>
/* One predicate for root-held controls: read grants and denies are allowed;
 * writable or unknown grants cannot become protected namespace authority. */
static inline bool general_protected_acl_consume_readonly(acl_t acl) {
  if (!acl) return errno == ENOENT;
  bool ok = false; acl_entry_t entry;
  for (unsigned i = 0; i <= ACL_MAX_ENTRIES; i++) {
    errno = 0; int found = acl_get_entry(acl, i ? ACL_NEXT_ENTRY : ACL_FIRST_ENTRY, &entry);
    if (found == -1) { ok = errno == EINVAL; break; }
    if (found != 0 || i == ACL_MAX_ENTRIES) break;
    acl_tag_t tag; acl_permset_mask_t permissions;
    if (acl_get_tag_type(entry, &tag) || (tag != ACL_EXTENDED_ALLOW && tag != ACL_EXTENDED_DENY) || acl_get_permset_mask_np(entry, &permissions)) break;
    const acl_permset_mask_t readonly = ACL_READ_DATA | ACL_EXECUTE | ACL_READ_ATTRIBUTES | ACL_READ_EXTATTRIBUTES | ACL_READ_SECURITY;
    if (tag == ACL_EXTENDED_ALLOW && (permissions & ~readonly)) break;
  }
  acl_free(acl); return ok;
}
static inline bool general_protected_acl_readonly(int fd) {
  errno = 0; return general_protected_acl_consume_readonly(acl_get_fd_np(fd, ACL_TYPE_EXTENDED));
}
#endif
