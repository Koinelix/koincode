#include "root-enrollment.h"
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
static void stop(int signal) { (void)signal; general_root_enrollment_cancel(); }
int main(int argc, char **argv) {
  if (argc != 2 || strcmp(argv[1], "--enroll")) { fputs("Usage: GeneralWalletProvisioner --enroll\n", stderr); return 64; }
  if (getuid() != 0 || geteuid() != 0) { fputs("The installed enrollment tool requires root.\n", stderr); return 77; }
  struct sigaction action = { .sa_handler = stop }; sigemptyset(&action.sa_mask);
  if (sigaction(SIGINT, &action, NULL) || sigaction(SIGTERM, &action, NULL)) return 74;
  alarm(360);
  general_root_enrollment_result result = general_root_enrollment_run();
  const char *message = result == GENERAL_ROOT_ENROLLMENT_COMPLETE ? "Protected enrollment metadata was durably recorded.\n" :
    result == GENERAL_ROOT_ENROLLMENT_BUSY ? "Protected enrollment is busy.\n" : result == GENERAL_ROOT_ENROLLMENT_UNCERTAIN ?
    "Protected enrollment requires inspection of the original records.\n" : "Protected enrollment is unavailable.\n";
  fputs(message, stderr); return result == GENERAL_ROOT_ENROLLMENT_COMPLETE ? 0 : result == GENERAL_ROOT_ENROLLMENT_BUSY ? 75 : result == GENERAL_ROOT_ENROLLMENT_UNCERTAIN ? 74 : 69;
}
