#ifndef KOINCODE_GENERAL_BACKUP_FILE_H
#define KOINCODE_GENERAL_BACKUP_FILE_H
#include <stdbool.h>
#include <stddef.h>

#define GENERAL_BACKUP_FILE_MAX_BYTES (16U * 1024U * 1024U)
typedef struct general_backup_target general_backup_target;
typedef enum {
  GENERAL_BACKUP_FILE_NOT_CREATED,
  GENERAL_BACKUP_FILE_UNCERTAIN,
  GENERAL_BACKUP_FILE_COMPLETE,
  GENERAL_BACKUP_FILE_UNAVAILABLE
} general_backup_file_result;

/* The verified native operation supplies this directory fd; a caller path is never an authority here. */
general_backup_target *general_backup_target_create(int directory_fd, const unsigned char *name, size_t length);
void general_backup_target_revoke(general_backup_target *target);
/* One native owner must drain publication before destroying its target. No file is deleted. */
void general_backup_target_destroy(general_backup_target *target);
/* Input must already be an authenticated, validated backup ciphertext. This function grants no native scope. */
general_backup_file_result general_backup_target_publish(general_backup_target *target,
  const unsigned char *ciphertext, size_t size, const unsigned char expected_digest[32],
  bool (*is_current)(void *context), void *context);

/* Private restore operation only. The caller must supply its verified history directory, never a UI path. */
general_backup_target *general_history_archive_target_create(int directory_fd, const unsigned char *artifact_id, size_t length);
/* Single-use read. The caller owns/frees the ciphertext and must authenticate AEAD/header/plan before verify. */
bool general_history_archive_target_read(general_backup_target *target, unsigned char **ciphertext, size_t *size,
  bool (*is_current)(void *context), void *context);
/* Verifies the same held inode after the caller's cryptographic checks; COMPLETE is file IO, not authorization. */
general_backup_file_result general_history_archive_target_verify(general_backup_target *target, const unsigned char expected_digest[32],
  bool (*is_current)(void *context), void *context);
#endif
